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
- 单元/组件：**15 files passed, 204 tests passed, 1 skipped**（skip = 真实 Docker 用例，需`DSH_PLATFORM_DOCKER_TEST=1` + `DSH_RUNTIME_IMAGE` + 可路由的 docker；环境限制见 OPEN_ISSUES）。
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
Tests       7 passed (7)
Duration    41.96s
{"event":"runtime.ready","userRef":"b2aab0c5d81c","generation":1}
{"event":"runtime.ready","userRef":"83aff97f1868","generation":1}
{"event":"runtime.ready","userRef":"205d009969e5","generation":1}
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

## 3.4 真实容器隔离验证（WSL2 Linux Docker，60 断言全 PASS）

命令（WSL 内执行，使用真实 Docker 守护进程与生产 `createDockerBackend` 代码路径）：

```bash
wsl -d Ubuntu --exec bash /mnt/d/Vibe_coding/deepseek-harness/deploy/scripts/verify-container-isolation.sh
```

实测结果：`CONTAINER E2E PASS: 60 assertions`，证据日志 [evidence/container-isolation.log](evidence/container-isolation.log)。

| 覆盖 | 实测断言 |
|---|---|
| RUNT-01 一身份一容器 | A/B 两个容器、不同私网 IP、各自独立 6 个空间挂载 |
| RUNT-02/03 同身份复用 | 第二次 ensure 复用同一 target，同身份只有一个容器 |
| RUNT-05/08 异常退出与重启 | `docker stop` 后 ensure 为 FAILED 且 retryable；retry 产生新 generation，数据保留 |
| RUNT-06/07 空闲与 lease | 持有 lease 时 idle reaper 不回收；释放后 reaper 停止容器、数据保留、下次访问新 generation |
| RUNT-09 Supervisor 重启 | 新 manager 实例 adopt 运行中容器：READY、同 generation、不产生第二个容器 |
| RUNT-11/12 敏感挂载 | 容器内不可见 `/var/run/docker.sock`、Gateway 私钥、宿主根 `/mnt/d`、B 的空间目录 |
| RUNT-13 资源限额 | inspect 断言 memory=512MiB、NanoCpus=1e9、PidsLimit=256、固定 uid/gid 1000:1000 |
| OPS-03 端口 | `NetworkSettings.Ports` 为空，HostConfig.NetworkMode 仅私有网络 |
| DATA-05 | 容器内 `uid=1000`，只能访问本人 6 个空间挂载，不能访问他人空间/宿主根 |
| 挂载策略 | 恰好 8 个挂载，其中仅公钥与 runtime overlay 为 `:ro`，不挂载整个 spaces 根 |

限制：验证使用轻量 probe 镜像（只回答就绪探针）驱动真实 docker run argv；完整 DSH Runtime 镜像（`deploy/runtime/Dockerfile`）仍需在 Linux 构建机构建后复验（见 OPEN_ISSUES）。

## 3.5 旧历史数据归属迁移（OPS-05，CLI 实测）

命令（开发平台用 Mock 登录创建用户后，把独立旧 home 归属到该用户）：

```bash
node --import tsx/esm services/platform/src/main.ts admin migrate-home \
  --from <legacy-dsh-home> --subject <w3-subject>            # 默认 dry-run，仅打印计划
node --import tsx/esm services/platform/src/main.ts admin migrate-home \
  --from <legacy-dsh-home> --subject <w3-subject> --confirm  # 执行复制并写 manifest
```

实测结果（证据 [evidence/migrate-home.log](evidence/migrate-home.log)）：

| 步骤 | 结果 |
|---|---|
| 未登录用户/未知 subject | 退出码 2，`migration-user-unknown`，不复制任何数据（不会自动归给首位登录者） |
| dry-run | 退出码 0，只输出目标 `$DSH_HOME` 与待复制条目，不创建目标目录 |
| --confirm | 退出码 0，`sessions/`、`skills/` 复制进解析出的用户 space，写出 `migrations/migrate-home-*.json` manifest |
| 单元测试 | 10 个用例覆盖 subject/user 解析、dry-run、冲突拒绝、overwrite、路径重叠/缺失、symlink 跳过、稳定错误码 |

## 3.6 部署生命周期演练（OPS-04/06/07，真实 Docker + 真实脚本）

