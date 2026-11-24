# 变更摘要（相对基线的实际改动）

基线：`master`（HEAD 为 `feat(authentication-gateway): verify generation-bound version 2 assertions`）。以下仅列实际写入磁盘的内容；生成物由仓库生成器产生并已核对。

## 1. 新增：平台服务 `services/platform/`

单包多模块的 TypeScript 服务，零第三方运行时依赖（`node:http`/`node:sqlite`/`node:crypto`/`node:child_process`）：

| 文件 | 作用 |
|---|---|
| `src/contracts.ts` | 身份/运行时/网关共享 DTO 与 Service 接口（唯一跨模块契约） |
| `src/config.ts` | 环境配置加载、生产 fail-closed 校验、测试配置工厂、Gateway Ed25519 密钥对生命周期 |
| `src/identity/` | W3/Mock 身份核心：SQLite 版本化迁移、用户/Session/OAuth state 表、安全原语、W3 授权码与 userinfo 客户端、`/auth/*` 与 `/internal/introspect` HTTP 面 |
| `src/runtime/` | Runtime Manager（状态机、generation、幂等 ensure、对账、空闲回收、lease）+ Process/Container Supervisor 后端、空间目录与 HMAC space_key |
| `src/gateway/` | 公网 Gateway：Session/CSRF、Ed25519 v2 断言签发、HTTP/SSE/WS 代理与头清洗、登录页/状态页/CSP、`/api/runtime/*` |
| `src/admin/migrate-home.ts` | 一次性旧数据归属迁移：按 W3 subject/内部 user_id 解析所有者、默认 dry-run、冲突/路径/symlink 防护、写 manifest |
| `src/admin/users.ts` | 管理员用户/会话命令：disable（拒绝认证+撤销会话）、enable、revoke-all，均要求显式 `--confirm` |
| `src/identity/lookup.ts` | 管理命令用的只读身份查询（subject/user_id → PlatformUser） |
| `src/app.ts`, `src/main.ts` | 组合根、进程入口（`--check` 校验模式、SIGINT/SIGTERM 关闭） |
| `tests/` | 13 个 spec / 189 tests（身份、运行时、网关、配置）+ `tests/e2e/` 真实双用户端到端 + `tests/e2e/container-probe.ts` 真实容器隔离 probe（60 断言） |
| `ARCHITECTURE.md`, `README.md`, `package.json`, `tsconfig.json`, `vitest*.config.ts` | 模块文档、脚本与测试配置 |

## 2. 新增：部署 `deploy/`

