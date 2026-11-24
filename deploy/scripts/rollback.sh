#!/usr/bin/env bash
# 应用回滚 + 数据恢复。
#
#   bash deploy/scripts/rollback.sh <backup-label>
#
# 应用回滚：调用方（upgrade.sh 或运维）应把 DSH_PLATFORM_VERSION 设回上一个平台镜像
# tag，再运行本脚本；本脚本随后用 restore.sh 恢复同一备份并做健康检查。
# 数据库迁移若含破坏性变更，回滚必须依赖该备份恢复（存在停机窗口）。
set -euo pipefail

LABEL="${1:?用法: rollback.sh <backup-label>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${DSH_DEPLOY_ROOT:-/srv/dsh}"

echo "== 回滚应用版本 =="
echo "平台镜像：${DSH_PLATFORM_VERSION:-未指定（沿用 .env/编排默认值）}"
echo "部署事实：$ROOT/backups/$LABEL/MANIFEST.txt"
if [ -f "$ROOT/backups/$LABEL/MANIFEST.txt" ]; then sed -n '1,8p' "$ROOT/backups/$LABEL/MANIFEST.txt"; fi

echo "== 恢复数据并重启平台 =="
DSH_COMPOSE_FILE="${DSH_COMPOSE_FILE:-$HERE/../compose.yml}" bash "$HERE/restore.sh" "$LABEL"
echo "回滚完成：$LABEL（请用 A/B 账号复验登录、历史连续性、隔离与注销）"