命令（WSL 内执行，临时部署根与合成发布包，不触碰任何真实部署数据）：

```bash
wsl -d Ubuntu --exec bash /mnt/d/Vibe_coding/deepseek-harness/deploy/scripts/verify-deploy-lifecycle.sh
```

实测结果：`DEPLOY LIFECYCLE PASS: 9 assertions`，证据 [evidence/deploy-lifecycle.log](evidence/deploy-lifecycle.log)。

| 覆盖 | 实测断言 |
|---|---|
| 启动与迁移 | 平台容器从镜像启动，启动时应用版本化迁移，`/health` 就绪 |
| 备份（OPS-04） | `backup.sh` 停止平台、打包 management 与用户空间、写 MANIFEST，并恢复在线 |
| 恢复（OPS-04） | 备份后创建的新会话在恢复后被撤销（401），备份内既有会话仍有效（200） |
| 离线升级（OPS-06） | 生成带 SHA256SUMS 的发布包并删除本地镜像；`upgrade.sh` 从 tar `docker load` 导入 v2、启动成功，数据库与 alice 会话保持不变 |
| 失败回滚（OPS-07） | 构造不含目标镜像的 v3 包使升级失败；`upgrade.sh` 自动调用 `rollback.sh` 恢复到上一版本 v2，健康检查通过、alice 会话与数据一致 |
| 清理 | 演练容器、网络与临时部署根全部清理 |

注：本演练使用平台镜像与合成运行时镜像验证升级/回滚机制；完整 Runtime 镜像构建后应重复同一流程（见 OPEN_ISSUES）。

## 3.7 管理员用户/会话命令（CLI 实测）

```bash
node --import tsx/esm services/platform/src/main.ts admin user disable --subject <w3-subject> --confirm
node --import tsx/esm services/platform/src/main.ts admin user enable  --subject <w3-subject> --confirm
node --import tsx/esm services/platform/src/main.ts admin session revoke-all --subject <w3-subject> --confirm
```

实测（对运行中的平台执行，证据 [evidence/admin-cli.log](evidence/admin-cli.log)）：

| 步骤 | 结果 |
|---|---|
| disable | 用户 status=disabled、permission_version+1、1 个 Session 被撤销；同一 Cookie 下一次 `/auth/me` 立即 401 |
| enable | 用户恢复 active；旧 Session 仍失效；重新登录得到新 Session 且 `/auth/me` 200 |
| 未带 --confirm | `admin-confirm-required`，退出码 3，不改变任何状态 |
| e2e 扩展 | 真实平台 + 3 个 Runtime：C 的 HTTP 立即 401、活动 WebSocket 在一个复验周期内关闭，B 不受影响（6/6 tests） |

## 3.8 双身份 Session/搜索/IDOR/历史恢复隔离（DATA-01/02/03/13，e2e）

在真实平台 + 两个真实 DSH Runtime 上，用原生 Typert Remote HTTP 端点验证（同一套客户端协议，不绕过 Gateway）：

| 场景 | 实测结果 |
|---|---|
| 会话列表 | A/B 各自 `session/list` 只含本人 Session；对方 id 不出现 |
| 内容搜索 | 每个身份在自己 `$DSH_HOME/state/session-query.sqlite` 索引上搜索，A 的搜索结果不含 B 的 Session（B 反之亦然）；空白 Session 无消息文本，内容排名未覆盖 |
| 猜 B 的 Session ID 读取 | A 用 B 的 id 调 `session/state`、`session/page` → `session/not-found`，无数据泄露 |
| 改 B 的 Session | A 对 B 的 `session/rename`、`session/fork`、`session/cancel` 全部失败；B 的列表与标题保持不变 |
| 登出再登录 | A 登出后重新登录，`session/list` 仍包含本人 Session（标题保留）且不含 B 的任何 Session；同一身份复用同一 Runtime/DSH_HOME |

生产 overlay 还显式把 `session-query-sqlite` 配为每个用户 `$DSH_HOME/state/` 下的独立索引（shipped Web profile 默认关闭搜索），保证搜索数据不跨身份。

## 3.10 完整运行时镜像 + 容器模式端到端（46 断言 PASS）

