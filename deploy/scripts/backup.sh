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

# 用户 Runtime 容器由宿主 docker 持有，停止 platform 不会停止它们；快照前必须
# 一起停止，否则空间目录会与运行中的 DSH 写入竞争。备份结束后按原 id 启动，
# platform 重新上线时会 adopt 这些运行中的容器。
RUNTIME_IDS="$(docker ps -q --filter label=dsh.platform=1 || true)"
stop_runtimes() {
  if [ -n "$RUNTIME_IDS" ]; then
    # shellcheck disable=SC2086 -- ids are newline-separated Docker ids.
    docker stop $RUNTIME_IDS >/dev/null 2>&1 || true
  fi
}
start_after_backup() {
  if [ -n "$RUNTIME_IDS" ]; then
    # shellcheck disable=SC2086 -- ids are newline-separated Docker ids.
    docker start $RUNTIME_IDS >/dev/null 2>&1 || true
    # The platform reconciles READY records by inspecting container liveness; wait
    # until every restarted runtime is running before it comes back and inspects.
    for _ in $(seq 1 30); do
      pending=0
      for id in $RUNTIME_IDS; do
        running="$(docker inspect --format '{{.State.Running}}' "$id" 2>/dev/null || echo false)"
        [ "$running" = "true" ] || pending=1
      done
      [ "$pending" -eq 0 ] && break
      sleep 1
    done
  fi
  docker compose -f "$COMPOSE" start platform >/dev/null 2>&1 || true
}
stop_runtimes
trap start_after_backup EXIT

echo "== 备份管理数据与密钥 =="
tar -C "$ROOT" -czf "$DEST/management.tar.gz" management
( cd "$DEST" && sha256sum management.tar.gz > management.tar.gz.sha256 )

# PostgreSQL 身份库不在 management/ 目录内，必须在同一维护窗口内单独导出。
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091 -- deployment-owned environment file.
  . "$ROOT/.env"
  set +a
fi
if [ "${DSH_PLATFORM_STORAGE:-sqlite}" = "postgres" ]; then
  command -v pg_dump >/dev/null || { echo "pg_dump 未安装：PostgreSQL 身份库备份需要 postgresql-client" >&2; exit 1; }
  [ -n "${DSH_POSTGRES_URL:-}" ] || { echo "DSH_POSTGRES_URL 为空，无法备份 PostgreSQL 身份库" >&2; exit 1; }
  echo "== 备份 PostgreSQL 身份库 =="
  pg_dump --clean --if-exists --no-owner --no-privileges "$DSH_POSTGRES_URL" | gzip > "$DEST/postgres-identity.sql.gz"
  ( cd "$DEST" && sha256sum postgres-identity.sql.gz > postgres-identity.sql.gz.sha256 )
fi

echo "== 备份用户空间 =="
mkdir -p "$DEST/spaces"
if [ -d "$ROOT/spaces" ]; then
  shopt -s nullglob
  archives=("$ROOT"/spaces/*/. )
  spaces=("$ROOT"/spaces/*/)
  if [ "${#spaces[@]}" -gt 0 ]; then
    for space in "${spaces[@]}"; do
      [ -d "$space" ] || continue
      key="$(basename "$space")"
      tar -C "$ROOT/spaces" -czf "$DEST/spaces/$key.tar.gz" "$key"
    done
    ( cd "$DEST/spaces" && sha256sum -- *.tar.gz > SHA256SUMS )
  fi
  shopt -u nullglob
  unset archives
fi

echo "== 记录部署事实 =="
{
  echo "label=$LABEL"
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "platform_image=$(docker compose -f "$COMPOSE" images -q platform 2>/dev/null || true)"
  echo "runtime_image=$( (grep -E '^DSH_RUNTIME_IMAGE=' "$ROOT/.env" 2>/dev/null || grep -E '^DSH_RUNTIME_IMAGE=' "$ROOT/current/deploy/.env" 2>/dev/null || true) | head -1 | cut -d= -f2-)"
  echo "runtime_containers=$(printf '%s' "$RUNTIME_IDS" | tr '\n' ' ')"
  echo "storage=${DSH_PLATFORM_STORAGE:-sqlite}"
  echo "spaces=$(find "$ROOT/spaces" -mindepth 1 -maxdepth 1 -type d | wc -l)"
} > "$DEST/MANIFEST.txt"

echo "备份完成：$DEST"
