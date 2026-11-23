#!/usr/bin/env bash
# 生成可离线分发的源码发布包（保持生产 .env、密钥、用户数据与构建缓存在外）。
#
#   bash deploy/scripts/make-source-release.sh [version]
#
# 产物：deploy/release/dsh-platform-source-<version>.tar.gz 与 SHA256SUMS-<version>
# 生产镜像包由 build-image.sh 生成；本脚本只打包平台源码、部署文件与实施文档。
set -euo pipefail

VERSION="${1:-$(date -u +%Y%m%d%H%M%S)}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$REPO_ROOT/deploy/release"
mkdir -p "$OUT"

cd "$REPO_ROOT"
tar -czf "$OUT/dsh-platform-source-$VERSION.tar.gz" \
  --exclude='deploy/.env' \
  --exclude='deploy/release' \
  services/platform \
  deploy \
  docs/standalone-w3 \
  packages/client/ui-platform-identity \
  packages/client/ui-settings-general/src/client/SettingsRoot.tsx \
  packages/client/ui-settings-general/src/client/index.ts \
  packages/client/ui-settings-general/src/client/shell-contract.ts \
  packages/bundle/web-app/cordis.patch.yml \
  packages/bundle/web-app/package.json

( cd "$OUT" && sha256sum "dsh-platform-source-$VERSION.tar.gz" > "SHA256SUMS-$VERSION" && cat "SHA256SUMS-$VERSION" )
echo "源码发布包：$OUT/dsh-platform-source-$VERSION.tar.gz"
