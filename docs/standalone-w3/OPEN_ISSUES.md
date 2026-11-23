# 未完成项与客观阻塞（OPEN ISSUES）

状态以实际运行为准；未跑过的检查记 `NOT_RUN`，环境/凭据缺失记 `BLOCKED`，绝不把 Mock 结果当真实 W3 通过。

## 1. BLOCKED（目标环境才能完成）

| ID | 阻塞事项 | 精确缺失条件 | 已完成部分 | 下一步命令/材料 |
|---|---|---|---|---|
| AUTH-24 | 真实 W3 A/B 账号端到端 | 无 W3 租户的 `W3_CLIENT_ID/SECRET/AUTHORIZE/TOKEN/USERINFO` 与回调白名单 | W3 契约测试、Mock 流程、模拟 W3 Provider 全链路 e2e 通过 | 在目标环境填 `.env` 的 W3_*，`bash deploy/scripts/run-dev.sh`（或生产 compose）后用两个真实账号走 `/login`，记录回调时间与姓名 |
| OPS-10 | 内网 Git 提交 | 未提供内网 Git 地址、分支与凭据 | 平台代码、部署文件与文档已完成并在本地分支 `feat/standalone-w3-platform` 提交 | 目标环境确认后按内网流程推送并打版本标签 |
| OPS-04 Postgres | 生产 PostgreSQL 迁移/备份 | 未提供目标 PostgreSQL 与连接信息；当前实现为 SQLite（WAL）+ 版本化迁移 | SQLite 版本化迁移、备份/恢复脚本 | 实现 Postgres 存储后端并补迁移/回滚验收后，方可移除本项 |
| OPS-08 | 运行 7 天后重启恢复 | 需要 7 天真实运行窗口 | 重启恢复设计 + 对账单测 | 目标环境长稳测试 |

## 2. 代码缺口（后续迭代，非阻塞当前验收）

1. **管理控制台/CLI**：已提供 `admin migrate-home`、`admin user disable|enable`、`admin session revoke-all`、`admin audit list`；仍需补查看 Runtime 状态/强制重启的 `admin` 子命令。
2. **登录限流/防爆破**：已实现按客户端地址的进程内滑动窗口（`AUTH_LOGIN_RATE_LIMIT_*`，429 + Retry-After + 审计）；多副本部署需在共享反代执行同等额度。
3. **W3 单点退出 / PKCE**：依赖 W3 支持情况，未在真实环境验证。
4. **Session 清理任务**：过期 Session/OAuth state 的定期清理未建 cron；表上有索引，可后续加定时清理。
5. **gzip/压缩与 HTTP/2**：Gateway 透传原始流，未做压缩；由反代负责。
6. **前端快照/浏览器冒烟**：平台身份插件的组件/apply 测试与 Playwright 真实浏览器验收（登录、姓名、退出、刷新、第二身份）已通过并留存 `docs/standalone-w3/evidence/` 截图；仓库自带 `test:web` 快照套件未运行（需要构建后的 Web host 与模型凭据）。
7. **平台审计事件表**：`dsh_audit_events`（migration v2）已记录登录成功/拒绝/限流、注销、全设备注销与管理员 disable/enable/revoke-all，`admin audit list` 可读；仍可扩展 Runtime 状态迁移与连接归属事件。
8. **容器化生产验证**：平台镜像与完整 DSH 运行时镜像都已成功构建；用真实运行时镜像跑通容器模式双用户 e2e（46 断言，见 TEST_REPORT §3.10），覆盖原生 UI、Session/Skills 隔离、文件/凭据/Docker socket/宿主根/Gateway 私钥不可见、供应商账户与平台身份分离、注销撤销。仍待目标环境完成的是：镜像推送/离线分发到部署机、compose 全栈部署、真实 W3 与内网 Git（见 §1 BLOCKED 项）。
9. **仓库级既有红**（与本次改动无关）：`verify-cordis-config`（`apps/cli/tests/profiles/acp/cordis.yml` 夹具）、`verify-client-domain-graph`（ui-workspace sibling import）、`pnpm run lint` 中 skill-plaza/authentication-gateway 测试/workspace-controller 的既有告警；新增代码定向 oxlint 为 0 问题。
10. **真实环境回归**：浏览器自动化（Playwright MCP + 真实 Chromium）与 keyless Mock LLM 的 Agent/MCP/Job/WebSocket 路径均已实测；真实模型供应商聊天、真实 W3 登录与目标部署机演练仍属目标环境项（见 §1 BLOCKED 与 TEST_REPORT §5）。

## 3. 与开发包的已知偏差

1. **身份服务为 TypeScript 重写**而非托管 Python sidecar：行为以开发包 Python 实现与原测试逐条对拍（见 `services/platform/tests/identity.*.spec.ts`），部署不依赖 Python。
2. **断言 sub 使用内部 `user_id`** 而非 W3 subject；W3 subject 只用于身份库唯一映射。原因：Runtime 只接受一个固定 subject，使用内部不可变 id 避免 W3 subject 变更/复用带来的越权与迁移歧义。
3. **开发包 bridge README 的断言 header 写法与仓库 verifier 冲突**：以 verifier 为准（线上两段格式），已用真实 Runtime 冒烟验证。
4. **数据库**：当前 SQLite；PostgreSQL 为上述第 1 节 BLOCKED 项。
5. **宿主环境**：本机 Windows + WSL2 Docker；容器后端代码与参数单测完成，真实容器 e2e 建议在 Linux 部署机执行。
