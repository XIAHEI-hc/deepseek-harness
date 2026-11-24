#!/usr/bin/env bash
# Verify the physical boundary of one analysis container on a real Linux Docker host.
#
# This is a deployment gate, not a unit test: it creates a read-only container
# with exactly the mounts and flags the analysis runner uses, inspects the
# daemon's resolved configuration, then runs a probe that must be able to write
# only /work and /scratch. A failure means fusion analysis must stay disabled.
#
# Usage:
#   DSH_INTEGRATION_JOB_IMAGE=<image> bash deploy/scripts/verify-integration-isolation.sh
#
# The image must provide /bin/sh and node (the DSH runtime image does).

set -euo pipefail

IMAGE="${DSH_INTEGRATION_JOB_IMAGE:-}"
if [[ -z "$IMAGE" ]]; then
  echo "verify-integration-isolation: DSH_INTEGRATION_JOB_IMAGE is required" >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "verify-integration-isolation: docker is not available" >&2
  exit 2
fi

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dsh-fusion-verify.XXXXXX")"
NAME="dsh-fusion-verify-$$"
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$ROOT"
}
trap cleanup EXIT

mkdir -p "$ROOT/inputs" "$ROOT/output" "$ROOT/scratch"
printf '{"fixture":true}\n' > "$ROOT/inputs/data.json"

cat > "$ROOT/scratch/run.sh" <<'PROBE'
set -u
fail() { echo "VIOLATION: $*" >&2; exit 20; }

[ "$(id -u)" = "1000" ] || fail "analysis container did not run as uid 1000"
[ -r /inputs/data.json ] || fail "input snapshot is not readable"
echo ok > /work/report.txt || fail "workspace output is not writable"
echo ok > /scratch/state.txt || fail "job scratch is not writable"
if echo tamper > /inputs/data.json 2>/dev/null; then fail "input snapshot is writable"; fi
if echo tamper > /app/pwned 2>/dev/null; then fail "application code is writable"; fi
if echo tamper > /root/pwned 2>/dev/null; then fail "container root is writable"; fi
if [ -e /var/run/docker.sock ]; then fail "docker socket is mounted"; fi
if [ -d /srv/dsh ]; then fail "host deployment root is visible"; fi

node -e '
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  fetch("http://169.254.169.254/latest/meta-data/", { signal: controller.signal })
    .then(() => process.exit(1))
    .catch(() => process.exit(0))
    .finally(() => clearTimeout(timer));
' || fail "analysis container reached the metadata endpoint"

echo "analysis probe passed"
PROBE

docker create \
  --name "$NAME" \
  --network none \
  --read-only \
  --user 1000:1000 \
  --cpus 1 \
  --memory 256m \
  --pids-limit 64 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --ulimit nofile=256:256 \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  -v "$ROOT/inputs:/inputs:ro" \
  -v "$ROOT/output:/work:rw" \
  -v "$ROOT/scratch:/scratch:rw" \
  -w /work \
  -e HOME=/scratch \
  -e TMPDIR=/tmp \
  --entrypoint '' \
  "$IMAGE" /bin/sh /scratch/run.sh >/dev/null

readonly_flag="$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$NAME")"
network="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$NAME")"
cap_drop="$(docker inspect -f '{{join .HostConfig.CapDrop ","}}' "$NAME")"
security="$(docker inspect -f '{{join .HostConfig.SecurityOpt ","}}' "$NAME")"
user="$(docker inspect -f '{{.Config.User}}' "$NAME")"
mounts="$(docker inspect -f '{{range .Mounts}}{{.Type}}:{{.Source}}:{{.Destination}}:{{if .RW}}rw{{else}}ro{{end}} {{end}}' "$NAME")"

[[ "$readonly_flag" == "true" ]] || { echo "VIOLATION: rootfs is not read-only" >&2; exit 21; }
[[ "$network" == "none" ]] || { echo "VIOLATION: network is $network" >&2; exit 22; }
[[ ",$cap_drop," == *",ALL,"* ]] || { echo "VIOLATION: capabilities were not dropped" >&2; exit 23; }
[[ "$security" == *"no-new-privileges"* ]] || { echo "VIOLATION: no-new-privileges is missing" >&2; exit 24; }
[[ "$user" == "1000:1000" ]] || { echo "VIOLATION: user is $user" >&2; exit 25; }
[[ "$mounts" != *"docker.sock"* ]] || { echo "VIOLATION: docker socket mount" >&2; exit 26; }
[[ "$mounts" == *"$ROOT/inputs:/inputs:ro"* ]] || { echo "VIOLATION: inputs mount missing or writable" >&2; exit 27; }
[[ "$mounts" == *"$ROOT/output:/work:rw"* ]] || { echo "VIOLATION: workspace mount missing" >&2; exit 28; }
[[ "$mounts" == *"$ROOT/scratch:/scratch:rw"* ]] || { echo "VIOLATION: scratch mount missing" >&2; exit 29; }

set +e
docker start -a "$NAME"
status=$?
set -e
[[ "$status" == "0" ]] || { echo "VIOLATION: analysis probe exited $status" >&2; exit 30; }
[[ -f "$ROOT/output/report.txt" ]] || { echo "VIOLATION: expected output missing" >&2; exit 31; }
[[ -f "$ROOT/scratch/state.txt" ]] || { echo "VIOLATION: expected scratch state missing" >&2; exit 32; }

echo "verify-integration-isolation: PASS"
