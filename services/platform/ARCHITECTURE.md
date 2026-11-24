# DSH 多用户平台服务架构（实施基准）

本目录实现开发包 `DSH_Standalone_W3_MultiUser_DevPack_v1.0` 要求的独立多用户平台服务。
代码全部属于 DSH 仓库自身，不依赖任何外部业务系统；W3 仅作为身份提供方。

## 1. 组成

```
services/platform/
  src/contracts.ts      # 跨模块共享类型（lead 维护，其他人只读）
  src/config.ts         # 启动配置加载与校验（lead 维护，其他人只读）
  src/identity/         # W3/Mock 身份核心：用户、Session、OAuth state、CSRF、SQLite 迁移、/auth/* 与 /internal/*
  src/runtime/          # Runtime Manager + Supervisor：注册表、状态机、幂等 ensure、进程/容器后端、空间目录、空闲回收
  src/gateway/          # 公网网关：Session 校验、Ed25519 v2 断言、HTTP/SSE/WS 代理、登录页、/api/runtime/*
  src/integration/      # 可选系统融合：配置/预检、只读 Adapter、快照、工作区、分析 Job、/api/integration/*
  src/app.ts            # 组合 identity + runtime + integration + gateway（lead 维护）
  src/main.ts           # 进程入口（lead 维护）
  tests/                # vitest 测试（各模块自己的 *.spec.ts）
deploy/                 # compose、Dockerfile、运行时 overlay、部署/升级/回滚脚本
docs/standalone-w3/     # 基线、架构、测试、安全、部署、回滚与验收证据
```

浏览器访问的唯一入口是 Gateway。Gateway 认证浏览器 Session 后，按 `user_id` 选择该用户独立的
DSH Runtime，把 HTTP/SSE/WebSocket 原样代理过去，并附加短 TTL 的 Ed25519 v2 身份断言。
Runtime 内部仍是 DSH 原生单 Owner Peer（`authentication-gateway` 插件），但每个 Runtime
只属于一个 DSH 用户，且只接受该用户 subject + generation 的断言。

## 2. 身份与信任边界

1. 浏览器 → Gateway：Cookie 服务端查库；`/auth/*`、`/api/runtime/*` 由平台处理，其余全部代理。
2. Gateway → Identity：同进程模块调用（`IdentityService` 接口），不暴露公网。
3. Gateway → Runtime：私网/回环连接，清理浏览器 Cookie/Authorization/`x-*` 身份头后附加断言。
4. Runtime → 文件系统：每用户独立空间目录（进程后端）或独立容器 + 卷（生产后端）。
5. 浏览器永远不能直接访问 Runtime 端口；任何用户传入的 user_id/runtime_id/路径都不参与路由。

断言格式以仓库现实现为准（`packages/host/authentication-gateway/src/assertion.ts` 的 verifier）：
线上 header 值只有两段 `<base64url(payload)>.<base64url(Ed25519 签名)>`；被签名的 canonical 消息是
`dsh-gateway-identity.2.<base64url(payload)>`。开发包 `source/bridge_examples/README.md` 把前缀写成 header
的一部分，与仓库 verifier 冲突，**以 verifier 为准**（已用真实 Runtime 冒烟验证：带该断言请求返回原生 UI 200，
不带断言返回 401）。载荷 `{v:2,iss,aud,sub,sid,pv,gen,iat,exp,jti,kid}` 中 `sub` 使用内部 DSH `user_id`
（不是 W3 subject）；Runtime Manager 把同一 `user_id` 作为 `DSH_RUNTIME_SUBJECT`。Gateway 只持有私钥，
Runtime 只读取公钥文件。

## 3. 模块契约（src/contracts.ts）

- `IdentityService`：`handle(request)` 处理 `/auth/*` 与 `/internal/*`，其他路径返回 `undefined`；
  `authenticate(token)` 返回 `SessionLookup`；`verifyCsrf(...)`；`close()`。
- `RuntimeManager`：`ensure(userId)` 幂等返回 `RuntimeEnsureResult`（READY 时带私有 `target`）；
  `retry/status/touch/lease/close`。
- 共享 DTO：`PlatformUser`、`ValidatedSession`、`SetCookie`、`PlatformHttpRequest/Result`、
  `RuntimeState/RuntimeStatusView/RuntimeTarget`。所有跨模块数据只能使用这些类型。

