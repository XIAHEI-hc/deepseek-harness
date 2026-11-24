#!/usr/bin/env bash
# 一键安装：从版本化离线发布包完成 DSH 多用户平台部署。
#
#   bash deploy/scripts/install.sh --version <v> [--release-dir deploy/release] \
#        [--root /srv/dsh] [--profile production|local] [--env-file FILE] \
#        [--port 8080] [--no-start] [--force-env]
#
# production（默认）：镜像/编排/密钥/目录就绪；需要 --env-file 或已存在的
#   <root>/.env 携带真实 W3 与域名配置，否则只安装不启动并打印后续步骤。
# local：生成 Mock 开发配置并直接启动，用于部署机冒烟（APP_ENV=development）。
#
# 幂等：已有 .env、Gateway 密钥、用户卷、镜像保持不变；重复执行只补齐缺失部分。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION=""
RELEASE_DIR="$(cd "$HERE/../release" 2>/dev/null && pwd || echo "$HERE/../release")"
ROOT="${DSH_DEPLOY_ROOT:-/srv/dsh}"
PROFILE="production"
ENV_FILE=""
PORT="8080"
START=1
FORCE_ENV=0

die() { echo "install: $*" >&2; exit 1; }
info() { echo "== $* =="; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?--version needs a value}"; shift 2 ;;
    --release-dir) RELEASE_DIR="${2:?--release-dir needs a value}"; shift 2 ;;
    --root) ROOT="${2:?--root needs a value}"; shift 2 ;;
    --profile) PROFILE="${2:?--profile needs a value}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?--env-file needs a value}"; shift 2 ;;
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --no-start) START=0; shift ;;
    --force-env) FORCE_ENV=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$VERSION" ] || die "--version <release-version> is required"
[ "$PROFILE" = "production" ] || [ "$PROFILE" = "local" ] || die "--profile must be production or local"
command -v docker >/dev/null || die "docker is not available"
docker compose version >/dev/null || die "docker compose plugin is not available"
command -v node >/dev/null || die "node is required to validate platform configuration and generate keys"

for file in "SHA256SUMS-$VERSION" "compose-$VERSION.yml" "env.example-$VERSION" "platform-runtime-$VERSION.patch.yml" "dsh-platform-$VERSION.tar" "dsh-runtime-$VERSION.tar"; do
  [ -f "$RELEASE_DIR/$file" ] || die "release file missing: $RELEASE_DIR/$file"
done

info "校验发布包 SHA256"
( cd "$RELEASE_DIR" && sha256sum -c "SHA256SUMS-$VERSION" >/dev/null ) || die "release checksum mismatch"

info "导入镜像（已存在则跳过）"
for image in "dsh-platform:$VERSION" "dsh-runtime:$VERSION"; do
  if docker image inspect "$image" >/dev/null 2>&1; then
    echo "镜像已存在：$image"
  else
    tar="$RELEASE_DIR/dsh-platform-$VERSION.tar"
    [ "$image" = "dsh-runtime:$VERSION" ] && tar="$RELEASE_DIR/dsh-runtime-$VERSION.tar"
    docker load -i "$tar" >/dev/null
    echo "已导入：$image"
  fi
done

info "准备部署目录 $ROOT"
mkdir -p "$ROOT"/{management/keys,spaces,backups,releases}
chmod 700 "$ROOT/management/keys"
if ! docker network inspect dsh-private >/dev/null 2>&1; then
  docker network create --driver bridge --attachable dsh-private >/dev/null
  echo "已创建私有网络 dsh-private"
else
  echo "私有网络 dsh-private 已存在，保持不变"
fi

# 运行时 overlay：容器后端按同一宿主路径挂进用户 Runtime。
mkdir -p "$ROOT/current/deploy/runtime"
cp "$RELEASE_DIR/platform-runtime-$VERSION.patch.yml" "$ROOT/current/deploy/runtime/platform-runtime.patch.yml"
COMPOSE="$ROOT/compose-$VERSION.yml"
# 只替换宿主目录的挂载源；容器内路径始终是 /srv/dsh（与宿主路径一致才能让
# 平台容器通过宿主 docker 为运行时容器挂载同一路径）。
sed "s#- /srv/dsh:/srv/dsh#- $ROOT:/srv/dsh#" "$RELEASE_DIR/compose-$VERSION.yml" > "$COMPOSE"
ln -sfn "$COMPOSE" "$ROOT/compose.yml"
echo "编排文件：$ROOT/compose.yml"

KEY="$ROOT/management/keys/gateway-ed25519-private.pem"
PUB="$ROOT/management/keys/gateway-ed25519-public.pem"
if [ ! -f "$KEY" ]; then
  node -e "
const { generateKeyPairSync } = require('node:crypto')
const fs = require('node:fs')
const pair = generateKeyPairSync('ed25519')
fs.writeFileSync(process.argv[1], pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
fs.writeFileSync(process.argv[2], pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 })
" "$KEY" "$PUB"
  echo "已生成 Gateway Ed25519 密钥"
else
  echo "Gateway 私钥已存在，保持不变"
fi

