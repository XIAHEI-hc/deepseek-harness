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
| 账号菜单 | 含“账号信息 / 模型供应商设置 / 退出 DSH / 退出所有设备”（`evidence/platform-account-menu.png`、`evidence/sign-out-all/02-menu.png`） |
| 平台退出 | 回到 `/login`，平台身份入口消失（`evidence/after-platform-logout.png`） |
| 退出所有设备 | 菜单项打开确认对话框（`evidence/sign-out-all/03-confirm.png`）；取消不发请求，确认“Sign out everywhere”后回到 `/login`、旧 Cookie `/auth/me` 401（`evidence/sign-out-all/04-after-sign-out-all.png`、`result.json`） |
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

## 3.12 并发 Agent 文件/会话隔离（DATA-11，22 断言 PASS）

```bash
pwsh -File deploy/scripts/verify-agent-isolation.ps1     # Windows
bash deploy/scripts/verify-agent-isolation.sh            # Linux/WSL
```

实测结果：`AGENT ISOLATION PASS: 22 assertions`，证据 [evidence/agent-isolation.log](evidence/agent-isolation.log)。

做法：平台以脚本化 W3 Provider 启动两个真实 Runtime；两个 headless DSH Agent 并发运行，分别通过脚本化的 Messages 兼容 Mock LLM 获得 `pwsh` 工具调用并写入不同产物。断言：
- 两个 Runtime 均 READY，两个 Agent 退出码 0 且真实执行了工具调用（JSON 事件含 `tool_call`/`tool_result completed`）
- Agent 产物 `artifact-a.txt` 只在 A 工作区、`artifact-b.txt` 只在 B 工作区，互不出现
- 平台原生 `session/list` 各自包含本人 Agent Session、不包含对方 Session
- A 用 B 的 Agent Session id 调 `session/state`、`session/page` 均失败
- A 的产物内容为 A Agent 写入的内容

## 3.13 原生 GUI/Agent 回归（keyless）

| 检查 | 结果 |
|---|---|
| `pnpm run test:gui`（client + host 包全量） | **790 files / 14108 tests passed**，2 skipped；4 个失败全部为 Windows 环境限制（symlink `EPERM`、`pnpm pack ETIMEDOUT`、慢文件系统导致的 5s 超时），均不在本次改动包内 |
| Keyless Agent/Chat（Mock LLM，§3.12） | 原生 Agent Loop、流式事件（`status`/`text`/`tool_call`/`tool_result`）、工具执行与 Session 持久化全部真实运行 |
| 原生 Session/Skills（容器 e2e，§3.10） | `session/create|list|state|page|rename|cancel`、`skillPlaza/saveDraft|drafts` 在真实容器 Runtime 上可用且按身份隔离 |

MCP 与真实模型供应商的聊天回归仍需目标环境凭据，OPS-09 保持 NOT_RUN。

## 3.14 Session WebSocket 事件隔离与实时撤销（DATA-12，10 断言 PASS）

```bash
pwsh -File deploy/scripts/verify-ws-stream-isolation.ps1   # Windows
bash deploy/scripts/verify-ws-stream-isolation.sh          # Linux/WSL
```

实测结果：`WS STREAM ISOLATION PASS: 10 assertions`，证据 [evidence/ws-stream-isolation/](evidence/ws-stream-isolation/)。

做法：两个身份在 Playwright 中分别登录并进入自己的原生 DSH 页面；每个页面在浏览器内通过 Gateway 的 `/api/remote.mux` 打开 `session/follow` 流，订阅本人 Session 事件。

| 断言 | 实测 |
|---|---|
| A 的 Session 流保持打开 | PASS |
| A 通过 Gateway rename 自己的 Session 后，A 的流收到该事件（帧含新标题，`frames=2`） | PASS |
| B 的原生页面从不出现 A 的 Session 标题 | PASS |
| B 用 A 的 sessionId 请求 `session/follow` → `session/not-found` 错误帧（`result.json`） | PASS |
| A 注销后，其 WebSocket 在 Gateway 复验周期内被实时关闭 | PASS |

## 3.15 后台 Job 跨用户隔离（DATA-08，11 断言 PASS）

```bash
pwsh -File deploy/scripts/verify-job-isolation.ps1   # Windows
bash deploy/scripts/verify-job-isolation.sh          # Linux/WSL
```

实测结果：`JOB ISOLATION PASS: 11 assertions`，证据 [evidence/job-isolation/](evidence/job-isolation/)。

