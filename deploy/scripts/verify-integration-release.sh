#!/usr/bin/env bash
# Verify one offline fusion release bundle without Docker.
#
#   bash deploy/scripts/verify-integration-release.sh <bundle-dir> <version>
#
# Checks the checksum file, the presence of the image tar, the disabled-by-
# default env template, and that both registry examples are valid JSON.
set -euo pipefail

DIR="${1:?usage: verify-integration-release.sh <bundle-dir> <version>}"
VERSION="${2:?usage: verify-integration-release.sh <bundle-dir> <version>}"
[ -d "$DIR" ] || { echo "missing bundle directory: $DIR" >&2; exit 2; }

echo "== verify checksums =="
( cd "$DIR" && sha256sum -c "SHA256SUMS-$VERSION" )

echo "== verify required assets =="
for file in "dsh-integration-job-$VERSION.tar" fusion.env.example systems.http.example.json systems.mock.example.json README.txt; do
  [ -s "$DIR/$file" ] || { echo "missing or empty: $file" >&2; exit 1; }
done

echo "== verify disabled-by-default env =="
grep -qx 'DSH_INTEGRATION_ENABLED=false' "$DIR/fusion.env.example" || {
  echo "fusion.env.example must keep DSH_INTEGRATION_ENABLED=false" >&2
  exit 1
}

echo "== verify registry examples are JSON =="
node -e 'for (const file of process.argv.slice(1)) JSON.parse(require("node:fs").readFileSync(file, "utf8"))' \
  "$DIR/systems.http.example.json" "$DIR/systems.mock.example.json"

echo "verify-integration-release: PASS"
