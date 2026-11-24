# 后台 Job 跨用户隔离验证（Windows，keyless Mock LLM）。
#
#   pwsh -File deploy/scripts/verify-job-isolation.ps1
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repoRoot
if (-not (Test-Path 'node_modules')) { throw '缺少 node_modules；先安装依赖' }
node --import tsx/esm services/platform/tests/e2e/job-isolation-probe.ts @args
exit $LASTEXITCODE
