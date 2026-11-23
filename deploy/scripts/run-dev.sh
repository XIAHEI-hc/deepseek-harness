#!/usr/bin/env bash
# 本地开发启动：Mock 身份 + 进程级 Runtime（不依赖容器/W3）。
#
#   bash deploy/scripts/run-dev.sh
#
# 浏览器打开 http://127.0.0.1:8080 ；数据位于仓库根 .dsh-platform/。
# 两个 Mock 用户的 A/B 隔离测试请看 services/platform/tests/e2e。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

export APP_ENV=development
export AUTH_MODE=mock
export DSH_PLATFORM_DATA_DIR="${DSH_PLATFORM_DATA_DIR:-$REPO_ROOT/.dsh-platform}"
export DSH_PLATFORM_REPO_ROOT="$REPO_ROOT"
export DSH_PLATFORM_REALM="${DSH_PLATFORM_REALM:-dsh}"
export AUTH_COOKIE_SECURE=false
export DSH_GATEWAY_PUBLIC_URL="${DSH_GATEWAY_PUBLIC_URL:-http://127.0.0.1:8080}"
export DSH_GATEWAY_LISTEN_HOST="${DSH_GATEWAY_LISTEN_HOST:-127.0.0.1}"
export DSH_GATEWAY_LISTEN_PORT="${DSH_GATEWAY_LISTEN_PORT:-8080}"
export DSH_RUNTIME_KIND=process
export DSH_RUNTIME_ROOT="${DSH_RUNTIME_ROOT:-$DSH_PLATFORM_DATA_DIR/spaces}"
export DSH_RUNTIME_PATCH_FILE="${DSH_RUNTIME_PATCH_FILE:-$REPO_ROOT/deploy/runtime/platform-runtime.patch.yml}"
export DSH_RUNTIME_IDLE_SECONDS="${DSH_RUNTIME_IDLE_SECONDS:-1800}"
export DSH_PLATFORM_SPACE_KEY_SECRET="${DSH_PLATFORM_SPACE_KEY_SECRET:-development-space-key-0123456789abcdef0123456789abcdef}"
export DSH_INTERNAL_API_KEY="${DSH_INTERNAL_API_KEY:-development-internal-key-0123456789abcdef}"

exec node --import tsx/esm services/platform/src/main.ts "$@"