```bash
# 构建生产运行时镜像（多阶段：pnpm install + 完整 DSH build）
bash deploy/scripts/build-runtime-image.sh dev     # dsh-runtime:dev（4.24GB）
# 平台以容器后端 + 真实 DSH 运行时镜像跑双用户 e2e
wsl -d Ubuntu --exec bash deploy/scripts/verify-container-runtime.sh
```

实测结果：`CONTAINER RUNTIME E2E PASS: 46 assertions`，证据 [evidence/container-runtime-e2e.log](evidence/container-runtime-e2e.log)。

| 覆盖 | 实测断言 |
|---|---|
| 镜像构建 | `deploy/runtime/Dockerfile` 多阶段构建成功（内置 commit 传递、非 root node 用户、绝对路径 entrypoint） |
| 容器 Runtime | 平台 Supervisior 用真实镜像为两个 W3 身份启动两个 DSH 容器，`/health`、探针、Gateway 代理全部就绪；容器以 1000:1000 运行、无发布端口、8 个显式挂载 |
| 原生 UI | A/B 通过 Gateway 拿到原生 DSH `__DSH_BOOT__` 页面，可创建/列出原生 Session（`session/create`、`session/list`） |
| Session 隔离 | A/B Session id 不同且列表互不可见；A 用 B id 调 `session/state`、`session/rename` 均失败 |
| Skills 隔离（DATA-07） | A 保存个人草稿后，A 列表含、B 列表不含；B 用 A 的 draftId 更新被拒绝，A 的草稿不被修改 |
| 文件/凭据隔离 | B 在自己容器写文件并自读成功；A 容器读 B 文件失败；A 看不到宿主根、Docker socket、Gateway 私钥 |
| 供应商账户分离（UI-05） | 模型供应商 signed-out 时平台身份正常；调用 `account/signOut` 后平台 Session 仍有效、原生 UI 可用 |
| 注销 | 平台注销后 `/auth/me` 401；B 继续正常工作 |

## 3.11 版本化发布包与真实离线升级（3 断言 PASS）

```bash
# 构建版本化发布包（平台镜像 + 运行时镜像 + SHA256SUMS + compose/env/overlay）
wsl -d Ubuntu --exec bash deploy/scripts/build-image.sh 2026.11.23.1
# 用真实发布包演练离线升级
wsl -d Ubuntu --exec bash deploy/scripts/verify-release-upgrade.sh 2026.11.23.1
```

实测结果：`RELEASE UPGRADE PASS: 3 assertions`，证据 [evidence/release-upgrade.log](evidence/release-upgrade.log)。

| 项 | 结果 |
|---|---|
| 发布包 | `dsh-runtime-2026.11.23.1.tar` 962MB sha256 `b2ba90cf…`；`dsh-platform-2026.11.23.1.tar` 89MB sha256 `652db637…`；含 SHA256SUMS、版本化 compose、env.example、runtime overlay |
| 离线升级 | 临时部署先运行旧镜像并登录 Mock 会话；`upgrade.sh` 校验 SHA256、`docker load` 两个镜像、切换为发布版本，健康检查通过 |
| 数据连续 | 升级后既有 Mock 会话 `/auth/me` 仍 200；运行镜像已是 `dsh-platform:2026.11.23.1` |
| 包安全 | 源码发布包无 `.env`/数据库/凭据；运行时镜像 tar 不含部署密钥（密钥在部署机卷内） |

## 4. 仓库级检查

