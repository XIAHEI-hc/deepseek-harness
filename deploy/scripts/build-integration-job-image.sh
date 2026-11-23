#!/usr/bin/env bash
# Build the fixed analysis image used by the fusion Job Runner.
#
#   bash deploy/scripts/build-integration-job-image.sh [tag]
#
# The tag defaults to dsh-integration-job:<YYYY.MM.DD>-local. The image is built
# from deploy/integration/job/Dockerfile, which provides /bin/sh, python3, and a
# non-root uid; the runner clears its entrypoint and supplies the command.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
TAG="${1:-dsh-integration-job:$(date -u +%Y.%m.%d)-local}"

docker build \
  --file "$REPO_ROOT/deploy/integration/job/Dockerfile" \
  --tag "$TAG" \
  "$REPO_ROOT/deploy/integration/job"

DIGEST="$(docker image inspect --format '{{index .RepoDigests 0}}' "$TAG" 2>/dev/null || true)"
echo "built $TAG"
echo "pinned reference: ${DIGEST:-$TAG (local image has no repository digest; pin by image id in air-gapped releases)}"
echo "verify: DSH_INTEGRATION_JOB_IMAGE=$TAG bash deploy/scripts/verify-integration-isolation.sh"
