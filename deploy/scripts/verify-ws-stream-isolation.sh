#!/usr/bin/env bash
# Session WebSocket 事件隔离与实时撤销验证（keyless，真实浏览器 + 平台 Runtime）。
#
#   bash deploy/scripts/verify-ws-stream-isolation.sh
#
# 覆盖 DATA-12：A/B 各自打开原生页面并通过 Gateway 的 /api/remote.mux 订阅本人
# Session 事件；A 的 rename 事件只到达 A 的流、B 的页面看不到；B 请求 A 的流
# 被 session/not-found 拒绝；A 注销后其 WebSocket 被 Gateway 实时关闭。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
[ -d node_modules ] || { echo "缺少 node_modules；先安装依赖" >&2; exit 1; }
[ -x node_modules/.bin/playwright ] || true
exec node --import tsx/esm services/platform/tests/e2e/ws-stream-isolation-probe.ts
