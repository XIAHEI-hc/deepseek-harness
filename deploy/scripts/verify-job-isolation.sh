#!/usr/bin/env bash
# 后台 Job 跨用户隔离验证（keyless，Mock LLM 驱动真实平台 Runtime）。
#
#   bash deploy/scripts/verify-job-isolation.sh
#
# 覆盖 DATA-08：A 的 Agent 通过 shell 工具创建后台 Job；A 的 job/list 可见，
# B 的 job/list 不可见；B 用 A 的 Job id 调 job/kill 被拒绝；A 可终止自己的 Job。
# Goal/Workflow 属于 Runtime 内 Session/store 结构，没有跨 Runtime 的寻址端点，
# 其隔离边界由本验证同时覆盖的 Session 归属决定。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
[ -d node_modules ] || { echo "缺少 node_modules；先安装依赖" >&2; exit 1; }
exec node --import tsx/esm services/platform/tests/e2e/job-isolation-probe.ts
