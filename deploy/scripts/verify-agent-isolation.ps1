# 并发 Agent 文件/会话隔离验证（Windows，keyless Mock LLM）。
#
#   pwsh -File deploy/scripts/verify-agent-isolation.ps1
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repoRoot
if (-not (Test-Path 'node_modules')) { throw '缺少 node_modules；先安装依赖' }
node --import tsx/esm services/platform/tests/e2e/agent-isolation-probe.ts @args
exit $LASTEXITCODE