做法：平台通过显式 `runtimeEnv` 把脚本化 LLM 注入进程 Runtime；A 选中模型后提交 prompt，脚本化模型调用 shell 工具的 `run_in_background`，在 A 的 Runtime 里注册真实后台 Job。两个身份随后通过 Gateway 的 `job/list` 流读取各自 Job 列表。

| 断言 | 实测 |
|---|---|
| A 读取模型目录并选择模型 | PASS |
| A 的 Agent 通过 shell 工具注册后台 Job（tool result 给出 Job id） | PASS |
| A 的 `job/list` 流包含该 Job | PASS |
| B 的 `job/list` 流不包含 A 的 Job | PASS |
| B 用 A 的 Job id 调 `job/kill` 被拒绝 | PASS |
| A 可以终止自己的 Job | PASS |

Goal/Workflow 没有跨 Runtime 的寻址端点，其隔离边界与 Session 相同（A 无法寻址 B 的 Session，见 DATA-02/03/12）。

## 3.16 原生 MCP 往返（OPS-09 MCP 子项，8 断言 PASS）

```bash
pwsh -File deploy/scripts/verify-mcp-native.ps1   # Windows
bash deploy/scripts/verify-mcp-native.sh          # Linux/WSL
```

实测结果：`MCP NATIVE PASS: 8 assertions`，证据 [evidence/mcp-native/](evidence/mcp-native/)。

做法：平台通过显式 `runtimeEnv` 注入脚本化 LLM；探针在用户 DSH home 的 web profile patch 中配置一个 stdio MCP server（仓库自带 fixture server，`mcp__fixtures__add`），再让该用户 Runtime 启动。脚本化模型调用该 MCP 工具后，断言工具结果写回 Session。

| 断言 | 实测 |
|---|---|
| 用户 web profile 成功配置 stdio MCP server | PASS |
| Runtime 在 MCP manager 配置下启动并就绪 | PASS |
| 通过 Gateway 创建 Session、读取模型目录、选择模型 | PASS |
| 模型面向工具名为 `mcp__fixtures__add` | PASS |
| MCP server 真实执行 `add(2,3)` 并把 `5` 返回模型回合 | PASS |

至此 OPS-09 的原生聊天/Agent Loop、Session、Skills、MCP 四类能力均由 keyless 真实运行覆盖；真实模型供应商通路未改，凭据相关 e2e 仍属目标环境项。

## 3.17 浏览器自动化：原生往返与跨用户上下文隔离（DATA-10，13 断言 PASS）

```bash
pwsh -File deploy/scripts/verify-browser-native.ps1     # 单用户原生往返（8 断言）
pwsh -File deploy/scripts/verify-browser-isolation.ps1   # 双用户上下文隔离（13 断言）
```

实测结果：`BROWSER NATIVE PASS: 8 assertions`、`BROWSER ISOLATION PASS: 13 assertions`，证据 [evidence/browser-native/](evidence/browser-native/)、[evidence/browser-isolation/](evidence/browser-isolation/)。

做法：两个用户的 DSH home web profile 各配置 Playwright MCP browser-use provider（launch + 本机 Chromium 可执行文件），平台注入脚本化 LLM；A 在同一 Session 两次导航同一探针页，该页把请求 Cookie 状态写进页面标题；B 随后首次导航同一页。

| 断言 | 实测 |
|---|---|
| Runtime 在 browser-use provider 配置下启动，Session 初始化浏览器 MCP 连接 | PASS |
| 模型面向工具名 `mcp__playwright-mcp__browser_navigate`，Per-Session Chromium 真实导航 | PASS |
| A 首次访问 `probe-cookie-none`，第二次访问 `probe-cookie-yes`（A 的浏览器 Cookie 在自身 Session 内保持） | PASS |
| B 首次访问 `probe-cookie-none`（A 的浏览器状态不会到达 B） | PASS |
| 两个身份的原生页面均保持可用 | PASS（截图 `a-native-page.png`、`b-native-page.png`） |

## 3.18 身份审计与登录限流（生产硬化，实测）

证据 [evidence/admin-audit.log](evidence/admin-audit.log)。

