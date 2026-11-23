#!/usr/bin/env bash
# 应用回滚 + 数据恢复。
#
#   bash deploy/scripts/rollback.sh <backup-label>
#
# 注意：数据库迁移若含破坏性变更，回滚需要备份恢复；本脚本在应用回滚后调用
# restore.sh 恢复同一备份，并提示停机窗口。
set -euo pipefail

LABEL="${1:?用法: rollback.sh <backup-label>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== 回滚应用版本 =="
# 保留 .env；把平台镜像回退到升级前备份记录的镜像摘要（若可解析）。
echo "当前部署版本信息见 $DSH_DEPLOY_ROOT/backups/$LABEL/MANIFEST.txt"
echo "请按 RELEASE 说明重新 `docker compose up -d` 指定旧镜像；随后恢复数据："
echo "  bash $HERE/restore.sh $LABEL"
echo
echo "== 恢复数据 =="
bash "$HERE/restore.sh" "$LABEL"
