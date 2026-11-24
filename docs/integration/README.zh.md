# DSH 系统融合分析（实施记录）

[English](README.md) | 中文

系统融合是 DSH 独立多用户平台上的**默认关闭**能力：已登录的 W3/Mock 用户可以在不修改宿主业务系统的前提下，读取管理员登记且该用户被授权的只读资源，并把分析脚本提交到独立的短生命周期容器中执行。原生 DSH 对话、Session、Workspace、身份与部署不因开关关闭而改变。宿主系统接入条件见 [ONBOARDING.zh.md](ONBOARDING.zh.md)。

## 1. 开关与状态

`DSH_INTEGRATION_ENABLED=false` 是唯一默认值。关闭时组合根不创建融合服务，不打开融合数据库，不初始化适配器，也不请求任何宿主系统；网关对 `/api/integration/*` 返回 404，且不会把这些请求转发给原生 Runtime。

开启后，`createIntegrationService()` 在启动时执行预检。预检失败不会阻止原生 W3 平台启动，而是将融合状态置为 `blocked`：`GET /api/integration/status` 返回状态与缺项代码，其余融合路由返回 503。缺项代码不包含宿主路径、密钥或上游响应正文。

```text
OFF      native platform unchanged; no fusion entry point
READY    preflight passed; each request still re-checks user authorization
BLOCKED  any hard prerequisite missing; all data and Job routes refuse
```

## 2. 两层 Runtime

| 平面 | 归属 | 能力 |
|---|---|---|
| 对话/控制平面 | 现有每用户 DSH Runtime | 登录、Session、聊天、原生工具；不挂载宿主源码、业务数据或融合工作区 |
| 数据/执行平面 | `AnalysisJobRunner` | 每任务短生命周期容器；只读输入、当前工作区输出、Job scratch、默认无网络 |

分析容器由 Docker 直接启动，参数以 `services/platform/src/integration/runner.ts` 为唯一来源：`--read-only`、默认 `--network none`（或内部网络 + 白名单 broker）、`--user <uid>`、`--cap-drop ALL`、`--security-opt no-new-privileges:true`、CPU/内存/PID 限额、`--tmpfs /tmp`，以及三个显式挂载：

```text
/inputs   RO   authorized snapshots of the current Job
/work     RW   the logical workspace the user selected (one subdirectory per Job)
/scratch  RW   private scratch of the current Job
```

镜像的 entrypoint 被清空，运行命令固定为 `/bin/sh /scratch/run.sh` 或 `python3 /scratch/run.py`。容器不挂载 Docker socket、宿主根、平台配置、`.env`、模型密钥或外部系统持久 token。

## 3. 资源、ACL 与快照

管理员在 `DSH_INTEGRATION_SYSTEMS_FILE` 中登记系统。系统只有两种适配器：

- `mock`：完全离线的声明式资源，用于测试与本地演示；生产预检拒绝。
- `http`：只允许管理员登记的固定 GET endpoint。请求不能拼接 URL、host、端口、query 或重定向；适配器拒绝 3xx、metadata 地址、超大响应和超时。

ACL 以内部 user id、W3 subject 或 W3 uid 为键，值只能是 `list`、`read`、`export`。每次发现、创建快照、启动 Job 和下载产物都由服务端按当前 `ValidatedSession` 重新判断；浏览器提供的 `userId` 不参与任何查询。

快照写入后不可变，记录 `system_id`、`resource_id`、`source_version`、`sha256`、`fetched_at`、`grant_id`、`policy_epoch`、`classification` 与存储键。读取时重新计算哈希；Job 启动前再次向适配器授权并校验 `policy_epoch`，不一致则拒绝。

## 4. 工作区与 Job

工作区是平台生成的逻辑 id，物理路径由服务端拼装。读取权限与工作区写入权限正交：用户可以在工作区 A 读取资源 S，切换到 B 后仍可读取同一 S，但新 Job 只写 B；已启动 Job 的输出目录不会因切换而改变。

Job 记录 `owner_user_id`、`session_id`、`workspace_id`、输入快照 id、语言、脚本哈希、状态与时间。输出只从当前工作区的 `<workspace>/jobs/<jobId>` 收集，符号链接、非普通文件和超限文件被拒绝。产物记录 `sha256`、MIME、大小和 `downloadScope: owner`；下载前重新校验归属与哈希，并返回 `x-artifact-sha256` 与 `x-artifact-job-id`。

## 5. HTTP 路由

所有路由先由现有 Gateway 校验 Session；`POST` 还要求 CSRF，并在 Origin 存在时必须同源。融合服务再按对象归属查询。

