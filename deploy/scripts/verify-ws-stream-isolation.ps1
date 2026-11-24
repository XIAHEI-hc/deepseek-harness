# Session WebSocket 事件隔离与实时撤销验证（Windows，keyless）。
#
#   pwsh -File deploy/scripts/verify-ws-stream-isolation.ps1
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repoRoot
if (-not (Test-Path 'node_modules')) { throw '缺少 node_modules；先安装依赖' }
node --import tsx/esm services/platform/tests/e2e/ws-stream-isolation-probe.ts @args
exit $LASTEXITCODE