`src/config.ts` 提供 `loadPlatformConfig(env)`（生产校验，缺项快速失败）与
`createPlatformConfig(overrides)`（测试/嵌入用）。身份、运行时、网关都从对应子配置读参数，
不得自行读取 `process.env`（运行时后端启动子进程时除外）。

## 4. 每个 Runtime 的启动约定

进程后端（开发/测试）：

```
<processCommand...> web --patch <DSH_RUNTIME_PATCH_FILE> --no-open \
  --host 127.0.0.1 --port <分配端口> --public-url <DSH_GATEWAY_PUBLIC_URL> \
  --trusted-host <publicAuthority>
```

容器后端（生产）：同一命令在用户容器内执行，`--host <容器 IP>`，端口不对外发布；容器内 cwd 是用户工作区，
所以镜像入口 `deploy/runtime/entrypoint.sh` 用绝对路径解析 tsx loader 与 DSH CLI（`/app/node_modules/tsx/...`、
`/app/apps/cli/src/bin.ts`），Supervisor 追加 `web --patch ... --host --port ...` 参数。容器只挂载该用户的空间目录
（读写）与 Gateway 公钥（只读），不挂 Docker socket、宿主 root、Gateway 私钥或平台数据库。
空间目录结构：`<root>/<space_key>/{dsh-home,home,agents-home,workspaces,uploads,tmp}`。
生产平台容器以 root 运行以便访问 docker socket；容器后端下 Supervisor 创建空间顶层目录后会把属主 chown 到 DSH_RUNTIME_CONTAINER_UID（默认 1000），因为运行中的用户容器以该 uid 非 root 运行并直接读写这些挂载。
`space_key = HMAC-SHA256(realm, user_id)` 的不透明十六进制值，绝不使用显示名或客户端输入。
真实容器策略由 `deploy/scripts/verify-container-isolation.sh` 在真实 Docker 上验证（60 断言）；
完整运行时镜像由 `deploy/scripts/build-runtime-image.sh` 构建，`deploy/scripts/verify-container-runtime.sh`
用该镜像跑双用户容器模式 e2e（46 断言：原生 UI、Session/Skills 隔离、文件/凭据不可跨容器、供应商账户分离）。

运行时 overlay 同时把 `session-query-sqlite` 指向该用户 `$DSH_HOME/state/session-query.sqlite` 并在首次搜索时打开，
因此每个身份的内容搜索只建立在自己的 Session 数据上（shipped Web profile 默认关闭内容搜索）。

运行时环境变量（每用户唯一）：

```
DSH_HOME=<space>/dsh-home
HOME=<space>/home            # Windows 另设 USERPROFILE
DSH_AGENTS_HOME=<space>/agents-home
TMP/TEMP=<space>/tmp
DSH_GATEWAY_PUBLIC_KEY_FILE, DSH_GATEWAY_ISSUER, DSH_GATEWAY_AUDIENCE,
DSH_GATEWAY_KEY_ID, DSH_RUNTIME_SUBJECT, DSH_RUNTIME_GENERATION
```

不得把宿主 `DEEPSEEK_API_KEY`、W3 secret、平台内部密钥、数据库路径透传给用户 Runtime。内嵌部署或探针若需要为 Runtime 提供模型端点/测试凭据，必须在组合根显式传入 `PlatformAppOptions.runtimeEnv`（进程后端专用）；容器后端拒绝该注入，宿主环境仍不会被隐式继承。

## 5. HTTP/WS 网关行为

- 公开路径：`GET /login`（平台登录页）、`GET /auth/login|callback|me|health`、`POST /auth/logout`、
  `GET /api/runtime/me`、`POST /api/runtime/wake|retry`。其余路径全部代理到当前 Session 用户的 Runtime。
- 未认证访问非 `/auth/*`、`/login`、静态资源路径：API 返回 401 JSON；页面请求 302 到 `/login?return_to=<站内相对路径>`。
- 代理前：校验 Session（每次请求查库），`ensure(userId)`，只按 `RuntimeTarget` 连接；
  删除 `cookie`、`authorization`、`x-dsh-*`（除我们自己签发）、`x-user-*`、`x-auth-*`、`x-forwarded-*`、
  `x-workbench-*`、`proxy-*` 等不可信头，再附加本网关断言。
