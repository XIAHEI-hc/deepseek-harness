#!/usr/bin/env bash
# 在已发布安装栈上验证 W3 A/B 双身份（测试 W3 Provider + 真实用户 Runtime 容器）。
#
#   bash deploy/scripts/verify-installed-stack-w3-ab.sh --version <v> [--release-dir DIR] [--port 18082] [--fresh]
#
# 该脚本用于专用验证部署机：会重建 /srv/dsh（先停掉现有 stack），启动 host 上的
# W3 测试 Provider（docker0 网关地址可达），用发布包一键安装 W3 模式平台，然后
# 以两个账号完成授权码登录、Runtime 容器启动、Session 隔离、注销撤销验证。
#
# --fresh 会删除整个部署根目录（默认 /srv/dsh），仅用于一次性验证机。
# 前置：docker + compose + node；/srv/dsh 由当前用户可写（或先 sudo 创建并 chown）。
set -euo pipefail

VERSION=""
RELEASE_DIR=""
PORT="18082"
FRESH=0
ROOT="${DSH_DEPLOY_ROOT:-/srv/dsh}"
PROVIDER_PORT="19090"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

die() { echo "verify-installed-stack-w3-ab: $*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?}"; shift 2 ;;
    --release-dir) RELEASE_DIR="${2:?}"; shift 2 ;;
    --port) PORT="${2:?}"; shift 2 ;;
    --fresh) FRESH=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$VERSION" ] || die "--version is required"
[ -n "$RELEASE_DIR" ] || RELEASE_DIR="$REPO_ROOT/deploy/release"
command -v docker >/dev/null || die "docker is required"
command -v node >/dev/null || die "node is required"
case "$ROOT" in
  /|/srv|/usr|/etc|/var|/home) die "refusing to use $ROOT as the deployment root" ;;
esac
[ -w "$ROOT" ] || die "$ROOT must be writable by the current user (create it with sudo and chown)"
if [ "$FRESH" -eq 1 ]; then
  echo "== 清理旧验证栈：$ROOT =="
  docker compose -f "$ROOT/compose.yml" down --remove-orphans >/dev/null 2>&1 || true
  for container in $(docker ps -aq --filter name=dsh-rt- 2>/dev/null); do
    docker rm -f "$container" >/dev/null 2>&1 || true
  done
  docker network rm dsh-private >/dev/null 2>&1 || true
  # 只清空部署根的目标内容，保留根目录本身（根目录可能位于 root 拥有的父目录下）。
  rm -rf "$ROOT"/* "$ROOT"/.[!.]* 2>/dev/null || true
  mkdir -p "$ROOT"
fi

GATEWAY_IP="$(ip -4 addr show docker0 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | head -1)"
[ -n "$GATEWAY_IP" ] || GATEWAY_IP="172.17.0.1"
echo "docker0 host gateway: $GATEWAY_IP"

ENV_FILE="$(mktemp /tmp/dsh-w3-ab-env.XXXXXX)"
PROVIDER_LOG="$(mktemp /tmp/dsh-w3-provider.XXXXXX.log)"
cleanup() {
  docker compose -f "$ROOT/compose.yml" down --remove-orphans >/dev/null 2>&1 || true
  for container in $(docker ps -aq --filter name=dsh-rt- 2>/dev/null); do
    docker rm -f "$container" >/dev/null 2>&1 || true
  done
  docker network rm dsh-private >/dev/null 2>&1 || true
  if [ -n "${PROVIDER_PID:-}" ]; then kill "$PROVIDER_PID" >/dev/null 2>&1 || true; fi
  rm -f "$ENV_FILE" "$PROVIDER_LOG"
}
trap cleanup EXIT

cat > "$ENV_FILE" <<EOF
APP_ENV=development
AUTH_MODE=w3
AUTH_COOKIE_SECURE=false
DSH_PLATFORM_REALM=dsh
DSH_GATEWAY_PUBLIC_URL=http://127.0.0.1:$PORT
DSH_GATEWAY_LISTEN_PORT=$PORT
DSH_INTERNAL_API_KEY=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")
DSH_PLATFORM_SPACE_KEY_SECRET=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")
DSH_RUNTIME_KIND=container
DSH_RUNTIME_IMAGE=dsh-runtime:$VERSION
DSH_RUNTIME_NETWORK=dsh-private
DSH_RUNTIME_PATCH_FILE=$ROOT/current/deploy/runtime/platform-runtime.patch.yml
DSH_PLATFORM_VERSION=$VERSION
W3_CLIENT_ID=dsh-client
W3_CLIENT_SECRET=dsh-secret
W3_AUTHORIZE_URL=http://$GATEWAY_IP:$PROVIDER_PORT/authorize
W3_TOKEN_URL=http://$GATEWAY_IP:$PROVIDER_PORT/token
W3_USERINFO_URL=http://$GATEWAY_IP:$PROVIDER_PORT/userinfo
W3_REDIRECT_URI=http://127.0.0.1:$PORT/auth/callback
W3_SCOPE=base.profile
W3_TOKEN_REQUEST_FORMAT=json
EOF

echo "== 启动测试 W3 Provider =="
node "$REPO_ROOT/deploy/tests/w3-test-provider.mjs" "$PROVIDER_PORT" > "$PROVIDER_LOG" 2>&1 &
PROVIDER_PID=$!
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PROVIDER_PORT/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$PROVIDER_PORT/health" >/dev/null || die "W3 test provider did not start"

echo "== 安装 W3 模式平台（发布包 $VERSION，端口 $PORT）=="
bash "$HERE/install.sh" --version "$VERSION" --release-dir "$RELEASE_DIR" --env-file "$ENV_FILE" --port "$PORT" >/dev/null

echo "== A/B 登录、Runtime、Session 隔离、注销撤销 =="
BASE="http://127.0.0.1:$PORT" PROVIDER="http://$GATEWAY_IP:$PROVIDER_PORT" \
  node "$REPO_ROOT/deploy/tests/installed-stack-w3-ab.mjs" login
docker ps --filter label=dsh.platform=1 --format '{{.Names}} {{.Image}}' | sed 's/^/container: /'
BASE="http://127.0.0.1:$PORT" PROVIDER="http://$GATEWAY_IP:$PROVIDER_PORT" \
  node "$REPO_ROOT/deploy/tests/installed-stack-w3-ab.mjs" revoke
echo "INSTALLED STACK W3 A/B PASS"