- 身份库 migration v2 新增 `dsh_audit_events`（action/outcome/user_id/subject/client_address/detail + 索引）；`schema_migrations` 实测为 `1,2`。
- 登录失败限流：`AUTH_LOGIN_RATE_LIMIT_MAX=2` 时同一地址连续三次 `GET /auth/login` 得到 `302,302,429`，429 带 `Retry-After` 并写入一条 `login/rate-limited` 审计；换地址仍可登录。
- 审计覆盖：登录成功（mode=detail）/拒绝/限流、注销、全设备注销、`admin.user.disable|enable`、`admin.session.revoke_all`；不含 Cookie/token/CSRF/W3 token。
- `admin audit list --limit 10` 实测输出 JSON 行（含限流与登录记录）。
- 单元测试：平台 **209 passed / 1 skipped**，新增审计与限流用例（身份 Mock、管理操作、迁移版本）。

## 3.19 管理端 Runtime 状态只读查询（实测）

证据 [evidence/admin-runtime.log](evidence/admin-runtime.log)。

- `admin runtime status --all` 读取 Supervisor 的 `runtime.sqlite`，输出 userId/state/desiredState/generation/runtimeId/imageDigest/lastErrorCode/lastActivityAt/updatedAt。
- 实测打开一个用户 Runtime 后输出 `state=READY, generation=1, runtimeId=proc-…`。
- 选择器支持 `--user`、`--subject`、`--all`；缺省/歧义/未知选择器返回 2 与明确错误；单元测试覆盖四种情况。
- 强制重启子命令仍待补（OPEN_ISSUES）。

## 3.20 过期身份数据清理（实测）

证据 [evidence/admin-cleanup.log](evidence/admin-cleanup.log)。

- `admin session cleanup` 默认 dry run：实测 `sessions=2, oauthStates=1, applied=false`（retention 7 天，行生命周期已过 30 天）。
- `admin session cleanup --confirm` 删除同样行并写 `admin.session.cleanup` 审计（含 cutoff/retention/删除计数）。
- 删除谓词只覆盖“已过期/已撤销且早于 cutoff”的 session 与“已过期/已消费早于 cutoff”的 login transaction；活跃 session 不受影响。
- 单元测试覆盖 dry-run、确认删除、审计行与非正 retention 拒绝。

## 3.21 一键离线安装 + 部署机冒烟（实测）

证据 [evidence/install-smoke.log](evidence/install-smoke.log)。

- 构建机产出 `2026.11.23.2` 发布包（平台镜像 89MB、运行时镜像 2.0GB、SHA256SUMS、compose/env/overlay）。
- 部署机（WSL2 Ubuntu + Docker 29.7.2）执行 `bash deploy/scripts/install.sh --version 2026.11.23.2 --profile local --port 18080`：SHA256 校验 → 导入镜像 → 创建 `/srv/dsh`、`dsh-private`、Gateway 密钥、生成 Mock 冒烟 `.env` → 镜像内 `--check` → compose up → health 就绪。
- Mock 登录后访问原生 UI：`runtime=READY`、`native_boot=present`；Supervisor 以 `dsh-runtime:2026.11.23.2` 启动 1 个用户容器 `dsh-rt-…`；同身份再次访问容器数保持 1（复用实例）。
- **安装演练发现并修复的生产缺陷**：平台容器以 root 创建用户空间目录时，运行时容器（uid 1000）无法写 `/data/tmp`（`EACCES`）。修复为：容器后端下，Supervisor 创建空间顶层目录后 chown 到 `DSH_RUNTIME_CONTAINER_UID`（默认 1000）；重新构建发布包后同一冒烟通过。单元测试 216 passed。
- 幂等性：重复执行 install.sh 保留现有 `.env`/密钥/用户卷，仅补缺失项并以当前发布版本重建容器。

## 3.22 管理端强制重启 Runtime（容器后端，实测）

证据 [evidence/admin-runtime-restart.log](evidence/admin-runtime-restart.log)。

- `admin runtime restart (--user|--subject) --confirm`：容器后端下停止当前实例并启动新 generation；process 后端明确拒绝（单元测试）。
- 容器化部署在 platform 容器内执行（CLI 关闭后新容器继续运行，长期平台在下次请求 adopt 新 generation）：

  ```bash
  docker exec dsh-platform-platform-1 node services/platform/src/main.ts admin runtime restart --user <id> --confirm
  ```

