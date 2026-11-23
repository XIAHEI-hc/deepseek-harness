#!/usr/bin/env bash
# 首次部署初始化（Linux 部署机，需要 docker + compose 插件）。
#
# 完成：宿主目录、私有网络、.env、Gateway Ed25519 密钥、部署版本目录。
# 不启动服务，不覆盖已有 .env、密钥或用户数据。
set -euo pipefail

ROOT="${DSH_DEPLOY_ROOT:-/srv/dsh}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
VERSION="${DSH_PLATFORM_VERSION:-$(date -u +%Y%m%d%H%M%S)}"

command -v docker >/dev/null || { echo "docker 未安装或不可用" >&2; exit 1; }
docker compose version >/dev/null || { echo "docker compose 插件不可用" >&2; exit 1; }

mkdir -p "$ROOT"/{management/keys,spaces,backups,releases}
chmod 700 "$ROOT/management/keys"

if ! docker network inspect dsh-private >/dev/null 2>&1; then
  docker network create --driver bridge --attachable dsh-private >/dev/null
  echo "已创建私有网络 dsh-private"
else
  echo "私有网络 dsh-private 已存在，保持不变"
fi

# 当前版本目录：部署文件（含运行时 overlay）在同一宿主路径下挂载进用户容器。
CURRENT="$ROOT/current"
if [ -e "$CURRENT" ] && [ ! -L "$CURRENT" ]; then
  mv "$CURRENT" "$ROOT/releases/legacy-$(date -u +%Y%m%d%H%M%S)"
fi
if [ -L "$CURRENT" ]; then
  echo "保留已有 current 软链：$(readlink "$CURRENT")"
else
  ln -sfn "$REPO_ROOT" "$CURRENT"
  echo "已建立 current -> $REPO_ROOT"
fi

if [ ! -f "$HERE/.env" ]; then
  cp "$HERE/.env.example" "$HERE/.env"
  chmod 600 "$HERE/.env"
  echo "已从 .env.example 生成 deploy/.env，请填写生产配置后再启动"
else
  echo "deploy/.env 已存在，保持不变"
fi

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
  echo "已生成 Gateway Ed25519 密钥：$KEY"
else
  echo "Gateway 私钥已存在，保持不变"
  [ -f "$PUB" ] || node -e "const {createPrivateKey,createPublicKey}=require('node:crypto');const fs=require('node:fs');fs.writeFileSync(process.argv[2],createPublicKey(createPrivateKey(fs.readFileSync(process.argv[1],'utf8'))).export({type:'spki',format:'pem'}))" "$KEY" "$PUB"
fi

# 校验平台配置（不启动服务）。
echo "校验平台配置..."
APP_ENV="${APP_ENV:-production}" DSH_PLATFORM_DATA_DIR="$ROOT/management" \
DSH_RUNTIME_ROOT="$ROOT/spaces" DSH_RUNTIME_PATCH_FILE="$CURRENT/deploy/runtime/platform-runtime.patch.yml" \
DSH_GATEWAY_SIGNING_PRIVATE_KEY_FILE="$KEY" DSH_GATEWAY_PUBLIC_KEY_FILE="$PUB" \
node --import tsx/esm "$REPO_ROOT/services/platform/src/main.ts" --check || {
  echo "配置校验失败：请完善 deploy/.env 后重试" >&2
  exit 1
}

echo "初始化完成。下一步：docker compose -f deploy/compose.yml up -d --build"
