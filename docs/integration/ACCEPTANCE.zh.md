# 系统融合验收

[English](ACCEPTANCE.md) | 中文

本表记录本分支实际执行过的内容。`RUN_PASS` 表示所列命令或门禁已在本机运行；`BLOCKED` 表示缺少外部条件；`NOT_RUN` 表示行为尚未实现或尚未执行。远程报告不会被复制成 `RUN_PASS`。

## 融合门禁

| ID | 检查 | 状态 | 证据 |
|---|---|---|---|
| F0-01 | 现有 W3 平台套件仍通过 | RUN_PASS | `pnpm run test:platform`：278 通过、4 跳过 |
| F0-02 | 真实 W3 租户 A/B 登录 | BLOCKED | 无 W3 租户凭据 |
| F1-01 | 关闭开关无融合副作用 | RUN_PASS | `integration.config.spec.ts`、`integration.service.spec.ts` |
| F1-02 | 开启但预检不完整时 blocked，原生平台继续运行 | RUN_PASS | `integration.preflight.spec.ts`、blocked 路由测试 |
| F1-03 | 生产拒绝 process runner | RUN_PASS | `integration.config.spec.ts` |
| F2-01 | Gateway 在融合路由前完成认证 | RUN_PASS | `gateway.integration.spec.ts` 401 用例 |
| F2-02 | 变更请求要求 CSRF 与同源 Origin | RUN_PASS | `gateway.integration.spec.ts` |
| F2-03 | 跨用户 Job/产物读取返回 404 | RUN_PASS | `integration.service.spec.ts` |
| F3-01 | 真实容器根与输入只读 | RUN_PASS | WSL2 Docker 29.7.2 上的 `verify-integration-isolation.sh` |
| F3-02 | 工作区与 scratch 可写；uid 非特权 | RUN_PASS | 同一 Docker 门禁 |
| F3-03 | `--network none`、无 Docker socket、无宿主部署根 | RUN_PASS | 同一 Docker 门禁 |
| F3-04 | 非 Linux 主机拒绝分析容器 | RUN_PASS | `integration.preflight.spec.ts` 主机平台缺项 |
| F3-05 | 在任意融合工具运行前禁用 Shell/MCP/PTY/SSH/子 Agent/Schedule 旁路 | RUN_PASS | `/fusion` 命令标记会话；guard 只允许 `integration_*` 工具 |
| F3-06 | 会话进入融合模式后拒绝非融合工具 | RUN_PASS | `tool-integration` 的 `fusionToolAllowed` 与 `tools/pre-execute` guard |
| F3-07 | 可选 broker 只接受精确白名单 host:port | RUN_PASS | `deploy/integration/broker/proxy.test.mjs`、runner argv 与预检 broker 测试 |
| F4-01 | Mock ACL 隔离用户与资源 | RUN_PASS | `integration.service.spec.ts` |
| F4-02 | HTTP 适配器拒绝重定向、metadata 主机与超大响应 | RUN_PASS | `integration.http-adapter.spec.ts` |
| F5-01 | 快照哈希、来源版本、授权记录与 epoch 被保存 | RUN_PASS | `integration.service.spec.ts` |
| F5-02 | 切工作区读同一快照，只写选中工作区 | RUN_PASS | `integration.service.spec.ts` |
| F5-03 | 产物下载重新校验 owner 与哈希 | RUN_PASS | `integration.service.spec.ts` |
| F5-04 | 权限 epoch 变化拒绝旧快照 | RUN_PASS | `integration.service.spec.ts` |
| F5-05 | 显式取消不会被容器退出覆盖 | RUN_PASS | `integration.service.spec.ts` 取消竞态用例 |
| F6-01 | 无融合 API 时工作台隐藏 | RUN_PASS | `Workbench.client.spec.tsx` |
| F6-02 | ready 与 blocked 面板显示授权资源与缺项代码 | RUN_PASS | `Workbench.client.spec.tsx` |
| F6-03 | 服务端作业流式推送 | NOT_RUN | 面板只在用户操作时刷新 |
| F6-04 | 模型工具通过运行时能力读取资源并运行 Job | RUN_PASS | `integration.capability.spec.ts`、`gateway.integration.spec.ts`、`tool-integration` 客户端测试 |
| F7-01 | 真实 W3 双用户融合隔离 | BLOCKED | 无真实租户或宿主系统 |
| F7-02 | 注销/撤销时中止旧 Job 容器 | RUN_PASS | 身份 `isSessionActive` 测试与 `integration.service.spec.ts` reaper 用例 |
| F7-03 | 融合 Session 的后台任务、Schedule、MCP、浏览器旁路 | RUN_PASS | 进入 `/fusion` 后 `tools/pre-execute` 拒绝所有非 `integration_*` 工具 |
| F8-01 | 从 `deploy/integration/job/Dockerfile` 构建分析镜像 | BLOCKED | 本地 Docker 构建无法解析 `python:3.12-alpine`（registry 出口超时） |
| F8-02 | 备份覆盖融合元数据与快照 | RUN_PASS（设计） | `backup.sh` 打包 `management/`，其中包含 `integration/`；目标机演练未执行 |
| F8-03 | 升级/回滚保留原生用户与融合数据 | NOT_RUN | 复用现有脚本；尚无目标机融合演练 |
| F8-04 | 离线发布包结构保持融合默认关闭 | RUN_PASS | 合成发布包通过 `verify-integration-release.sh`；镜像构建仍见 F8-01 |
| F8-05 | 目标机七天运行 | BLOCKED | 无目标机窗口 |
| F8-06 | 只读融合管理状态报告状态与计数 | RUN_PASS | `admin.integration.spec.ts` |

## 明确不声明

- 远程 `81/84` 是基线仓库报告，不是本轮结果。本轮单独重跑了本地平台套件并记录。
- Mock 资源与本地 Docker 主机证明的是合同，不是生产宿主系统连接。
- 一个 `RUN_PASS` 行只对其单元格中的证据成立，不外推到真实 W3、目标部署机或业务系统。
