#!/usr/bin/env bash
# 用真实发布包演练离线升级（在 WSL/Linux 内运行）。
#
#   bash deploy/scripts/verify-release-upgrade.sh <release-version>
#
# 前置：已用 build-image.sh 在 deploy/release 生成 dsh-platform-<v>.tar、
# dsh-runtime-<v>.tar 与 SHA256SUMS-<v>。脚本起一个临时部署（平台镜像），
# 登录一个 Mock 会话，调用真正的 upgrade.sh 导入发布包并切换版本，验证
# 健康检查、既有会话与数据连续性，然后清理。
set -euo pipefail

VERSION="${1:?用法: verify-release-upgrade.sh <release-version>}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RELEASE="$REPO_ROOT/deploy/release"
ROOT="$REPO_ROOT/.dsh-release-smoke"
COMPOSE="$ROOT/compose.yml"
PORT=18081
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
    curl -fsS "$BASE/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

[ -f "$RELEASE/SHA256SUMS-$VERSION" ] || { echo "缺少发布包 SHA256SUMS-$VERSION" >&2; exit 1; }
[ -f "$RELEASE/dsh-platform-$VERSION.tar" ] || { echo "缺少 dsh-platform-$VERSION.tar" >&2; exit 1; }
[ -f "$RELEASE/dsh-runtime-$VERSION.tar" ] || { echo "缺少 dsh-runtime-$VERSION.tar" >&2; exit 1; }

docker rm -f dsh-release-smoke-platform-1 >/dev/null 2>&1 || true
docker network rm dsh-release-smoke_default >/dev/null 2>&1 || true
rm -rf "$ROOT"
mkdir -p "$ROOT"/{management,spaces,backups}

cat > "$COMPOSE" <<EOF
name: dsh-release-smoke
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
      DSH_PLATFORM_SPACE_KEY_SECRET: release-smoke-space-key-0123456789abcdef
      DSH_INTERNAL_API_KEY: release-smoke-internal-key-0123456789abcdef
      DSH_GATEWAY_PUBLIC_URL: http://127.0.0.1:$PORT
      DSH_GATEWAY_LISTEN_HOST: 0.0.0.0
      DSH_GATEWAY_LISTEN_PORT: "8080"
    ports:
      - "$PORT:8080"
    volumes:
      - "$ROOT:/srv/dsh"
EOF
trap 'docker compose -f "$COMPOSE" down --remove-orphans >/dev/null 2>&1 || true' EXIT

export DSH_DEPLOY_ROOT="$ROOT"
export DSH_COMPOSE_FILE="$COMPOSE"
export DSH_GATEWAY_LISTEN_PORT="$PORT"
export DSH_PLATFORM_VERSION=test
export DSH_RELEASE_DIR="$RELEASE"

docker compose -f "$COMPOSE" up -d
wait_health || fail "初始平台未就绪"
JAR="$ROOT/alice.jar"
[ "$(curl -s -c "$JAR" -o /dev/null -w '%{http_code}' "$BASE/auth/login?return_to=%2F")" = "302" ] || fail "Mock 登录失败"
[ "$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$BASE/auth/me")" = "200" ] || fail "初始会话无效"
pass "临时部署启动，Mock 会话建立"

bash "$REPO_ROOT/deploy/scripts/upgrade.sh" "$VERSION" >/dev/null || fail "真实发布包升级失败"
wait_health || fail "升级后平台未就绪"
[ "$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$BASE/auth/me")" = "200" ] || fail "升级后既有会话丢失"
RUNNING_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$(docker compose -f "$COMPOSE" ps -q platform)")"
[ "$RUNNING_IMAGE" = "dsh-platform:$VERSION" ] || fail "升级后镜像不是发布版本（实际 $RUNNING_IMAGE）"
pass "真实发布包离线导入并切换版本，既有会话与数据保持"

sha_ok="$(cd "$RELEASE" && sha256sum -c "SHA256SUMS-$VERSION" >/dev/null 2>&1 && echo yes || echo no)"
[ "$sha_ok" = "yes" ] || fail "发布包 SHA256 校验失败"
pass "发布包 SHA256SUMS 校验通过"
echo "RELEASE UPGRADE PASS: $PASSES assertions（版本 $VERSION）"