- 实测（2026.11.23.4 发布包）：restart 前 READY，执行后新 generation READY，容器名不变（确定性 space 命名）、imageDigest 更新为当前发布版本，原生 UI `__DSH_BOOT__` 仍可用。
- 演练还发现并修复：就绪轮询的 `sleep` 使用 unref 计时器，短生命周期 CLI 会在等待容器启动时因无事件句柄提前退出；改为 referenced timer 后 restart 稳定完成。平台单测 **219 passed / 1 skipped**。

## 3.23 部署机备份一致性 + 真实发布包离线升级（v3 → v4，实测）

证据 [evidence/backup-upgrade-rehearsal.log](evidence/backup-upgrade-rehearsal.log)。

- 安装 2026.11.23.3 发布包，Mock 登录并打开真实用户 Runtime；创建并改名 Session `upgrade-preserved-title`。
- 备份：`backup.sh pre-upgrade-v4` 在快照期间同时停止 platform 与用户 Runtime 容器（新增一致性修复），备份 `management.tar.gz`、每用户空间 tar、SHA256SUMS、MANIFEST（记录 runtime 容器 id）；结束后按原 id 重启 Runtime、再启动 platform，platform 成功 adopt（runtime 保持 READY，无 FAILED 竞态）。
- 离线版本切换：`install.sh --version 2026.11.23.4` 从离线发布包导入/切换（保留 `.env`、密钥、用户卷），health 通过。
- 数据连续性：升级后旧 Cookie `/auth/me=200`，`session/list` 正常，原 Session 与标题 `upgrade-preserved-title` 保留，原生 UI `__DSH_BOOT__` 可用。
- Runtime 升级：platform 先 adopt 旧 `dsh-runtime:2026.11.23.3` 容器（READY generation 1）；执行 `admin runtime restart` 后新 generation READY 且 imageDigest 更新为 `dsh-runtime:2026.11.23.4`，Session 历史仍在。
- 备份 MANIFEST 实测：`runtime_containers` 记录 2 个用户容器 id、`spaces=1`。

## 3.24 部署机安装栈 W3 双身份 A/B 隔离（实测）

证据 [evidence/install-w3-ab.log](evidence/install-w3-ab.log)。验证脚本：`deploy/scripts/verify-installed-stack-w3-ab.sh`（host 测试 W3 Provider + 发布包一键安装 + 两账号授权码登录 + 真实 Runtime 容器）。

- 平台以 `AUTH_MODE=w3`、container 后端从 2026.11.23.4 发布包安装；两个不同 W3 账号分别完成授权码回调。
- `/auth/me` 返回不同 userId 与真实姓名：`User A`、`User B`。
- 两个账号各自启动独立的 `dsh-runtime:2026.11.23.4` 用户容器（不同 `dsh-rt-*` 名称），Runtime 均 READY。
- Session 隔离：A 的 `session/list` 不含 B 的 Session，反之亦然；A 读取 B 的 Session 被拒绝（`crossStateOk=false`）。
- 原生 UI：两个账号各自返回 `__DSH_BOOT__` 页面。
- 注销与撤销：A 注销返回 200，随后 A `/auth/me=401`；B `/auth/me=200` 且原生 UI 仍可用（同一身份多窗口/其他用户不受影响）。
- 真实 W3 租户（AUTH-24）仍 BLOCKED；本项使用仓库内 W3 测试 Provider 验证协议与部署拓扑，不冒称真实登录。

## 3.25 PostgreSQL 身份库后端（本地实测）

- 新增 `DSH_PLATFORM_STORAGE=sqlite|postgres` 与 `DSH_POSTGRES_URL`；身份/会话/OAuth state/审计表与版本化迁移在 PostgreSQL 上执行，SQLite 仍为默认开发/单机后端。
- PostgreSQL 适配器通过 worker 线程桥接 `pg`，身份 store 与迁移代码保持同步调用；`BEGIN IMMEDIATE`/`PRAGMA`/`rowid` 等 SQLite 方言差异由适配器与 store 分支处理。
- 单元/集成：`services/platform/tests/identity.postgres.spec.ts` 在 `DSH_TEST_POSTGRES_URL` 指向真实 PostgreSQL 时运行（本地 PostgreSQL 16 容器）：登录、`/auth/me`、session 解析、审计行、服务重启后 session 仍有效、注销后 session 失效；合计平台测试 **222 passed / 1 skipped**（启用 PG 时）。
- 备份/恢复脚本新增 PostgreSQL 分支：`pg_dump --clean --if-exists` → `postgres-identity.sql.gz`（SHA256），恢复时 `psql` 回放；要求部署机安装 postgresql-client。
- 部署机安装栈实测（2026.11.23.5 发布包）：平台以 `DSH_PLATFORM_STORAGE=postgres` 启动，Mock 登录后 `/auth/me=200`，身份行出现在 PostgreSQL `dsh_users`；用户 Runtime 容器 READY，原生 UI 可用（evidence/postgres-installed-stack.log）。`backup.sh` 生成 `postgres-identity.sql.gz` + SHA256，`restore.sh` 用 `psql` 回放；恢复后备份前 Session=200、备份后新建 Session=401、Runtime 重新分配 generation 至 READY、原生 UI 可用（evidence/postgres-backup-restore.log）。
- 证据：`evidence/postgres-identity.log`（PG 测试运行 + 连接信息脱敏）、`evidence/postgres-installed-stack.log`、`evidence/postgres-backup-restore.log`；目标环境托管 PostgreSQL 连接信息仍属部署时配置。

