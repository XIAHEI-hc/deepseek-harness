#!/usr/bin/env bash
# 并发 Agent 文件/会话隔离验证（keyless，Mock LLM 驱动真实 DSH Agent）。
#
#   bash deploy/scripts/verify-agent-isolation.sh
#
# 覆盖 DATA-11 与原生 Agent/Chat 回归：为两个身份启动真实 Runtime，各跑一个
# headless Agent 写入不同产物，验证产物/原生 Session 列表/IDOR 均按身份隔离。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
[ -d node_modules ] || { echo "缺少 node_modules；先安装依赖" >&2; exit 1; }
exec node --import tsx/esm services/platform/tests/e2e/agent-isolation-probe.ts
