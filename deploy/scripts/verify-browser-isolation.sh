#!/usr/bin/env bash
# 浏览器自动化上下文跨用户隔离验证（keyless，Mock LLM + 真实 Chromium）。
#
#   bash deploy/scripts/verify-browser-isolation.sh
#
# 覆盖 DATA-10：A/B 各自 Runtime 挂载 Playwright MCP browser-use provider；
# A 的同一 Session 两次访问保留自身 Cookie；B 首次访问无 Cookie（A 的浏览器
# 状态不会到达 B）；两侧工具调用均为 mcp__playwright-mcp__browser_navigate。
#
# 需要本机 Playwright Chromium（DSH_PROBE_CHROMIUM 可覆盖可执行文件路径）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
[ -d node_modules ] || { echo "缺少 node_modules；先安装依赖" >&2; exit 1; }
exec node --import tsx/esm services/platform/tests/e2e/browser-isolation-probe.ts