## 3.26 发布镜像构建上下文修复

- 演练发现构图上下文包含 `deploy/release/*.tar`，运行时镜像一度膨胀到 17GB、镜像 tar 达 17GB；`.dockerignore` 增加 `deploy/release` 后重建，运行时镜像 tar 恢复为 **962MB**、平台镜像 90MB，发布包 SHA256 重新生成。
- 平台镜像改为按 `services/platform/package-lock.json` 执行 `npm ci --omit=dev`，PostgreSQL 驱动安装可复现。

## 3.27 最终发布包验证（2026.11.23.7）

证据 [evidence/release-manifest-2026.11.23.7.txt](evidence/release-manifest-2026.11.23.7.txt)、[evidence/final-release-2026.11.23.7.log](evidence/final-release-2026.11.23.7.log)；前一版 2026.11.23.6 的清单与冒烟记录保留在同目录。

- 从提交 `74874c12b4` 重新构建：`dsh-runtime-2026.11.23.7.tar`（1,008,221,696 bytes，sha256 `02a36530…`）、`dsh-platform-2026.11.23.7.tar`（93,329,408 bytes，sha256 `32308213…`），含 `SHA256SUMS`、compose、env 模板、runtime overlay。
- 平台镜像内置 PostgreSQL 驱动（镜像内 `require.resolve('pg')` 指向 `/app/services/platform/node_modules/pg/lib/index.js`），核验 PG 后端在发布包中可用。
- 部署机一键安装 v7 后：Mock 登录 302、`/auth/me=200`、用户 Runtime READY、原生 UI `__DSH_BOOT__`、Runtime 容器 `dsh-runtime:2026.11.23.7`；`admin audit list` 可见 `runtime.start`/`runtime.ready`（generation 1、容器 runtimeId）。
- 发布包不包含 `deploy/release` 历史 tar（构建上下文已排除），镜像尺寸稳定为平台约 93MB、运行时约 1.0GB。

## 3.28 Runtime 生命周期审计（实测）

证据 [evidence/runtime-audit.log](evidence/runtime-audit.log)。

- `RuntimeManager` 新增审计 sink，生命周期迁移写入身份审计流（`dsh_audit_events`）：`runtime.start`、`runtime.ready`、`runtime.failed`（含错误码）、`runtime.stop`（reaper/restart 停止）。
- 平台组合层把 sink 接到 `IdentityService.recordAudit`；审计投递失败只记日志，不影响 Runtime 生命周期。
- 实测（Mock/process）：打开 Runtime 后 `admin audit list` 可见 `runtime.start`（generation 1）与 `runtime.ready`（generation 1、runtimeId、errorCode=null），与登录审计同表可查。
- 单元测试覆盖 start/ready/stop 审计记录；平台测试 220 passed / 4 skipped（PG 集成测试默认跳过）。

## 3.29 最终安装栈 W3 浏览器 A/B 姓名验证（实测）

证据 [evidence/browser-w3-installed.log](evidence/browser-w3-installed.log)、截图 [identity-a.png](evidence/browser-w3-installed/identity-a.png)、[identity-b.png](evidence/browser-w3-installed/identity-b.png)。

