#!/usr/bin/env bash
# 平台健康检查（部署机 cron / 监控使用）。
set -euo pipefail
PORT="${DSH_GATEWAY_LISTEN_PORT:-8080}"
BASE="http://127.0.0.1:$PORT"

echo "== /health =="
curl -fsS "$BASE/health"
echo
echo "== 平台容器 =="
docker compose -f "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/compose.yml" ps
echo "== 用户 Runtime 容器（只读统计）=="
docker ps --filter "label=dsh.platform=1" --format '{{.Names}}\t{{.Status}}' || true