```text
GET  /api/integration/status
GET  /api/integration/systems
GET  /api/integration/resources?systemId=...&cursor=...
POST /api/integration/snapshots
GET  /api/integration/workspaces
POST /api/integration/workspaces
GET  /api/integration/jobs
POST /api/integration/jobs
GET  /api/integration/jobs/:jobId
POST /api/integration/jobs/:jobId/cancel
GET  /api/integration/artifacts/:artifactId/download
GET  /api/integration/audit?jobId=...
```

跨用户读取返回 404，不区分“不存在”和“无权”。`GET /api/integration/audit` 返回 Job、输入快照与产物元数据，用于追溯来源。

每用户 Runtime 的模型工具以 `Authorization: Bearer <capability>` 调用 `/api/integration/runtime/` 下的相同路径。Gateway 将短生命周期 HMAC token 解析为 Session 形状的主体，并重新校验用户当前权限版本与仍存活的浏览器 Session，因此注销或撤销后 token 在过期前也会被拒绝；不使用浏览器 Cookie 或 CSRF，且该路由不会落入原生 Runtime 代理。

## 6. 配置

见 `deploy/.env.example` 的"系统融合分析"段与 `deploy/integration/README.md`。关键约束：

- 生产必须 `AUTH_MODE=w3`、`DSH_RUNTIME_KIND=container`、`DSH_INTEGRATION_JOB_RUNNER_KIND=container`。
- 分析镜像必须固定；建议使用 digest。
- 默认 `DSH_INTEGRATION_JOB_NETWORK=none`。专用网络要求 `DSH_INTEGRATION_EGRESS_BROKER_URL` 且 `/healthz` 健康；broker 只接受精确 `host:port` 白名单。
- 并发活跃 Job 受每用户（`DSH_INTEGRATION_MAX_ACTIVE_JOBS`，默认 2）与平台级（`DSH_INTEGRATION_MAX_ACTIVE_JOBS_TOTAL`，默认 8）双重限制；超过限制返回 429 `job-limit`。
- 快照、工作区、Job 根必须是互不重叠的真实目录；预检拒绝符号链接与重叠。
- 非 Linux 主机拒绝启动分析容器；Windows 上通过 WSL2 运行 Docker 的宿主只用于开发，不作为融合生产边界。

## 7. 已验证与未完成

实际命令与结果见 [TEST_REPORT.zh.md](TEST_REPORT.zh.md)，逐项状态见 [ACCEPTANCE.zh.md](ACCEPTANCE.zh.md)。已在本机执行：

- `pnpm run typecheck:platform`：通过。
- `pnpm run test:platform`：27 个文件通过、1 个跳过；283 个用例通过、4 个跳过（含 6 个融合 spec）。
- 真实 Docker 负向验证：`deploy/scripts/verify-integration-isolation.sh` 在 WSL2 Ubuntu + Docker Engine 29.7.2 上通过，验证只读根、只读 `/inputs`、`/work`/`/scratch` 可写、uid 1000、`--network none`、无 Docker socket、无宿主 `/srv/dsh`。
- W3 基线回归：本轮 `pnpm run test:platform` 覆盖原 220 个基线用例，全部通过；真实 W3 租户仍为外部 `BLOCKED`。
- 原生可选 UI：`packages/client/ui-integration-workbench` 注册一个 `shell.overlay` 启动器，只读取一次状态，融合不存在时不渲染任何内容；其 API 与组件测试通过。
- 模型工具：`packages/integration/tool-integration` 提供发现、快照、隔离 Job、状态与产物工具；平台向每用户 Runtime 注入短生命周期 HMAC 能力，Gateway 无需浏览器 Session 即可解析。
- 会话撤销：运行时 token 会按当前权限版本复验；注销、禁用或权限变化后，Job reaper 会取消运行中的容器。
- 融合工具 guard：`/fusion` 在首个动作前标记会话，其 `tools/pre-execute` 会拒绝 Shell、MCP、PTY、SSH、子 Agent、Schedule、浏览器与动态插件工具；首次 `integration_*` 调用也会标记会话。
- 离线发布：`make-integration-release.sh` 打包镜像 tar、注册表样例、Job Dockerfile、默认关闭的 env 模板与校验和；`verify-integration-release.sh` 验证发布包。
- 受控出口：`verify-integration-egress.sh` 在真实 WSL2 Docker 网络上通过，验证内部 Job 网络、白名单目标、拒绝端口与无直连路径。

尚未完成、不得声称生产可用：

- `/fusion` 是显式 opt-in；未使用它时，guard 只在首次 `integration_*` 调用后生效。标记持久化在 `DSH_HOME` 下，但仍是应用层 guard，不是物理沙箱规则。
- 受控出口是 opt-in；代理网络路径已通过本地真实 Docker 测试，但尚未在目标环境访问真实业务主机。
- 真实 W3 租户 A/B、目标机 7 天运行、内网 Git 属外部 `BLOCKED`。
- 生产部署、升级、备份与回滚仅复用现有脚本，尚未在目标机完成融合专用演练。
