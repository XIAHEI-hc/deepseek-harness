#!/usr/bin/env bash
# 备份平台数据库、Gateway 密钥、部署配置与全部用户空间（Linux 部署机）。
#
#   bash deploy/scripts/backup.sh [label]
#
# 数据库一致性：短暂停止 platform 容器，复制 SQLite 主文件与 WAL，再启动。
# 用户空间按 space_key 目录打包，每个用户一个 tar，不读取文件内容。
set -euo pipefail

LABEL="${1:-$(date -u +%Y%m%d%H%M%S)}"
ROOT="${DSH_DEPLOY_ROOT:-/srv/dsh}"
COMPOSE="${DSH_COMPOSE_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/compose.yml}"
DEST="$ROOT/backups/$LABEL"
mkdir -p "$DEST"

echo "== 停止 platform（短暂维护窗口）=="
docker compose -f "$COMPOSE" stop platform || true
trap 'docker compose -f "$COMPOSE" start platform >/dev/null 2>&1 || true' EXIT

echo "== 备份管理数据与密钥 =="
tar -C "$ROOT" -czf "$DEST/management.tar.gz" management
( cd "$DEST" && sha256sum management.tar.gz > management.tar.gz.sha256 )

echo "== 备份用户空间 =="
mkdir -p "$DEST/spaces"
if [ -d "$ROOT/spaces" ]; then
  for space in "$ROOT"/spaces/*/; do
    [ -d "$space" ] || continue
    key="$(basename "$space")"
    tar -C "$ROOT/spaces" -czf "$DEST/spaces/$key.tar.gz" "$key"
  done
  ( cd "$DEST/spaces" && sha256sum ./*.tar.gz > SHA256SUMS )
fi

echo "== 记录部署事实 =="
{
  echo "label=$LABEL"
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "platform_image=$(docker compose -f "$COMPOSE" images -q platform 2>/dev/null || true)"
  echo "runtime_image=$(grep -E '^DSH_RUNTIME_IMAGE=' "$ROOT/current/deploy/.env" 2>/dev/null || true)"
  echo "spaces=$(find "$ROOT/spaces" -mindepth 1 -maxdepth 1 -type d | wc -l)"
} > "$DEST/MANIFEST.txt"

echo "备份完成：$DEST"
