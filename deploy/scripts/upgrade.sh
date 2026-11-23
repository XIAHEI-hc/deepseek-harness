#!/usr/bin/env bash
# 离线升级：校验发布包 -> 备份 -> 导入新镜像 -> 切换 -> 健康检查；失败自动回滚。
#
#   bash deploy/scripts/upgrade.sh <release-version>
#
# 要求：deploy/release/ 下有 build-image.sh 产出的 dsh-runtime/dsh-platform tar、
# SHA256SUMS-<version>、compose-<version>.yml。不会覆盖 deploy/.env、密钥与用户卷。
set -euo pipefail

VERSION="${1:?用法: upgrade.sh <release-version>}"
ROOT="${DSH_DEPLOY_ROOT:-/srv/dsh}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
RELEASE="$REPO_ROOT/deploy/release"
COMPOSE="$REPO_ROOT/deploy/compose.yml"
PREVIOUS_TAG="${DSH_RUNTIME_IMAGE:-}"
[ -f "$RELEASE/SHA256SUMS-$VERSION" ] || { echo "缺少发布校验文件：$RELEASE/SHA256SUMS-$VERSION" >&2; exit 1; }

echo "== 校验发布包完整性 =="
( cd "$RELEASE" && sha256sum -c "SHA256SUMS-$VERSION" )

echo "== 升级前备份 =="
bash "$HERE/backup.sh" "pre-upgrade-$VERSION"

echo "== 导入镜像 =="
docker load -i "$RELEASE/dsh-runtime-$VERSION.tar"
docker load -i "$RELEASE/dsh-platform-$VERSION.tar"

echo "== 切换运行时镜像与平台镜像 =="
export DSH_RUNTIME_IMAGE="dsh-runtime:$VERSION"
export DSH_PLATFORM_VERSION="$VERSION"
# 更新 current 软链（运行时 overlay 与平台代码一致）。
ln -sfn "$REPO_ROOT" "$ROOT/current"

echo "== 启动新版本 =="
if ! DSH_RUNTIME_IMAGE="$DSH_RUNTIME_IMAGE" DSH_PLATFORM_VERSION="$VERSION" \
     docker compose -f "$COMPOSE" up -d; then
  echo "新版本启动失败，执行回滚" >&2
  bash "$HERE/rollback.sh" "pre-upgrade-$VERSION" || true
  exit 1
fi

echo "== 健康与就绪检查 =="
ok=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${DSH_GATEWAY_LISTEN_PORT:-8080}/health" >/dev/null; then ok=1; break; fi
  sleep 2
done
if [ "$ok" -ne 1 ]; then
  echo "新版本健康检查失败，执行回滚" >&2
  bash "$HERE/rollback.sh" "pre-upgrade-$VERSION" || true
  exit 1
fi

echo "升级完成：$VERSION（旧运行时镜像：${PREVIOUS_TAG:-未知}）"
echo "请用 A/B 两个真实 W3 账号完成冒烟：登录、姓名显示、会话历史、A/B 隔离、注销。"
