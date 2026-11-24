#!/usr/bin/env bash
# 原生 MCP 往返验证（keyless，Mock LLM 驱动真实平台 Runtime + stdio MCP server）。
#
#   bash deploy/scripts/verify-mcp-native.sh
#
# 覆盖 OPS-09 的 MCP 子项：用户 DSH home 的 web profile patch 配置一个 stdio
# MCP server；Runtime 由 MCP manager 加载；脚本化模型调用 mcp__fixtures__add，
# 真实执行 MCP server 并把结果（5）写回 Session。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
[ -d node_modules ] || { echo "缺少 node_modules；先安装依赖" >&2; exit 1; }
exec node --import tsx/esm services/platform/tests/e2e/mcp-native-probe.ts
