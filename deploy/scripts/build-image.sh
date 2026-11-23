#!/usr/bin/env bash
# 构建并导出版本化运行时镜像（构建机可联网，部署机可离线）。
#
#   bash deploy/scripts/build-image.sh [version]
#
# 产物：
#   deploy/release/dsh-runtime-<version>.tar
#   deploy/release/dsh-platform-<version>.tar
#   deploy/release/SHA256SUMS
# 部署机用 upgrade.sh 校验并导入，不需要联网、不需要重新构建。
set -euo pipefail

VERSION="${1:-$(date -u +%Y%m%d%H%M%S)}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$REPO_ROOT/deploy/release"
mkdir -p "$OUT"

cd "$REPO_ROOT"
COMMIT="$(git rev-parse HEAD 2>/dev/null || echo 0000000000000000000000000000000000000000)"

echo "== 构建运行时镜像 dsh-runtime:$VERSION =="
docker build --build-arg "DSH_CLIENT_COMMIT_HASH=$COMMIT" -f deploy/runtime/Dockerfile -t "dsh-runtime:$VERSION" .
docker save "dsh-runtime:$VERSION" -o "$OUT/dsh-runtime-$VERSION.tar"

echo "== 构建平台镜像 dsh-platform:$VERSION =="
docker build --build-arg "DSH_CLIENT_COMMIT_HASH=$COMMIT" -f deploy/platform/Dockerfile -t "dsh-platform:$VERSION" .
docker save "dsh-platform:$VERSION" -o "$OUT/dsh-platform-$VERSION.tar"

( cd "$OUT" && sha256sum "dsh-runtime-$VERSION.tar" "dsh-platform-$VERSION.tar" > "SHA256SUMS-$VERSION" )
cp "$REPO_ROOT/deploy/compose.yml" "$OUT/compose-$VERSION.yml"
cp "$REPO_ROOT/deploy/.env.example" "$OUT/env.example-$VERSION"
cp "$REPO_ROOT/deploy/runtime/platform-runtime.patch.yml" "$OUT/platform-runtime-$VERSION.patch.yml"

echo "完成：$OUT（版本 $VERSION）"
