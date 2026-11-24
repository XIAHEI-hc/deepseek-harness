#!/usr/bin/env bash
# 完整运行时镜像 + 容器模式端到端验证（在 WSL/Linux 内运行，真实 Docker）。
#
#   bash deploy/scripts/verify-container-runtime.sh
#
# 前置：已用 deploy/scripts/build-runtime-image.sh 构建 dsh-runtime:dev（或设置
# DSH_RUNTIME_IMAGE 指向已构建镜像）。覆盖：平台在容器 Runtime 后端上启动两个
# 真实 DSH 容器、原生 UI 经 Gateway 正常返回、Session 列表/IDOR 隔离、文件与
# 凭据跨容器不可读、无 Docker socket/宿主根/Gateway 私钥、注销撤销。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${DSH_RUNTIME_IMAGE:-dsh-runtime:dev}"
command -v docker >/dev/null || { echo "docker 不可用" >&2; exit 1; }
command -v node >/dev/null || { echo "node 不可用" >&2; exit 1; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  echo "缺少运行时镜像 $IMAGE；先运行 deploy/scripts/build-runtime-image.sh" >&2
  exit 1
}

export DSH_PROBE_REPO_ROOT="$REPO_ROOT"
export DSH_RUNTIME_IMAGE="$IMAGE"
exec node "$REPO_ROOT/services/platform/tests/e2e/container-dsh-probe.ts"
