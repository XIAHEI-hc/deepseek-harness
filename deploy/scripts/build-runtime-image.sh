#!/usr/bin/env bash
# 构建单个运行时镜像（本地验证/CI 用；正式发布用 build-image.sh 导出 tar）。
#
#   bash deploy/scripts/build-runtime-image.sh [tag]
#
# 构建上下文排除 .git，因此显式传入源码 commit 供客户端构建环境使用。
set -euo pipefail

TAG="${1:-dev}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo 0000000000000000000000000000000000000000)"
exec docker build \
  --build-arg "DSH_CLIENT_COMMIT_HASH=$COMMIT" \
  -f "$REPO_ROOT/deploy/runtime/Dockerfile" \
  -t "dsh-runtime:$TAG" \
  "$REPO_ROOT"