- WebSocket：握手前校验 Cookie + Origin（必须同 publicOrigin），`ensure` 后附加断言升级；
  连接期间每 `wsRevalidateSeconds`（≤20s）重新查 Session 与 generation，失效立即断开；持有 runtime lease。
- 网关不得把内部端口、路径、私钥、上游错误正文写回浏览器或日志。

## 6. 开发与测试

```bash
# 全平台测试（根目录）
pnpm exec vitest run --config services/platform/vitest.config.ts
# 类型检查
pnpm exec tsc -p services/platform/tsconfig.json --noEmit
```

测试要求：

- 只使用本机可用的能力：临时目录、`node:http` 假 W3 Provider、假 Runtime、WSL Docker（可选/门控）。
- 真实 W3 凭据不可用时，对应用例写 `BLOCKED` 并在 `docs/standalone-w3/OPEN_ISSUES.md` 记录精确条件，
  不得用 Mock 冒充真实 W3 PASS。
- 安全负向用例必须覆盖：伪造断言头、跨用户 ID、未认证 WS、注销后 WS、state 重放/并发、CSRF、生产 Mock 拒绝。
- 测试文件独立端口、独立临时目录，不依赖测试执行顺序。

## 7. 代码风格

沿用仓库根 `AGENTS.md`：ESM、`.ts` 相对导入后缀、严格类型、禁止 `as unknown`、导出写 JSDoc、
空 catch 说明原因、文件末尾一个换行、无分号风格、单引号。所有用户可见文案中文与英文成对出现（前端）。

## 8. 可选系统融合

`DSH_INTEGRATION_ENABLED=false` 时 `createPlatformApp()` 不构造融合服务，网关对 `/api/integration/*` 直接返回 404。开启后按以下顺序组合：

1. `runPreflight()` 校验注册表、互不重叠的真实根目录、固定镜像、`--network none`、Linux 主机与 Docker daemon；缺项返回 `blocked` 而不是让原生平台启动失败。
2. `createIntegrationService()` 打开节点本地 `integration.sqlite`，按注册表构造 `MockHostAdapter` 或 `HttpReadOnlyAdapter`，并把 `/api/integration/*` 交给 Gateway。
3. Gateway 先校验 Session，`POST` 再校验 CSRF 与同源 Origin，然后才调用融合服务；融合请求不会落进原生 Runtime 代理。
4. 每次资源发现、快照、Job、下载都按 `ValidatedSession.user.id` 做 owner 查询；ACL 键可以是内部 user id、W3 subject 或 W3 uid，动作只有 `list/read/export`。
5. 快照写入后不可变并带 SHA-256/来源/授权 epoch；Job 启动前重新授权并校验 epoch。
6. 分析 Job 由 `AnalysisJobRunner` 启动短生命周期容器：只读根、只读输入、工作区输出、Job scratch、`--network none`、drop capabilities、no-new-privileges、非 root uid。容器镜像 entrypoint 被清空。
7. 每用户 Runtime 启动时注入 `DSH_INTEGRATION_API_URL` 与短期 HMAC 能力 token；`/api/integration/runtime/*` 由 Gateway 解析 bearer token，仍走融合服务的 owner/ACL/epoch 校验，并复验当前权限版本与存活浏览器 Session，浏览器 Cookie 不参与。Job reaper 在注销、禁用或权限变化后取消运行中的容器。`@deepseek-ai/dsh-tool-integration` 只使用该能力，不接触平台密钥。
8. 关闭顺序为 Gateway → integration → runtime → identity；融合关闭会移除活动 Job 的容器并保留快照/元数据。

融合的 HTTP 契约、配置与验收状态见 [docs/integration/README.md](../../docs/integration/README.md)。

## 9. 明确决策与偏差

- 身份库使用 `node:sqlite` + 版本化 DDL 迁移；生产 PostgreSQL 后端是已记录的生产化缺口
  （见 `docs/standalone-w3/OPEN_ISSUES.md`），代码不静默降级。
- 开发/测试默认 `DSH_RUNTIME_KIND=process`（进程级隔离，开发包允许）；生产默认 `container`。
- Mock 仅在 `APP_ENV != production` 且 `AUTH_MODE=mock` 可用；任何 query/header 都不能选择 Mock 身份。
- 旧 `?token=` 启动入口在平台 Runtime overlay 中禁用；生产 Web profile 不允许 `authentication-token` 作为备选。
