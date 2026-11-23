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

echo "== 停止 platform 与用户 Runtime 容器 =="
docker compose -f "$COMPOSE" stop platform || true
RUNTIME_IDS="$(docker ps -q --filter label=dsh.platform=1 || true)"
if [ -n "$RUNTIME_IDS" ]; then
  # shellcheck disable=SC2086 -- ids are newline-separated Docker ids.
  docker stop $RUNTIME_IDS >/dev/null 2>&1 || true
fi

echo "== 恢复管理数据与密钥 =="
rm -rf "$ROOT/management.restore"
mkdir -p "$ROOT/management.restore"
tar -C "$ROOT/management.restore" -xzf "$SRC/management.tar.gz"
rm -rf "$ROOT/management"
mv "$ROOT/management.restore/management" "$ROOT/management"

echo "== 恢复用户空间 =="
mkdir -p "$ROOT/spaces"
if [ -d "$SRC/spaces" ]; then
  for archive in "$SRC"/spaces/*.tar.gz; do
    [ -f "$archive" ] || continue
    tar -C "$ROOT/spaces" -xzf "$archive"
  done
fi

# 恢复后的运行时注册表指向备份时的容器实例，而容器 id 在恢复窗口内可能已变化。
# 把记录归零为 STOPPED/RUNNING，让平台在用户下次请求时启动新的 generation；
# 用户空间数据已从备份恢复，新容器直接使用它。
if [ -f "$ROOT/management/runtime/runtime.sqlite" ]; then
  echo "== 重置运行时注册表（恢复后重新分配 generation）=="
  node -e "
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(process.argv[1])
db.exec(\"UPDATE dsh_runtime_instances SET state = 'STOPPED', desired_state = 'RUNNING', runtime_id = NULL, last_error_code = NULL\")
db.close()
" "$ROOT/management/runtime/runtime.sqlite"
fi

echo "== 恢复 PostgreSQL 身份库 =="
if [ -f "$SRC/postgres-identity.sql.gz" ]; then
  if [ -f "$ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1091 -- deployment-owned environment file.
    . "$ROOT/.env"
    set +a
  fi
  command -v psql >/dev/null || { echo "psql 未安装：PostgreSQL 身份库恢复需要 postgresql-client" >&2; exit 1; }
  [ -n "${DSH_POSTGRES_URL:-}" ] || { echo "DSH_POSTGRES_URL 为空，无法恢复 PostgreSQL 身份库" >&2; exit 1; }
  ( cd "$SRC" && sha256sum -c postgres-identity.sql.gz.sha256 )
  # Newer pg_dump clients emit SET lines (for example transaction_timeout) that an
  # older server rejects; strip only those client-version settings before replay.
  gunzip -c "$SRC/postgres-identity.sql.gz" | sed -E '/^SET (transaction_timeout|idle_in_transaction_session_timeout)/d' | psql -v ON_ERROR_STOP=1 "$DSH_POSTGRES_URL" >/dev/null
fi

echo "== 启动 platform =="
docker compose -f "$COMPOSE" start platform
ok=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${DSH_GATEWAY_LISTEN_PORT:-8080}/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 2
done
if [ "$ok" -ne 1 ]; then
  echo "恢复后健康检查失败，请检查日志" >&2
  exit 1
fi
echo "恢复完成：$LABEL"
