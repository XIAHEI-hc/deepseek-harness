#!/usr/bin/env bash
# 真实容器隔离验证（在 WSL/Linux 内运行，使用真实 Docker 守护进程）。
#
#   bash deploy/scripts/verify-container-isolation.sh
#
# 覆盖 RUNT-01/03/05/06/08/09/11/12、DATA-05（挂载/进程级）与 OPS-03：
# 一身份一容器、不同身份不同私网 IP 与独立空间挂载、不发布端口、固定非 root UID、
# 资源限额、无 docker.sock/无 Gateway 私钥/无宿主根/无他人空间、同身份复用、
# Supervisor 重启复用运行中容器、停止后 FAILED 与 retry 新 generation、数据保留。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v docker >/dev/null || { echo "docker 不可用" >&2; exit 1; }
command -v node >/dev/null || { echo "node 不可用" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "docker 守护进程不可达" >&2; exit 1; }

export DSH_PROBE_REPO_ROOT="$REPO_ROOT"
exec node "$REPO_ROOT/services/platform/tests/e2e/container-probe.ts"