- 部署机安装 2026.11.23.7 发布包，`AUTH_MODE=w3`，W3 测试 Provider 对浏览器暴露 `authorize`、对平台容器暴露 `token/userinfo`。
- 本机 Windows Chromium（Playwright）以两个独立浏览器上下文完成 W3 授权码登录：`User A` 与 `User B`。
- 左下角平台 launcher 实测文本分别是 `U User A W3 · uid-a` 与 `U User B W3 · uid-b`；`/auth/me` 返回两个不同内部 userId。
- 两个身份各自启动独立 `dsh-runtime:2026.11.23.7` 容器，Runtime 均 READY；平台审计流出现各自的 `runtime.start`/`runtime.ready`。
- 真实 W3 租户（AUTH-24）仍 BLOCKED；本项使用仓库内 W3 测试 Provider 验证最终发布包 + 浏览器呈现，不冒称真实租户登录。

## 3.30 多窗口复用、共享历史与 platform 重启恢复（最终安装栈，实测）

证据 [evidence/reuse-restart.log](evidence/reuse-restart.log)。

- 安装 2026.11.23.7，`AUTH_MODE=w3`、`W3_TOKEN_REQUEST_FORMAT=form`（同时验证 W3 form token 模式在最终发布包可用）。
- 同一 W3 账号开两个浏览器上下文：`/auth/me` 返回同一内部 userId，两个窗口共享同一 Runtime 容器与 Session 历史（A1 创建/改名 `shared-history-title`，A2 的 `session/list` 可见）。
- 第二个 W3 账号得到不同 userId、独立 Runtime 容器，`session/list` 不含 A 的 Session。
- 实测容器数 2（A 与 B 各一），不是每窗口一实例。
- `docker restart dsh-platform-platform-1` 后：health 恢复、旧 Session Cookie 仍有效、Session 历史仍在、Runtime 重新 READY、左下角仍显示 `U User A W3 · uid-a`。

## 3.31 最终 HEAD 回归探针（实测）

证据 [evidence/final-probes.log](evidence/final-probes.log)。

在最终提交上重跑 keyless 原生能力探针，确认审计/存储改动未回归既有隔离：

| 探针 | 结果 |
|---|---|
| 并发 Agent 文件/Session 隔离 | **PASS：22 assertions** |
| WebSocket 流隔离 + 注销实时撤销 | **PASS：10 assertions** |
| 后台 Job 跨用户隔离 | **PASS：11 assertions** |
| 原生 MCP stdio 工具往返 | **PASS：8 assertions** |
| 浏览器自动化原生往返 | **PASS：8 assertions** |
| 跨用户浏览器上下文隔离 | **PASS：13 assertions** |

## 3.32 最终发布包安全/隔离/空闲回收演练（实测）

证据 [evidence/final-security-drill.log](evidence/final-security-drill.log)。

- 旧启动入口：未认证 `/?token=legacy` 返回 302 到登录；`Authorization: Bearer` 访问 `/api/runtime/me` 返回 401；直接访问用户 Runtime 的 `?token=legacy` 与无断言请求均为 401（runtime overlay 已禁用 authentication-token）。
- 用户容器：`User=1000:1000`，CPU 1 core、内存 2GB、pids 512，仅加入 `dsh-private`，无发布端口。
- 挂载仅 8 项：6 个用户空间目录（可写）+ Gateway 公钥（只读）+ runtime overlay（只读）；无 Docker socket、无宿主根目录、无 Gateway 私钥。
- 容器环境只含公钥路径与断言事实（issuer/audience/kid/时间窗），无平台数据库/会话/私钥变量。
- 空闲回收：`DSH_RUNTIME_IDLE_SECONDS=8` 后 Runtime 自动 STOPPED、容器停止；用户空间目录全部保留；下一次请求从持久化空间重新启动并 READY。

## 3.33 源码发布包（实测）

证据 [evidence/source-release-2026.11.23.7.log](evidence/source-release-2026.11.23.7.log)。

- `make-source-release.sh 2026.11.23.7` 生成 `dsh-platform-source-2026.11.23.7.tar.gz`：1,232,525 bytes、473 条目、sha256 `9c3fb407…`。
- 内容：`services/platform`、`deploy`、`docs/standalone-w3`、平台身份前端插件与 Web bundle 接线文件；**不含** `.env`、`identity.sqlite`、`runtime.sqlite` 或凭据。
- 校验文件独立为 `SHA256SUMS-source-2026.11.23.7`，不会覆盖镜像包的 `SHA256SUMS-2026.11.23.7`。
- 交付入口与部署/运维命令见 [HANDOFF.md](HANDOFF.md)。

## 4. 仓库级检查

