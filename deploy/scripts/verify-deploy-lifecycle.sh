#!/usr/bin/env bash
# 部署生命周期演练（在 WSL/Linux 内运行，使用真实 Docker + 平台镜像）。
#
#   wsl -d Ubuntu --exec bash deploy/scripts/verify-deploy-lifecycle.sh
#
# 覆盖 OPS-04（版本化迁移 + 备份/恢复演练）、OPS-06（离线镜像导入升级、保留数据）、
# OPS-07（升级失败自动回滚并恢复数据一致性）。使用临时部署根与合成的发布包，
# 不触碰任何真实部署的 .env、密钥或用户卷。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="$REPO_ROOT/.dsh-deploy-smoke"
COMPOSE="$ROOT/compose.yml"
PORT=18080
BASE="http://127.0.0.1:$PORT"
PASSES=0

pass() { PASSES=$((PASSES + 1)); echo "PASS $PASSES: $*"; }
fail() {
  echo "FAIL: $*" >&2
  docker compose -f "$COMPOSE" logs --tail 40 platform >&2 2>/dev/null || true
  exit 1
}
wait_health() {
  for _ in $(seq 1 90); do
    if curl -fsS "$BASE/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
# 302 login + 200 authenticated /auth/me for one cookie jar.
login_user() {
  local jar="$1"
  [ "$(curl -s -c "$jar" -o /dev/null -w '%{http_code}' "$BASE/auth/login?return_to=%2F")" = "302" ]
}
me_status() {
  curl -s -b "$1" -o /dev/null -w '%{http_code}' "$BASE/auth/me"
}
me_contains() {
  curl -s -b "$1" "$BASE/auth/me" | grep -q "$2"
}

command -v docker >/dev/null || { echo "docker 不可用" >&2; exit 1; }
docker image inspect dsh-platform:test >/dev/null 2>&1 || { echo "缺少 dsh-platform:test（先构建平台镜像）" >&2; exit 1; }

# Remove a previous failed attempt's container and network before recreating the
# deployment root: its bind mount points at the path this script is about to wipe.
docker rm -f dsh-deploy-smoke-platform-1 >/dev/null 2>&1 || true
docker network rm dsh-deploy-smoke_default >/dev/null 2>&1 || true

rm -rf "$ROOT"
mkdir -p "$ROOT"/{management,spaces,backups,releases}
cat > "$COMPOSE" <<EOF
name: dsh-deploy-smoke
services:
  platform:
    image: dsh-platform:\${DSH_PLATFORM_VERSION:-test}
    restart: "no"
    environment:
      APP_ENV: development
      AUTH_MODE: mock
      AUTH_COOKIE_SECURE: "false"
      DSH_PLATFORM_DATA_DIR: /srv/dsh/management
      DSH_RUNTIME_KIND: process
      DSH_RUNTIME_ROOT: /srv/dsh/spaces
      DSH_PLATFORM_SPACE_KEY_SECRET: smoke-space-key-0123456789abcdef
      DSH_INTERNAL_API_KEY: smoke-internal-key-0123456789abcdef
      DSH_GATEWAY_PUBLIC_URL: http://127.0.0.1:$PORT
      DSH_GATEWAY_LISTEN_HOST: 0.0.0.0
      DSH_GATEWAY_LISTEN_PORT: "8080"
    ports:
      - "$PORT:8080"
    volumes:
      - "$ROOT:/srv/dsh"
EOF

export DSH_DEPLOY_ROOT="$ROOT"
export DSH_COMPOSE_FILE="$COMPOSE"
export DSH_GATEWAY_LISTEN_PORT="$PORT"
export DSH_PLATFORM_VERSION=test
RUNTIME_TAG_BEFORE=""
trap 'docker compose -f "$COMPOSE" down --remove-orphans >/dev/null 2>&1 || true' EXIT

docker compose -f "$COMPOSE" up -d
wait_health || fail "platform 容器未在超时内就绪"
pass "平台容器从 dsh-platform:test 启动并通过 /health（版本化迁移已在启动时应用）"

JAR_ALICE="$ROOT/alice.jar"
login_user "$JAR_ALICE" || fail "alice Mock 登录失败"
[ "$(me_status "$JAR_ALICE")" = "200" ] || fail "alice /auth/me 失败"
me_contains "$JAR_ALICE" "local-001" || fail "alice 身份内容不正确"
pass "alice 登录成功且身份可读（备份前状态）"

bash "$REPO_ROOT/deploy/scripts/backup.sh" smoke-before >/dev/null
[ -f "$ROOT/backups/smoke-before/management.tar.gz" ] || fail "备份缺少 management 归档"
[ -f "$ROOT/backups/smoke-before/MANIFEST.txt" ] || fail "备份缺少 manifest"
wait_health || fail "备份脚本重启后平台未就绪"
pass "backup.sh 生成 management 归档、用户空间归档与 MANIFEST，并恢复在线"

JAR_BOB="$ROOT/bob.jar"
login_user "$JAR_BOB" || fail "bob Mock 登录失败"
[ "$(me_status "$JAR_BOB")" = "200" ] || fail "bob /auth/me 失败"
pass "bob 在备份之后登录（用于验证恢复会撤销其 Session）"

bash "$REPO_ROOT/deploy/scripts/restore.sh" smoke-before >/dev/null || fail "restore.sh 失败"
wait_health || fail "恢复后平台未就绪"
[ "$(me_status "$JAR_ALICE")" = "200" ] || fail "恢复后 alice 会话失效"
[ "$(me_status "$JAR_BOB")" = "401" ] || fail "恢复后 bob（备份后创建）的会话仍然有效"
pass "restore.sh 恢复数据库：备份内会话保持有效，备份后的新会话被撤销"

# ── 离线升级：构造 v2 发布包（平台镜像 + 占位运行时镜像）并真实执行 upgrade.sh ──
RELEASE="$ROOT/release2"
mkdir -p "$RELEASE"
docker tag dsh-platform:test dsh-platform:v2
docker save dsh-platform:v2 -o "$RELEASE/dsh-platform-v2.tar"
docker save alpine:latest -o "$RELEASE/dsh-runtime-v2.tar"
( cd "$RELEASE" && sha256sum ./*.tar > SHA256SUMS-v2 )
docker rmi dsh-platform:v2 >/dev/null 2>&1 || true
pass "生成离线发布包（SHA256SUMS-v2）并移除本地 v2 镜像，证明升级从 tar 导入"

DSH_RELEASE_DIR="$RELEASE" DSH_PLATFORM_VERSION_BEFORE=test bash "$REPO_ROOT/deploy/scripts/upgrade.sh" v2 >/dev/null \
  || fail "upgrade.sh v2 失败"
wait_health || fail "升级后平台未就绪"
[ "$(me_status "$JAR_ALICE")" = "200" ] || fail "升级后 alice 会话丢失"
me_contains "$JAR_ALICE" "local-001" || fail "升级后身份数据不一致"
RUNNING_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$(docker compose -f "$COMPOSE" ps -q platform)")"
[ "$RUNNING_IMAGE" = "dsh-platform:v2" ] || fail "升级后运行镜像不是 v2（实际 $RUNNING_IMAGE）"
pass "upgrade.sh 离线导入 v2 并启动，数据库与既有会话保持不变"

# ── 失败升级自动回滚：v3 包只含 v2 镜像，编排请求 v3 必然失败 ──
RELEASE3="$ROOT/release3"
mkdir -p "$RELEASE3"
cp "$RELEASE/dsh-platform-v2.tar" "$RELEASE3/dsh-platform-v3.tar"
cp "$RELEASE/dsh-runtime-v2.tar" "$RELEASE3/dsh-runtime-v3.tar"
( cd "$RELEASE3" && sha256sum ./*.tar > SHA256SUMS-v3 )
if DSH_RELEASE_DIR="$RELEASE3" bash "$REPO_ROOT/deploy/scripts/upgrade.sh" v3 >/dev/null 2>&1; then
  fail "v3 升级本应失败但返回成功"
fi
wait_health || fail "回滚后平台未恢复健康"
[ "$(me_status "$JAR_ALICE")" = "200" ] || fail "回滚后 alice 会话丢失"
RUNNING_AFTER_ROLLBACK="$(docker inspect --format '{{.Config.Image}}' "$(docker compose -f "$COMPOSE" ps -q platform)")"
[ "$RUNNING_AFTER_ROLLBACK" = "dsh-platform:v2" ] || fail "回滚后镜像不是上一版本（实际 $RUNNING_AFTER_ROLLBACK）"
pass "失败升级触发 rollback.sh，平台恢复到上一版本且数据一致"

docker compose -f "$COMPOSE" down --remove-orphans >/dev/null 2>&1 || true
pass "演练环境已清理"
echo "DEPLOY LIFECYCLE PASS: $PASSES assertions"