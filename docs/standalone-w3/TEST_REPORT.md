# 测试与验收证据（TEST REPORT）

只记录实际执行过的命令与真实输出；未执行记 `NOT_RUN`，环境/凭据缺失记 `BLOCKED`。执行环境：Windows 11 + Node v24.21.0 + pnpm 11.28.5；Docker 29.7.2 / Compose v5.5.0 运行在 WSL2 Ubuntu 内。

## 1. 环境与基线

| 检查 | 命令 | 结果 |
|---|---|---|
| 仓库基线 | `git remote -v`、`git status --short`、`git log -1` | PASS（origin XIAHEI-hc，master，HEAD 为 feat(authentication-gateway) 提交，仅开发包解压副本未跟踪） |
| 版本 | `node --version`、`pnpm --version` | PASS（v24.21.0 / 11.28.5） |
| Docker | `wsl -d Ubuntu --exec docker --version` | PASS（29.7.2；Compose v5.5.0） |

## 2. 平台单元/组件测试

命令：

```bash
pnpm exec tsc -p services/platform/tsconfig.json --noEmit
pnpm exec vitest run --config services/platform/vitest.config.ts
```

结果（2026-11-23）：

- 类型检查：PASS（0 错误）。
- 单元/组件：**13 files passed, 189 tests passed, 1 skipped**（skip = 真实 Docker 用例，需`DSH_PLATFORM_DOCKER_TEST=1` + `DSH_RUNTIME_IMAGE` + 可路由的 docker；环境限制见 OPEN_ISSUES）。
- 分模块（各自子代理实测，见各任务汇报）：
  - identity：3 files / 31 tests passed（AUTH-01..AUTH-23 可本地验证项）
  - runtime：5 files / 63 passed + 1 skipped（RUNT-01..RUNT-13 的注入/真实进程边界）
  - gateway：4 files / 81 tests passed（GATE-02..GATE-14 的单元/组件层）
- oxlint：`pnpm exec oxlint services/platform` → 0 问题。

## 3. 真实 Runtime 集成冒烟（Mock + 进程后端）

实际执行（`deploy/scripts/run-dev.ps1` 启动平台，原生 DSH 作为每用户 Runtime 子进程）：

| 步骤 | 结果 |
|---|---|
| `GET /health` | 200 `{"ok":true,"mode":"mock","runtimeKind":"process"}` |
| `GET /auth/health` | 200 `{"ok":true,"mode":"mock"}` |
| `GET /login` | 200，中英登录页 + CSP（`default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'`） |
| 匿名 `GET /` | 302 → `/login?return_to=%2F` |
| Mock `GET /auth/login` | 302 + Set-Cookie `dsh_session`(HttpOnly) 与 `dsh_csrf` |
| `GET /auth/me` | 200，返回 Mock 用户 displayName/uid/subject 与绝对过期时间 |
| `POST /api/runtime/retry`（带 CSRF） | 200 `{"state":"READY","generation":2,"retryable":false,"errorCode":null}` |
| 认证后 `GET /` | **200，42,249 bytes，包含原生 DSH `__DSH_BOOT__`**（Gateway 成功代理到该用户真实 DSH Runtime） |
| `GET /api/runtime/me` | 只返回 state/generation/retryable/errorCode，无内部 host/port |

说明：本次冒烟验证了“Mock 登录 → 平台 Session → Runtime Manager 启动真实 DSH → Gateway 代理原生 UI”的完整链路。首轮启动失败后 `ensure` 按设计不自动重启，`retry` 成功，符合 FAILED 需显式重试的状态机。

### 3.1 Runtime overlay / 断言格式真实验证

单独启动一个带 `deploy/runtime/platform-runtime.patch.yml` 的 DSH Runtime 并手工签发 v2 断言：

| 请求 | 结果 |
|---|---|
| 无断言 `GET /` | 401 `unauthorized` |
| 带合法 Ed25519 v2 两段断言 `GET /` | **200 原生 UI HTML** |
| 带合法断言 `GET /api/remote.mux`（非升级 GET） | 404（路由语义），不再 401 |
| `dsh web --dump-config --patch deploy/runtime/platform-runtime.patch.yml` | `authentication-token: disabled: true`，插入 `authentication-gateway` 行，配置来自 env 表达式 |

该验证确认：旧 `?token` provider 被关闭、Gateway provider 生效、断言 wire 格式与仓库 verifier 一致。

### 3.2 双用户端到端（真实进程 Runtime + 模拟 W3 Provider）

命令：

```bash
pnpm run test:platform:e2e
```

