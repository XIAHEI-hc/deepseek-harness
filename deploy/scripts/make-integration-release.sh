#!/usr/bin/env bash
# Build an offline fusion release bundle from an already-built analysis image.
#
#   DSH_INTEGRATION_JOB_IMAGE=<image> bash deploy/scripts/make-integration-release.sh <version> [output-dir]
#
# The bundle contains only the image tar, the example connector registry, the
# job Dockerfile, the operator README, and a disabled-by-default env template.
# It never copies a deployment `.env`, database, snapshot, workspace, or user
# data. Import the image on the target host with `docker load` and pin
# DSH_INTEGRATION_JOB_IMAGE to the imported tag.
set -euo pipefail

VERSION="${1:?usage: make-integration-release.sh <version> [output-dir]}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${2:-$REPO_ROOT/deploy/release/integration-$VERSION}"
IMAGE="${DSH_INTEGRATION_JOB_IMAGE:?DSH_INTEGRATION_JOB_IMAGE is required}"
mkdir -p "$OUT"

echo "== save analysis image $IMAGE =="
docker save "$IMAGE" -o "$OUT/dsh-integration-job-$VERSION.tar"

echo "== copy operator assets =="
cp "$REPO_ROOT/deploy/integration/README.md" "$OUT/fusion-README.md"
cp "$REPO_ROOT/deploy/integration/job/Dockerfile" "$OUT/job.Dockerfile"
cp "$REPO_ROOT/deploy/integration/systems.http.example.json" "$OUT/systems.http.example.json"
cp "$REPO_ROOT/deploy/integration/systems.mock.example.json" "$OUT/systems.mock.example.json"
mkdir -p "$OUT/broker"
cp "$REPO_ROOT/deploy/integration/broker/proxy.mjs" "$OUT/broker/proxy.mjs"
cp "$REPO_ROOT/deploy/integration/broker/Dockerfile" "$OUT/broker/Dockerfile"
cp "$REPO_ROOT/deploy/integration/broker/README.md" "$OUT/broker/README.md"

cat > "$OUT/fusion.env.example" <<EOF
# Fusion release $VERSION. Keep disabled until preflight passes on the target host.
DSH_INTEGRATION_ENABLED=false
DSH_INTEGRATION_SYSTEMS_FILE=/srv/dsh/management/integration/systems.json
DSH_INTEGRATION_DATA_DIR=/srv/dsh/management/integration
DSH_INTEGRATION_JOB_RUNNER_KIND=container
DSH_INTEGRATION_JOB_IMAGE=dsh-integration-job:$VERSION
DSH_INTEGRATION_JOB_NETWORK=none
DSH_INTEGRATION_RUNTIME_API_URL=http://platform:8080
EOF

cat > "$OUT/README.txt" <<EOF
Fusion release $VERSION

1. docker load -i dsh-integration-job-$VERSION.tar
2. Copy systems.http.example.json to the path in DSH_INTEGRATION_SYSTEMS_FILE
   and replace example hosts/users.
3. Merge fusion.env.example into the deployment .env, keeping
   DSH_INTEGRATION_ENABLED=false until \`admin integration status\` reports ready.
4. Run: DSH_INTEGRATION_JOB_IMAGE=dsh-integration-job:$VERSION \\
     bash deploy/scripts/verify-integration-isolation.sh
5. If controlled egress is used, build broker/Dockerfile and set
   DSH_INTEGRATION_JOB_NETWORK/DSH_INTEGRATION_EGRESS_BROKER_URL as reviewed.
EOF

( cd "$OUT" && sha256sum dsh-integration-job-"$VERSION".tar fusion-README.md job.Dockerfile systems.http.example.json systems.mock.example.json broker/proxy.mjs broker/Dockerfile broker/README.md fusion.env.example README.txt > SHA256SUMS-"$VERSION" )

echo "release bundle: $OUT"
echo "verify: bash deploy/scripts/verify-integration-release.sh $OUT $VERSION"
