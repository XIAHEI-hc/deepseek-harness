# 本地开发启动（Windows）：Mock 身份 + 进程级 Runtime。
#
#   pwsh -File deploy/scripts/run-dev.ps1
#
# 浏览器打开 http://127.0.0.1:8080 ；数据位于仓库根 .dsh-platform/。
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repoRoot

$env:APP_ENV = 'development'
$env:AUTH_MODE = 'mock'
if (-not $env:DSH_PLATFORM_DATA_DIR) { $env:DSH_PLATFORM_DATA_DIR = Join-Path $repoRoot '.dsh-platform' }
$env:DSH_PLATFORM_REPO_ROOT = $repoRoot
if (-not $env:DSH_PLATFORM_REALM) { $env:DSH_PLATFORM_REALM = 'dsh' }
$env:AUTH_COOKIE_SECURE = 'false'
if (-not $env:DSH_GATEWAY_PUBLIC_URL) { $env:DSH_GATEWAY_PUBLIC_URL = 'http://127.0.0.1:8080' }
if (-not $env:DSH_GATEWAY_LISTEN_HOST) { $env:DSH_GATEWAY_LISTEN_HOST = '127.0.0.1' }
if (-not $env:DSH_GATEWAY_LISTEN_PORT) { $env:DSH_GATEWAY_LISTEN_PORT = '8080' }
$env:DSH_RUNTIME_KIND = 'process'
if (-not $env:DSH_RUNTIME_ROOT) { $env:DSH_RUNTIME_ROOT = Join-Path $env:DSH_PLATFORM_DATA_DIR 'spaces' }
if (-not $env:DSH_RUNTIME_PATCH_FILE) { $env:DSH_RUNTIME_PATCH_FILE = Join-Path $repoRoot 'deploy\runtime\platform-runtime.patch.yml' }
if (-not $env:DSH_RUNTIME_IDLE_SECONDS) { $env:DSH_RUNTIME_IDLE_SECONDS = '1800' }
if (-not $env:DSH_PLATFORM_SPACE_KEY_SECRET) { $env:DSH_PLATFORM_SPACE_KEY_SECRET = 'development-space-key-0123456789abcdef0123456789abcdef' }
if (-not $env:DSH_INTERNAL_API_KEY) { $env:DSH_INTERNAL_API_KEY = 'development-internal-key-0123456789abcdef' }

node --import tsx/esm services/platform/src/main.ts @args