覆盖（`services/platform/tests/e2e/platform.e2e.spec.ts`）：匿名跳转/401、两个脚本化 W3 身份完整授权码登录、两个独立 Runtime 与空间目录、同身份第二浏览器复用同一 Runtime、`/api/runtime/*` 不泄露内部目标、认证 WebSocket 101 / 伪造 Cookie 401 / 跨站 Origin 拒绝、注销后旧 Cookie 401、实时 WebSocket 在复验周期内断开、B 用户不受 A 注销影响、代理后的原生 UI 含 `__DSH_BOOT__`。

实测结果（2026-11-23，`pnpm run test:platform:e2e`）：

```
Test Files  1 passed (1)
Tests       5 passed (5)
Duration    30.59s
{"event":"runtime.ready","userRef":"c923d2acbca4","generation":1}
{"event":"runtime.ready","userRef":"c2fbd5586731","generation":1}
```

说明：两条 `runtime.ready` 事件来自两个不同用户的真实 DSH 进程；e2e 使用脚本化 W3 Provider（无真实租户凭据），因此 AUTH-24 仍为 BLOCKED。WebSocket 用例真实经过 Gateway → 用户 DSH Runtime 的 101 握手、伪造 Cookie 拒绝、跨站 Origin 拒绝、注销后 ≤1 个复验周期的隧道关闭。

## 3.3 真实浏览器验收（Playwright，原生 DSH + 平台身份插件）

命令（headless Chromium，1440×900，en-US）；截图保存在 `docs/standalone-w3/evidence/`：

| 步骤 | 实测结果 |
|---|---|
| 匿名访问 `/` | 跳转 `/login?return_to=%2F`，显示平台登录页（`evidence/login-page.png`） |
| 点击“Sign in with W3” | Mock 身份登录并跳回 `/workspace`，进入原生 DSH |
| 等待 Runtime | 状态层在 Runtime 未就绪时覆盖页面，READY 后自动消失，原生客户端可用 |
| 侧栏底部平台身份 | 显示 `本地开发用户` + `W3 · local-001` + 首字母头像（`evidence/native-ui-with-platform-identity.png`） |
| 刷新页面 | 平台身份保持同一用户，无旧用户数据闪现 |
| 账号菜单 | 含“账号信息 / 模型供应商设置 / 退出 DSH”（`evidence/platform-account-menu.png`） |
| 平台退出 | 回到 `/login`，平台身份入口消失（`evidence/after-platform-logout.png`） |
| 第二个身份 | 以另一 Mock subject 重启平台后，侧栏显示 `User B` + `W3 · local-002`（`evidence/native-ui-with-user-b.png`） |
| 模型供应商未登录 | 原生“Get started”供应商对话框未完成登录，平台登录与原生界面仍可用 |

同时验证了客户端插件真实进入原生模块清单：页面 `__DSH_BOOT__` 的启动组合包含`@deepseek-ai/dsh-client-ui-platform-identity/client.js`，该启动组合（6.0 MB JS）经 Gateway 代理返回 200 并包含插件代码。

## 4. 仓库级检查

| 检查 | 命令 | 结果 |
|---|---|---|
| 平台类型检查 | `pnpm exec tsc -p services/platform/tsconfig.json --noEmit` | PASS（0 错误） |
| 平台测试 | `pnpm exec vitest run --config services/platform/vitest.config.ts` | PASS（13 files / 189 passed / 1 skipped） |
| 平台 e2e | `pnpm run test:platform:e2e` | PASS（5 passed，真实双 Runtime） |
| 平台 lint | `pnpm exec oxlint services/platform` | PASS |
| 前端包测试 | `vitest run packages/client/ui-platform-identity/tests packages/client/ui-settings-general/tests packages/bundle/web-app/tests packages/host/authentication-gateway/tests` | 24/25 files，282 passed；1 个既有环境超时（web-app product-analytics 5s 超时，与本改动无关） |
| 前端包 lint | `pnpm exec oxlint packages/client/ui-platform-identity` | PASS（frontend 子代理复跑） |
| 构建产物 | `pnpm run build:artifacts` | PASS（8/8 gates，含 host/client compiler、client bundle、Web build） |
| 构建校验 | `pnpm run build:check` | PASS（host + client aggregate check；修复前端测试类型后复跑通过） |
| 文档 gates | `pnpm run test:docs` | PASS（21/21 gates：md wrap、md links、translation pairing、doc budgets、package README、repository references 等） |
| 文档同步 | `pnpm run doc-sync` | 42/43 gates PASS；唯一失败为既有 Windows 环境限制：`scripts/project-doc-site.spec.ts` 创建符号链接 `EPERM`（与本改动无关） |
| 平台容器镜像 | `docker build -f deploy/platform/Dockerfile -t dsh-platform:test .` 后 `docker run ... --check` | PASS（镜像构建成功；开发配置校验通过；生产缺配置时按预期列出缺项并非零退出） |
| 源码发布包 | `deploy/release/dsh-platform-source-2026.11.23-dev.tar.gz` | PASS（541,465 bytes，sha256 37f4da64…d44a3；173 条目，无 `.env`/数据库/凭据；含 `.env.example`） |
| 仓库 lint | `pnpm run lint` | 失败项全部为**既有文件**（`skill-plaza`、`authentication-gateway` 测试、`workspace-controller`、`ui-skill-plaza` 测试），无新代码文件；`pnpm exec oxlint services/platform packages/client/ui-platform-identity` 0 问题 |