| 检查 | 命令 | 结果 |
|---|---|---|
| 平台类型检查 | `pnpm exec tsc -p services/platform/tsconfig.json --noEmit` | PASS（0 错误） |
| 平台测试 | `pnpm exec vitest run --config services/platform/vitest.config.ts` | PASS（18 files / 220 passed / 4 skipped；启用 PostgreSQL 时 222 passed / 1 skipped） |
| 平台 e2e | `pnpm exec vitest run --config services/platform/vitest.e2e.config.ts` | PASS（7 passed，真实双 Runtime） |
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
| 并发 Agent 隔离 | `pwsh -File deploy/scripts/verify-agent-isolation.ps1` | **PASS：22 assertions**（证据 `evidence/agent-isolation.log`） |
| 原生 GUI 回归 | `pnpm run test:gui` | 14108 passed / 4 Windows 环境失败（证据 `evidence/gui-regression.log`） |
| Session WebSocket 隔离与撤销 | `pwsh -File deploy/scripts/verify-ws-stream-isolation.ps1` | **PASS：10 assertions**（证据 `evidence/ws-stream-isolation/`） |
| 后台 Job 跨用户隔离 | `pwsh -File deploy/scripts/verify-job-isolation.ps1` | **PASS：11 assertions**（证据 `evidence/job-isolation/`） |
| 原生 MCP 往返 | `pwsh -File deploy/scripts/verify-mcp-native.ps1` | **PASS：8 assertions**（证据 `evidence/mcp-native/`） |
| 浏览器自动化隔离 | `pwsh -File deploy/scripts/verify-browser-isolation.ps1` | **PASS：13 assertions**（证据 `evidence/browser-isolation/`） |
| 源码发布包 | `deploy/release/dsh-platform-source-2026.11.23-dev.tar.gz` | PASS（541,465 bytes，sha256 37f4da64…d44a3；173 条目，无 `.env`/数据库/凭据；含 `.env.example`） |
| 仓库 lint | `pnpm run lint` | 失败项全部为**既有文件**（`skill-plaza`、`authentication-gateway` 测试、`workspace-controller`、`ui-skill-plaza` 测试），无新代码文件；`pnpm exec oxlint services/platform packages/client/ui-platform-identity` 0 问题 |

### 4.1 与本改动无关的既有红

- `verify-cordis-config`：`apps/cli/tests/profiles/acp/cordis.yml: root must be a Loader entry array`（仓库既有测试夹具指向 snapshot，与平台改动无关）。
- `verify-client-domain-graph`：`ui-workspace` 既有 sibling import（frontend 子代理报告，与本包无关）。
- `apps/web`/client 全量回归中 2 个环境失败：`ui-sidebar-documentpreview` 的 `pnpm.exe ETIMEDOUT`（Windows 本机 pnpm 超时）。
- `doc-sync` 的 `scripts/project-doc-site.spec.ts` 在 Windows 上创建测试符号链接失败（`EPERM`），属于宿主机权限限制。

## 5. BLOCKED / NOT_RUN

当前矩阵：**PASS 81 / NOT_RUN 0 / BLOCKED 3**；PostgreSQL 身份库后端已实现并本地实测。