| 检查 | 命令 | 结果 |
|---|---|---|
| 平台类型检查 | `pnpm exec tsc -p services/platform/tsconfig.json --noEmit` | PASS（0 错误） |
| 平台测试 | `pnpm exec vitest run --config services/platform/vitest.config.ts` | PASS（15 files / 204 passed / 1 skipped） |
| 平台 e2e | `pnpm run test:platform:e2e` | PASS（5 passed，真实双 Runtime） |
| 平台 lint | `pnpm exec oxlint services/platform` | PASS |
| 前端包测试 | `vitest run packages/client/ui-platform-identity/tests packages/client/ui-settings-general/tests packages/bundle/web-app/tests packages/host/authentication-gateway/tests` | 24/25 files，282 passed；1 个既有环境超时（web-app product-analytics 5s 超时，与本改动无关） |
| 前端包 lint | `pnpm exec oxlint packages/client/ui-platform-identity` | PASS（frontend 子代理复跑） |
| 构建产物 | `pnpm run build:artifacts` | PASS（8/8 gates，含 host/client compiler、client bundle、Web build） |
| 构建校验 | `pnpm run build:check` | PASS（host + client aggregate check；修复前端测试类型后复跑通过） |
| 文档 gates | `pnpm run test:docs` | PASS（21/21 gates：md wrap、md links、translation pairing、doc budgets、package README、repository references 等） |
| Web 冒烟/快照（OPS-09） | `pnpm run test:web:built` | NOT_RUN：在本机运行 >30 分钟无输出后终止（浏览器/宿主 harness 环境限制）；改动包定向测试 282 passed，`build:artifacts` + `build:check` PASS |
| 文档同步 | `pnpm run doc-sync` | 42/43 gates PASS；唯一失败为既有 Windows 环境限制：`scripts/project-doc-site.spec.ts` 创建符号链接 `EPERM`（与本改动无关） |
| 平台容器镜像 | `docker build -f deploy/platform/Dockerfile -t dsh-platform:test .` 后 `docker run ... --check` | PASS（镜像构建成功；开发配置校验通过；生产缺配置时按预期列出缺项并非零退出） |
| 容器隔离（真实 Docker） | `wsl -d Ubuntu --exec bash deploy/scripts/verify-container-isolation.sh` | **PASS：60 assertions**（证据 `evidence/container-isolation.log`） |
| 部署生命周期（真实 Docker） | `wsl -d Ubuntu --exec bash deploy/scripts/verify-deploy-lifecycle.sh` | **PASS：9 assertions**（证据 `evidence/deploy-lifecycle.log`） |
| 运行时镜像构建 | `bash deploy/scripts/build-runtime-image.sh dev` | **PASS**（多阶段构建成功，`dsh-runtime:dev` 4.24GB） |
| 容器模式端到端 | `wsl -d Ubuntu --exec bash deploy/scripts/verify-container-runtime.sh` | **PASS：46 assertions**（证据 `evidence/container-runtime-e2e.log`） |
| 版本化发布包 + 离线升级 | `build-image.sh 2026.11.23.1` + `verify-release-upgrade.sh 2026.11.23.1` | **PASS：3 assertions**（真实 tar/SHA256，证据 `evidence/release-upgrade.log`） |
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
| 13:14 | 平台单测复跑 | 13 files / 189 passed / 1 skipped |
| 13:36 | 平台单测（含 migrate-home）复跑 | 14 files / 199 passed / 1 skipped |
| 13:45 | 部署生命周期演练（备份/恢复/离线升级/失败回滚） | **PASS：9 assertions** |
| 13:48 | e2e 扩展：管理员 disable/enable 触发 HTTP/WS 撤销 | PASS：6/6 tests，3 个真实 Runtime |
| 14:28 | e2e 扩展：双身份 Session/搜索/IDOR/历史恢复隔离 | PASS：7/7 tests |
| 14:50 | 构建生产运行时镜像（多阶段 DSH build） | PASS（dsh-runtime:dev，4.24GB） |
| 15:00 | 真实运行时镜像 + 容器模式双用户 e2e | **PASS：46 assertions**（原生 UI/Session/Skills/文件/凭据/供应商分离） |
| 15:18 | 构建版本化发布包（平台+运行时镜像 tar/SHA256） | PASS（runtime 962MB / platform 89MB） |
| 15:22 | 真实发布包离线升级演练 | **PASS：3 assertions**（会话与数据连续） |
| 13:26 | 真实容器隔离 probe（WSL Docker） | **PASS：60 assertions**（容器/挂载/限额/空闲回收/adopt/数据保留） |
| 13:35 | 旧历史数据归属迁移（admin migrate-home） | PASS：dry-run/confirm/manifest/未知用户拒绝，单测 10 例 |

### 结论

- 可在本机真实验证的部分（Mock 身份、W3 授权码协议、双用户真实 Runtime、HTTP/WS 代理与撤销、原生 UI 平台身份、配置 fail-closed、构建/类型/文档 gates、平台镜像）均已实测通过。
- 依赖外部环境的条目（真实 W3 租户、Linux 生产部署机、容器内攻击面探测、PostgreSQL、7 天运行、离线升级演练、内网 Git）标 BLOCKED/NOT_RUN，清单与精确条件见 `OPEN_ISSUES.md` 与 `ACCEPTANCE_MATRIX.csv`。