### 4.1 与本改动无关的既有红

- `verify-cordis-config`：`apps/cli/tests/profiles/acp/cordis.yml: root must be a Loader entry array`（仓库既有测试夹具指向 snapshot，与平台改动无关）。
- `verify-client-domain-graph`：`ui-workspace` 既有 sibling import（frontend 子代理报告，与本包无关）。
- `apps/web`/client 全量回归中 2 个环境失败：`ui-sidebar-documentpreview` 的 `pnpm.exe ETIMEDOUT`（Windows 本机 pnpm 超时）。
- `doc-sync` 的 `scripts/project-doc-site.spec.ts` 在 Windows 上创建测试符号链接失败（`EPERM`），属于宿主机权限限制。

## 5. BLOCKED / NOT_RUN

| ID | 状态 | 原因 |
|---|---|---|
| AUTH-24 | BLOCKED | 无真实 W3 租户凭据与回调白名单；Mock/脚本化 W3 不替代真实登录 |
| OPS-02/06/07/10 | BLOCKED | 无生产部署机、内网 Git 地址与凭据 |
| RUNT-11/12、DATA-05（容器内实测） | BLOCKED | Windows 宿主机无法路由 WSL2 用户自定义网络容器 IP；需 Linux 部署机复验 |
| OPS-08 | BLOCKED | 需要 7 天真实运行窗口 |
| PostgreSQL 生产库 | BLOCKED | 当前实现为 SQLite + 版本化迁移；PostgreSQL 后端未实现 |
| UI 截图证据（UI-01/02/09） | NOT_RUN | 需要真实浏览器 + 真实 W3；组件测试与 e2e HTML 证据已有 |

## 6. 更新记录

| 时间（UTC+8） | 动作 | 结果 |
|---|---|---|
| 11:53–12:00 | 基线审计、契约与骨架 | PASS |
| 12:00–12:30 | 身份/运行时/网关/前端四个子系统实现（子代理并行，lead 集成） | 各模块测试全绿 |
| 12:20 | 真实 Runtime overlay + 断言格式冒烟 | PASS（401 无断言 / 200 带断言 / dump-config 行正确） |
| 12:34 | 首次 e2e | 3/5（WS 用例因 Sec-WebSocket-Key 非 16 字节被 Runtime 400、跨站 Origin 期望码） |
| 12:43 | 修复后 e2e 复跑 | **5/5 PASS，30.6s，双真实 Runtime** |
| 12:50 | `pnpm run build:artifacts` | PASS（8/8，189.9s） |
| 12:57 | `pnpm run build:check` | 首次 client aggregate 因前端测试 fetch mock 类型失败；frontend 修复 |
| 13:00 | `pnpm run build:check` 复跑 | **PASS（host + client）** |
| 13:02–13:05 | 生成器（client catalog / config catalog / module graph / plugin packages） | 5 个生成物更新 |
| 13:05–13:10 | 文档 gates 修复（md wrap、仓库引用、发布包、pairing 排除） | `pnpm run test:docs` **21/21 PASS** |
| 13:08 | 浏览器验收（Playwright，原生 DSH + 平台身份插件） | PASS，截图见 `evidence/` |
| 13:12 | 平台容器镜像构建 + `--check`（开发/生产） | PASS（生产 fail-closed 列出缺项） |
| 13:13 | 源码发布包 + SHA256 | PASS（无 `.env`/凭据） |
| 13:14 | 平台单测最终复跑 | 13 files / 189 passed / 1 skipped |

### 结论

- 可在本机真实验证的部分（Mock 身份、W3 授权码协议、双用户真实 Runtime、HTTP/WS 代理与撤销、原生 UI 平台身份、配置 fail-closed、构建/类型/文档 gates、平台镜像）均已实测通过。
- 依赖外部环境的条目（真实 W3 租户、Linux 生产部署机、容器内攻击面探测、PostgreSQL、7 天运行、离线升级演练、内网 Git）标 BLOCKED/NOT_RUN，清单与精确条件见 `OPEN_ISSUES.md` 与 `ACCEPTANCE_MATRIX.csv`。
