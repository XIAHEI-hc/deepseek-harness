# 系统融合测试报告

[English](TEST_REPORT.md) | 中文

记录实际执行过的命令与结果；未执行项明确写 `NOT_RUN` 或 `BLOCKED`。

## 1. 本轮执行（2026-11-23，Windows + WSL2 Ubuntu）

| 命令 | 结果 | 说明 |
|---|---|---|
| `pnpm run typecheck:platform` | PASS | `tsc -p services/platform/tsconfig.json --noEmit` |
| `pnpm run test:platform` | PASS | 26 个测试文件通过、1 个跳过；279 个用例通过、4 个跳过 |
| `DSH_INTEGRATION_JOB_IMAGE=dsh-runtime:2026.11.23.7 bash deploy/scripts/verify-integration-isolation.sh`（WSL2 Ubuntu） | PASS | 真实 Docker 29.7.2；只读根、只读输入、工作区/scratch 可写、uid 1000、`network none`、无 Docker socket、无宿主部署根 |
| `pnpm exec vitest run packages/client/ui-integration-workbench/tests` | PASS | 2 个文件、9 个用例：状态/概览/CSRF 解析、不可用/就绪/阻止面板状态 |
| `pnpm exec vitest run packages/client/ui-theme/tests` | PASS | 24 个文件、183 个用例：新样式表满足圆角、发丝边框、阴影、焦点环、圆角形状与滚动条门禁 |
| `pnpm exec vitest run packages/integration/tool-integration/tests` | PASS | 2 个文件、8 个用例：运行时能力头、发现、有界读取、Job 启动/状态、API 错误、白名单与持久化会话标记 |
| `pnpm exec vitest run services/platform/tests/admin.integration.spec.ts` | PASS | 3 个用例：关闭状态无副作用；就绪状态报告零元数据计数；关闭时 Job 列表为空 |
| 在合成发布包上运行 `bash deploy/scripts/verify-integration-release.sh` | PASS | 校验和、必需资产、默认关闭 env 与两份 JSON 注册表 |
| `node --test deploy/integration/broker/proxy.test.mjs` | PASS | 精确白名单转发；其他端口返回 403 |
| `DSH_INTEGRATION_EGRESS_TEST_IMAGE=dsh-platform:2026.11.23.7 bash deploy/scripts/verify-integration-egress.sh`（WSL2） | PASS | 内部 Job 网络；broker 健康；白名单目标经代理可达；拒绝端口 403；无目标直连路径 |
| `pnpm run test:gui`（完整套件） | RUN_FAIL（环境） | 14127 个用例中 9 个失败：6 个是新样式表规则违规（已修复，`ui-theme` 复跑通过），3 个与本改动无关的宿主条件（符号链接 EPERM、secret-mask 超时、pnpm pack 超时） |

## 2. 融合单元/合同覆盖

`services/platform/tests/integration.*.spec.ts` 覆盖：

- 默认关闭不创建目录、不打开数据库。
- 生产拒绝 process runner；拒绝 `host`/`bridge`/`default` 网络；拒绝未知 runner 与非法数值。
- 注册表：重复系统 id、路径穿越、baseUrl 内嵌凭据、写动作。
- 预检：系统文件缺失、根重叠、process runner、缺镜像、生产 Mock 系统。
- 适配器：ACL 按用户隔离、跨 connector 拒绝、重定向拒绝、响应大小上限、metadata 主机拒绝、ETag 作为来源版本。
- 服务：只有被授权资源可发现；越权快照 403；哈希与来源版本；工作区切换后同一快照可读但输出分开；Job 成功/失败；跨用户 Job/产物 404；权限 epoch 变化拒绝。
- 网关：未登录 401、CSRF 缺失 403、跨源 403、已登录转发、关闭时 404 且不落原生代理。
- workbench：无 API 时隐藏、启动器/面板渲染、授权资源列表、快照选择、阻止缺项代码、变更请求 CSRF。
- 运行时能力：签发/校验/过期/篡改、无浏览器 Session 的 Gateway bearer 路由、Runtime 环境注入与模型工具传输。
- 会话撤销：注销后的 `isSessionActive`、过期权限版本拒绝、撤销扫描取消运行中的 Job。
- 融合工具 guard：`/fusion` 在首个动作前标记会话；之后只允许 `integration_*` 工具名，标记在 Runtime 重启后仍存在。

## 3. 真实容器负向证据

脚本 `deploy/scripts/verify-integration-isolation.sh` 先用 `docker create` 检查 daemon 解析后的 `HostConfig`，再启动容器执行探针：

- `Ro（/app）`、`/inputs`、`/root` 写入失败；
- `/work`、`/scratch` 写入成功；
- `/var/run/docker.sock` 不存在；
- `/srv/dsh` 不可见；
- 访问 `169.254.169.254` 超时失败；
- 进程 uid 为 1000。

输出摘要：`analysis probe passed` / `verify-integration-isolation: PASS`。

## 4. 未执行或 BLOCKED

| 项 | 状态 | 原因 |
|---|---|---|
| 真实 W3 租户 A/B 融合资源读取 | BLOCKED | 无 W3 租户与业务系统凭据 |
| 目标部署机上线 | BLOCKED | 无目标 Linux 部署机与生产 DNS/证书 |
| 7 天长稳 | BLOCKED | 需目标机运行窗口 |
| 内网 Git 推送 | BLOCKED | 无内网地址与凭据 |
| 模型侧受限工具装配 | NOT_RUN | 尚未实现 |
| PostgreSQL 后端融合元数据 | NOT_RUN | 融合元数据当前为节点本地 SQLite，与运行时注册表一致 |
| 分析 Job 镜像构建 | BLOCKED | 本机访问 Docker Hub 解析 `python:3.12-alpine` 元数据超时 |
