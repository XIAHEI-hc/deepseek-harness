#!/usr/bin/env bash
# 从 backup.sh 的备份恢复（Linux 部署机）。会先校验 SHA256，再停止 platform 并覆盖数据。
#
#   bash deploy/scripts/restore.sh <backup-label>
set -euo pipefail

LABEL="${1:?用法: restore.sh <backup-label>}"
ROOT="${DSH_DEPLOY_ROOT:-/srv/dsh}"
COMPOSE="${DSH_COMPOSE_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/compose.yml}"
SRC="$ROOT/backups/$LABEL"
[ -d "$SRC" ] || { echo "备份不存在：$SRC" >&2; exit 1; }

echo "== 校验备份 =="
( cd "$SRC" && sha256sum -c management.tar.gz.sha256 )
if [ -f "$SRC/spaces/SHA256SUMS" ]; then ( cd "$SRC/spaces" && sha256sum -c SHA256SUMS ); fi

echo "== 停止 platform =="
docker compose -f "$COMPOSE" stop platform || true

echo "== 恢复管理数据与密钥 =="
rm -rf "$ROOT/management.restore"
mkdir -p "$ROOT/management.restore"
tar -C "$ROOT/management.restore" -xzf "$SRC/management.tar.gz"
rm -rf "$ROOT/management"
mv "$ROOT/management.restore/management" "$ROOT/management"

echo "== 恢复用户空间 =="
if [ -d "$SRC/spaces" ]; then
  for archive in "$SRC"/spaces/*.tar.gz; do
    [ -f "$archive" ] || continue
    tar -C "$ROOT/spaces" -xzf "$archive"
  done
fi

echo "== 启动 platform =="
docker compose -f "$COMPOSE" start platform
sleep 5
if ! curl -fsS "http://127.0.0.1:${DSH_GATEWAY_LISTEN_PORT:-8080}/health" >/dev/null; then
  echo "恢复后健康检查失败，请检查日志" >&2
  exit 1
fi
echo "恢复完成：$LABEL"