| 文件 | 作用 |
|---|---|
| `runtime/platform-runtime.patch.yml` | 每用户 DSH Runtime overlay：禁用 `authentication-token`，插入 `authentication-gateway`（固定 subject/generation/公钥，env 表达式）；并把 `session-query-sqlite` 配为每用户 `$DSH_HOME/state/session-query.sqlite`（shipped Web profile 默认关闭内容搜索） |
| `runtime/Dockerfile` | 多阶段构建的 DSH Runtime 镜像（非 root UID，用户数据卷外置）；`runtime/entrypoint.sh` 以绝对路径解析 tsx loader 与 CLI（容器 cwd 是用户工作区，相对路径会解析失败） |
| `tests/probe-runtime/` | 轻量 probe 镜像（只回答就绪探针），用于在真实 Docker 上验证 supervisor 的容器启动策略 |
| `platform/Dockerfile` | 平台服务镜像（Node 24 type-stripping 直接运行 + docker CLI 供 Supervisor 使用） |
| `compose.yml` | 生产编排：唯一公网入口、`/srv/dsh` 同路径挂载、`dsh-private` 私有网络、healthcheck |
| `.env.example` | 全部生产/开发配置项与生产强制项说明 |
| `scripts/{init,build-image,backup,restore,upgrade,rollback,healthcheck,run-dev}.sh`、`run-dev.ps1` | 一键初始化、离线发布、备份/恢复、升级/回滚、健康检查、本地开发 |
| `scripts/verify-container-isolation.sh` | 在 WSL/Linux 内运行真实容器隔离验证（60 断言：挂载/端口/UID/限额/lease/空闲回收/adopt/数据保留） |
| `scripts/verify-deploy-lifecycle.sh` | 部署生命周期演练（9 断言：版本化迁移、备份/恢复、离线镜像升级、失败自动回滚与数据一致性） |
| `scripts/build-runtime-image.sh` | 本地/CI 构建完整运行时镜像（传递 commit、非 root node 用户、绝对路径 entrypoint） |
| `scripts/verify-container-runtime.sh` | 真实运行时镜像 + 容器模式双用户 e2e（46 断言：原生 UI、Session/Skills、文件/凭据、供应商分离、注销） |
| `scripts/verify-release-upgrade.sh` | 用真实版本化发布包演练离线升级（SHA256 校验、双镜像导入、版本切换、既有会话/数据连续） |
| `scripts/verify-agent-isolation.{sh,ps1}` | Keyless Mock LLM 并发 Agent 隔离验证（22 断言：产物、原生 Session 列表、IDOR） |
| `scripts/verify-ws-stream-isolation.{sh,ps1}` | 浏览器内 Session WebSocket 流事件隔离与注销实时撤销（10 断言：只订阅本人、跨用户 not-found、注销关闭 WS） |
| `scripts/verify-job-isolation.{sh,ps1}` | 后台 Job 跨用户隔离（11 断言：A 的 Job 只对 A 可见、B 的 kill 被拒） |
| `scripts/verify-mcp-native.{sh,ps1}` | 原生 MCP stdio 往返（8 断言：用户 profile 配置 MCP server、`mcp__fixtures__add` 执行并回写 Session） |
| `scripts/verify-browser-isolation.{sh,ps1}` | 浏览器自动化跨用户隔离（13 断言：Per-Session Chromium、Cookie 留在本人 Session、B 不见 A 状态） |
| `services/platform/src/runtime/*`、`app.ts` | 显式 `runtimeEnv` 注入（进程后端）：内嵌部署/探针为 Runtime 提供模型端点或测试凭据；容器后端拒绝该注入，宿主敏感环境仍不会隐式继承 |
| `services/platform/src/identity/{store,migrations,http,ratelimit}.ts` | 身份库 migration v2 `dsh_audit_events`；登录/注销/限流/管理员操作审计；按客户端地址的登录滑动窗口限流（429 + Retry-After） |
| `services/platform/src/admin/audit.ts`、`main.ts` | `admin audit list [--limit] [--offset]` 只读输出审计流 |
| `services/platform/src/admin/runtime.ts`、`main.ts` | `admin runtime status (--user|--subject|--all)` 只读输出 Runtime 状态/generation/runtimeId/错误码 |
| `services/platform/src/runtime/manager.ts`、`contracts.ts`、`admin/runtime.ts`、`main.ts` | `admin runtime restart (--user|--subject) --confirm`：容器后端下停止旧实例并启动新 generation，CLI 关闭后容器继续存活供长期平台 adopt |
| `services/platform/src/runtime/support.ts` | 就绪轮询的 sleep 改为 referenced timer：短生命周期 CLI 在等待容器启动时不会因无事件句柄提前退出（`admin runtime restart` 依赖） |
| `deploy/scripts/backup.sh` | 备份快照同时停止/重启用户 Runtime 容器（避免与运行中的 DSH 写入竞争），等待重启完成后再启动 platform 以便 adopt；MANIFEST 记录容器 id 与运行时镜像 |
| `services/platform/src/storage/*`、`identity/{store,migrations,http,lookup}.ts`、`config.ts` | 可插拔身份库：SQLite 与 PostgreSQL（`DSH_PLATFORM_STORAGE`/`DSH_POSTGRES_URL`）共用同步存储门面与版本化迁移；PG 适配器通过 worker 线程桥接 `pg`，主流程保持同步调用 |
| `deploy/platform/Dockerfile`、`services/platform/package.json` | 平台镜像安装 `pg` 驱动；身份库选择由部署环境决定 |
| `.dockerignore` | 排除 `deploy/release`，避免离线发布 tar 被打包进运行时/平台镜像上下文（修复运行时镜像膨胀到 17GB 的问题，重建后回到约 962MB） |
| `services/platform/src/runtime/manager.ts`、`contracts.ts`、`app.ts`、`identity/http.ts` | Runtime 生命周期审计：start/ready/failed/stop 写入身份审计流（`PlatformAuditEvent`、`recordAudit`），审计失败不影响生命周期 |
| `deploy/tests/w3-test-provider.mjs`、`deploy/tests/installed-stack-w3-ab.mjs`、`deploy/scripts/verify-installed-stack-w3-ab.sh` | 可复现的部署机 W3 双身份验证：host W3 测试 Provider、一键安装 W3 模式平台、两账号授权码登录、两个真实 Runtime 容器、Session 隔离与注销撤销 |
| `services/platform/src/admin/cleanup.ts`、`identity/store.ts`、`main.ts` | `admin session cleanup [--retention-days n] [--confirm]`：过期 Session/OAuth state 的 dry-run 计数、确认删除与审计 |
| `deploy/scripts/install.sh` | 一键离线安装：SHA256 校验、双镜像导入、目录/网络/密钥/编排/环境文件、镜像内配置校验、compose 启动与 health 等待；production/local 两种 profile、幂等 |
| `services/platform/src/runtime/space.ts`、`manager.ts` | 容器后端下平台 root 创建的用户空间顶层目录 chown 到运行时容器 uid（默认 1000），修复运行时非 root 无法写挂载目录的生产缺陷 |