| ID | 状态 | 原因 |
|---|---|---|
| AUTH-24 | BLOCKED | 无真实 W3 租户凭据与回调白名单；Mock/脚本化 W3 不替代真实登录 |
| OPS-08 | BLOCKED | 需要 7 天真实运行窗口 |
| OPS-10 | BLOCKED | 无内网 Git 地址与凭据 |
| PostgreSQL 生产库 | PASS（本地实测；目标托管 PG 待连接配置） | 身份库可选 PostgreSQL 后端，迁移/Session/审计实测通过；备份脚本含 pg_dump/psql 分支 |

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
| 15:29 | 原生 GUI 回归 `pnpm run test:gui` | 14108 passed，4 个 Windows 环境失败 |
| 15:35 | 并发 Agent 文件/会话隔离（Mock LLM） | **PASS：22 assertions** |
| 15:48 | 浏览器验收“退出所有设备”确认流程 | **PASS**（截图 `evidence/sign-out-all/`，确认后旧 Cookie 401） |
| 16:10 | 浏览器 WebSocket 流事件隔离与注销实时撤销 | **PASS：10 assertions**（证据 `evidence/ws-stream-isolation/`） |
| 16:38 | 后台 Job 跨用户隔离（Mock LLM 驱动真实 Runtime） | **PASS：11 assertions**（证据 `evidence/job-isolation/`） |
| 16:58 | 原生 MCP stdio 工具往返（Mock LLM + 真实 Runtime） | **PASS：8 assertions**（证据 `evidence/mcp-native/`） |
| 17:58 | 浏览器自动化原生往返 + 双用户上下文隔离（真实 Chromium） | **PASS：8 + 13 assertions**（证据 `evidence/browser-native/`、`browser-isolation/`） |
| 18:15 | 身份审计表 + 登录限流 + `admin audit list` | PASS（429/Retry-After + 审计行，证据 `evidence/admin-audit.log`） |
| 18:22 | 管理端 Runtime 状态只读查询 `admin runtime status` | PASS（证据 `evidence/admin-runtime.log`） |
| 18:30 | 过期身份数据清理 `admin session cleanup`（dry-run + confirm + 审计） | PASS（证据 `evidence/admin-cleanup.log`） |
| 18:48 | 一键离线安装 + 部署机真实容器 Runtime 冒烟（2026.11.23.2） | PASS（修复空间目录属主缺陷后，证据 `evidence/install-smoke.log`） |
| 19:55 | 管理端强制重启 Runtime（2026.11.23.4，容器后端） | PASS（新 generation + 原生 UI，证据 `evidence/admin-runtime-restart.log`） |
| 20:12 | 部署机备份一致性 + 真实发布包离线升级 v3→v4 | PASS（Session/标题保留、Runtime adopt + 重启到新镜像，证据 `evidence/backup-upgrade-rehearsal.log`） |
| 20:31 | 部署机安装栈 W3 双身份 A/B（测试 Provider + 2 个真实 Runtime 容器） | PASS（姓名/隔离/注销撤销，证据 `evidence/install-w3-ab.log`） |
| 21:05 | PostgreSQL 身份库后端（本地 PostgreSQL 16） | PASS（迁移/登录/Session/审计/重启保持，证据 `evidence/postgres-identity.log`） |
| 22:20 | 最终发布包 2026.11.23.7 安装、冒烟与 Runtime 审计 | PASS（PG 驱动内置、Mock 登录、Runtime READY、原生 UI，证据 `evidence/release-manifest-2026.11.23.7.txt`、`evidence/final-release-2026.11.23.7.log`） |
| 22:05 | Runtime 生命周期审计（start/ready/failed/stop） | PASS（证据 `evidence/runtime-audit.log`） |
| 22:28 | 最终安装栈 W3 浏览器 A/B 左下角姓名 | PASS（Windows Chromium，User A/User B，证据 `evidence/browser-w3-installed.log` 与截图） |
| 22:35 | 多窗口复用、共享历史、platform 重启恢复（W3 form token） | PASS（同身份同用户同 Runtime、重启后 Session/姓名/Runtime 仍有效，证据 `evidence/reuse-restart.log`） |
| 22:45 | 最终 HEAD 回归探针（Agent/WS/Job/MCP/Browser） | PASS：22+10+11+8+8+13 assertions（证据 `evidence/final-probes.log`） |
| 22:52 | 最终发布包安全/挂载/空闲回收演练 | PASS（旧 token 401、8 挂载无 socket、uid1000、空闲停止后空间保留并可重启，证据 `evidence/final-security-drill.log`） |
| 22:58 | 源码发布包（无 .env/数据库/凭据） | PASS（473 条目、1,232,525 bytes、sha256 `9c3fb407…`，证据 `evidence/source-release-2026.11.23.7.log`） |
| 13:26 | 真实容器隔离 probe（WSL Docker） | **PASS：60 assertions**（容器/挂载/限额/空闲回收/adopt/数据保留） |
| 13:35 | 旧历史数据归属迁移（admin migrate-home） | PASS：dry-run/confirm/manifest/未知用户拒绝，单测 10 例 |

### 结论

- 可在本机真实验证的部分（Mock 身份、W3 授权码协议、双用户真实 Runtime、HTTP/WS 代理与撤销、原生 UI 平台身份、配置 fail-closed、构建/类型/文档 gates、平台镜像）均已实测通过。
- 依赖外部环境的条目（真实 W3 租户、Linux 生产部署机、容器内攻击面探测、7 天运行、内网 Git）标 BLOCKED；PostgreSQL 身份库后端已实现并在本地真实 PostgreSQL 16 上完成迁移/登录/Session/备份恢复演练。
