#!/usr/bin/env bash
# Verify the fusion egress proxy on a real Docker network.
#
#   DSH_INTEGRATION_EGRESS_TEST_IMAGE=<node-image> \
#     bash deploy/scripts/verify-integration-egress.sh
#
# The image must provide `node`. The script creates a target container on a
# normal bridge, a broker on an internal network plus that bridge, and a client
# on the internal network. It proves the client reaches the allowlisted target
# only through the broker, that another port is refused, and that the client has
# no direct route to the target.
set -euo pipefail

IMAGE="${DSH_INTEGRATION_EGRESS_TEST_IMAGE:-}"
if [[ -z "$IMAGE" ]]; then
  echo "verify-integration-egress: DSH_INTEGRATION_EGRESS_TEST_IMAGE is required" >&2
  exit 2
fi
command -v docker >/dev/null || { echo "verify-integration-egress: docker is required" >&2; exit 2; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY="$HERE/../integration/broker/proxy.mjs"
[ -f "$PROXY" ] || { echo "missing broker proxy: $PROXY" >&2; exit 2; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/dsh-fusion-egress.XXXXXX")"
NET="dsh-fusion-egress-verify-$$"
OUT="dsh-fusion-egress-out-verify-$$"
TARGET="dsh-fusion-target-$$"
BROKER="dsh-fusion-broker-$$"
cleanup() {
  docker rm -f "$BROKER" "$TARGET" >/dev/null 2>&1 || true
  docker network rm "$NET" "$OUT" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

cat > "$TMP/target.mjs" <<'JS'
import http from 'node:http'
http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end(`target:${request.url}`)
}).listen(8080, '0.0.0.0')
JS

cat > "$TMP/client.mjs" <<'JS'
import http from 'node:http'

const request = (path) => new Promise((resolve, reject) => {
  const req = http.request({ host: 'broker', port: 3128, path, method: 'GET' }, (response) => {
    let body = ''
    response.setEncoding('utf8')
    response.on('data', chunk => { body += chunk })
    response.on('end', () => resolve({ status: response.statusCode, body }))
  })
  req.on('error', reject)
  req.end()
})

const health = await request('/healthz')
if (health.status !== 200) throw new Error(`broker health failed: ${health.status}`)
const allowed = await request('http://target:8080/hello')
if (allowed.status !== 200 || allowed.body !== 'target:/hello') {
  throw new Error(`allowlisted target failed: ${allowed.status} ${allowed.body}`)
}
const denied = await request('http://target:9999/nope')
if (denied.status !== 403) throw new Error(`non-allowlisted port was not refused: ${denied.status}`)
await new Promise((resolve, reject) => {
  const req = http.get('http://target:8080/hello', () => reject(new Error('direct target route exists')))
  req.on('error', () => resolve())
})
process.stdout.write('egress proxy probe passed\n')
JS

docker network create --internal "$NET" >/dev/null
docker network create "$OUT" >/dev/null
docker run -d --name "$TARGET" --network "$OUT" --network-alias target -v "$TMP/target.mjs:/run/target.mjs:ro" "$IMAGE" node /run/target.mjs >/dev/null
docker run -d --name "$BROKER" \
  --network "$NET" --network-alias broker --network "$OUT" \
  --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$PROXY:/run/proxy.mjs:ro" \
  -e PORT=3128 -e DSH_FUSION_EGRESS_ALLOWLIST=target:8080 \
  "$IMAGE" node /run/proxy.mjs >/dev/null

for _ in $(seq 1 30); do
  if docker run --rm --network "$NET" -v "$TMP/client.mjs:/run/client.mjs:ro" "$IMAGE" node /run/client.mjs >"$TMP/client.log" 2>&1; then
    echo "verify-integration-egress: PASS"
    exit 0
  fi
  sleep 1
done
echo "verify-integration-egress: FAILED" >&2
cat "$TMP/client.log" >&2 || true
docker logs "$BROKER" >&2 || true
exit 1