## 3. 新增：平台身份前端插件

`packages/client/ui-platform-identity/`：`dsh.client` 客户端插件（平台启动器、运行状态 overlay、`/auth/me` 状态机、CSRF 退出、退出所有设备确认、8 语言字典、README 双语对、tsdown 构建、20+20 个测试）。原生页面与既有功能全部保留。

## 4. 修改（最小接入）

| 文件 | 改动 |
|---|---|
| `packages/client/ui-settings-general/src/client/{shell-contract,SettingsRoot,index}.ts(x)` | 新增并渲染 `settings.platform-launcher` slot（single/root），在原生设置启动器上方渲染平台身份入口 |
| 同包 `tests/{shell.client.spec.ts,settings-root.client.spec.tsx}` | 覆盖新 slot 声明、渲染、owner props 与 `openSettings` 导航 |
| `packages/bundle/web-app/cordis.patch.yml` | 新增 `ui-platform-identity` client 行；平台 overlay 由 `--patch` 追加，不改变默认单用户启动 |
| `packages/bundle/web-app/package.json` | 新增 `@deepseek-ai/dsh-client-ui-platform-identity`、`@deepseek-ai/dsh-host-authentication-gateway` workspace 依赖（后者供运行时 overlay 行解析） |
| `tsconfig.client.json` | 新增新包的 project reference |
| `tsconfig.base.json` | 手写客户端别名区新增新包 path 映射 |
| `package.json`（根） | `start:platform`、`check:platform`、`test:platform`、`typecheck:platform`、`test:platform:e2e` 脚本 |
| `.gitignore` | 忽略 `.dsh-platform/`、`deploy/.env`、`deploy/release/`、`services/platform/evidence/` |
| `.dockerignore`（新增） | 镜像构建上下文排除 node_modules/构建产物/密钥数据 |
| `scripts/translation-pairing.manifest.json` | 排除 `docs/standalone-w3/`（本交付的中文实施记录，按开发包要求以中文维护） |
| 生成物 | `docs/config-catalog{.md,.zh.md}`、`docs/module-graph{.md,.zh.md}`、`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`、`packages/preset/agent-preset/skills/dsh-doc/references/packages.md`、`pnpm-lock.yaml` 由仓库生成器/安装更新 |

## 5. 与开发包设计的关键差异（均已记录在 OPEN_ISSUES/ARCHITECTURE）

1. 身份核心用 TypeScript 重写而非托管 Python sidecar；行为以开发包 Python 实现与原测试逐条对拍。
2. 断言 `sub` 使用内部 `user_id`（Runtime Manager 设同一值），W3 subject 只用于身份库映射。
3. 断言 wire 格式以仓库 verifier 为准（两段），开发包 bridge README 的前缀写法与实现冲突，以 verifier 为准并用真实 Runtime 验证。
4. 身份库默认 SQLite + 版本化迁移；生产可选 PostgreSQL（`DSH_PLATFORM_STORAGE=postgres`），本地实测迁移/Session/审计与备份恢复；运行时注册表保持节点本地 SQLite。
5. 开发/测试使用进程后端（开发包允许）；生产容器后端已实现并由单测覆盖参数与挂载，容器内真实探测需 Linux 部署机复验。
