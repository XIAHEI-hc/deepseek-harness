# 原生 MCP 往返验证（Windows，keyless Mock LLM + stdio MCP server）。
#
#   pwsh -File deploy/scripts/verify-mcp-native.ps1
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repoRoot
if (-not (Test-Path 'node_modules')) { throw '缺少 node_modules；先安装依赖' }
node --import tsx/esm services/platform/tests/e2e/mcp-native-probe.ts @args
exit $LASTEXITCODE