random_secret() { node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"; }

ENV_TARGET="$ROOT/.env"
if [ -n "$ENV_FILE" ]; then
  [ -f "$ENV_FILE" ] || die "--env-file does not exist: $ENV_FILE"
  if [ -f "$ENV_TARGET" ] && [ "$FORCE_ENV" -ne 1 ]; then
    echo "已有 $ENV_TARGET，保持不变（--force-env 可覆盖）"
  else
    cp "$ENV_FILE" "$ENV_TARGET"
    chmod 600 "$ENV_TARGET"
    echo "已写入环境文件：$ENV_TARGET"
  fi
elif [ ! -f "$ENV_TARGET" ] || [ "$FORCE_ENV" -eq 1 ]; then
  if [ "$PROFILE" = "local" ]; then
    cat > "$ENV_TARGET" <<EOF
# install.sh --profile local 生成的部署机冒烟配置；不要用于生产。
APP_ENV=development
AUTH_MODE=mock
AUTH_COOKIE_SECURE=false
DSH_PLATFORM_REALM=dsh
DSH_GATEWAY_PUBLIC_URL=http://127.0.0.1:$PORT
DSH_GATEWAY_LISTEN_PORT=$PORT
DSH_INTERNAL_API_KEY=$(random_secret)
DSH_PLATFORM_SPACE_KEY_SECRET=$(random_secret)
DSH_RUNTIME_KIND=container
DSH_RUNTIME_IMAGE=dsh-runtime:$VERSION
DSH_RUNTIME_NETWORK=dsh-private
DSH_RUNTIME_PATCH_FILE=/srv/dsh/current/deploy/runtime/platform-runtime.patch.yml
DSH_PLATFORM_VERSION=$VERSION
EOF
    chmod 600 "$ENV_TARGET"
    echo "已生成本地冒烟环境文件：$ENV_TARGET"
  else
    cp "$RELEASE_DIR/env.example-$VERSION" "$ENV_TARGET"
    chmod 600 "$ENV_TARGET"
    echo "已从模板生成 $ENV_TARGET；请填写真实 W3/域名/密钥后重新运行本脚本"
    START=0
  fi
else
  echo "已有 $ENV_TARGET，保持不变"
fi

# 补齐编排与平台运行所需的版本变量，不覆盖运维已设置的值。
ensure_var() {
  local name="$1" value="$2"
  if grep -qE "^${name}=" "$ENV_TARGET"; then
    sed -i "s#^${name}=.*#${name}=${value}#" "$ENV_TARGET"
  else
    printf '%s=%s\n' "$name" "$value" >> "$ENV_TARGET"
  fi
}
ensure_var DSH_PLATFORM_VERSION "$VERSION"
ensure_var DSH_RUNTIME_IMAGE "dsh-runtime:$VERSION"

info "校验平台配置"
docker run --rm \
  --env-file "$ENV_TARGET" \
  -e DSH_PLATFORM_DATA_DIR=/srv/dsh/management \
  -e DSH_PLATFORM_REPO_ROOT=/srv/dsh/current \
  -e DSH_RUNTIME_ROOT=/srv/dsh/spaces \
  -e DSH_RUNTIME_PATCH_FILE=/srv/dsh/current/deploy/runtime/platform-runtime.patch.yml \
  -e DSH_GATEWAY_SIGNING_PRIVATE_KEY_FILE=/srv/dsh/management/keys/gateway-ed25519-private.pem \
  -e DSH_GATEWAY_PUBLIC_KEY_FILE=/srv/dsh/management/keys/gateway-ed25519-public.pem \
  -e DSH_GATEWAY_LISTEN_HOST=0.0.0.0 \
  -e DSH_GATEWAY_LISTEN_PORT=8080 \
  -e DSH_RUNTIME_KIND=container \
  -v "$ROOT:/srv/dsh" \
  "dsh-platform:$VERSION" node services/platform/src/main.ts --check >/dev/null \
  || die "platform configuration is invalid; fix $ENV_TARGET and retry"

if [ "$START" -ne 1 ]; then
  echo "安装完成（未启动）。填写 $ENV_TARGET 后执行："
  echo "  DSH_PLATFORM_VERSION=$VERSION docker compose -f $COMPOSE up -d"
  exit 0
fi

info "启动平台"
(
  cd "$ROOT"
  set -a
  . "$ENV_TARGET"
  set +a
  DSH_PLATFORM_VERSION="$VERSION" DSH_RUNTIME_IMAGE="dsh-runtime:$VERSION" \
    docker compose -f "$COMPOSE" up -d --no-build
)

info "等待健康检查"
CONTAINER="$(docker compose -f "$COMPOSE" ps -q platform)"
[ -n "$CONTAINER" ] || die "platform container did not start"
for _ in $(seq 1 60); do
  STATUS="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER" 2>/dev/null || echo unknown)"
  if [ "$STATUS" = "healthy" ]; then
    echo "平台已就绪：$(grep -E '^DSH_GATEWAY_PUBLIC_URL=' "$ENV_TARGET" | cut -d= -f2-)"
    echo "查看日志：docker compose -f $COMPOSE logs -f platform"
    exit 0
  fi
  sleep 2
done
die "platform health check did not become healthy; inspect: docker compose -f $COMPOSE logs --tail 100 platform"
