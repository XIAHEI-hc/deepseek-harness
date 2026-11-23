# 未完成项与客观阻塞（OPEN ISSUES）

状态以实际运行为准；未跑过的检查记 `NOT_RUN`，环境/凭据缺失记 `BLOCKED`，绝不把 Mock 结果当真实 W3 通过。

## 1. BLOCKED（目标环境才能完成）

| ID | 阻塞事项 | 精确缺失条件 | 已完成部分 | 下一步命令/材料 |
|---|---|---|---|---|
| AUTH-24 | 真实 W3 A/B 账号端到端 | 无 W3 租户的 `W3_CLIENT_ID/SECRET/AUTHORIZE/TOKEN/USERINFO` 与回调白名单 | W3 契约测试、Mock 流程、模拟 W3 Provider 全链路 e2e 通过 | 在目标环境填 `.env` 的 W3_*，`bash deploy/scripts/run-dev.sh`（或生产 compose）后用两个真实账号走 `/login`，记录回调时间与姓名 |
| OPS-02/06/07/10 | 生产 `.env`、离线升级与内网 Git 提交 | 未提供生产部署机、内网 Git 地址与凭据 | `deploy/scripts/{build-image,upgrade,rollback,backup,restore}.sh` 与文档就绪 | 在部署机执行 build-image → upgrade → 回滚演练 |
| OPS-04 Postgres | 生产 PostgreSQL 迁移/备份 | 未提供目标 PostgreSQL 与连接信息；当前实现为 SQLite（WAL）+ 版本化迁移 | SQLite 版本化迁移、备份/恢复脚本 | 实现 Postgres 存储后端并补迁移/回滚验收后，方可移除本项 |
| RUNT-11/12、DATA-05（容器级） | 用户容器不可读 Docker socket/平台私钥、跨容器探测 | 需要在 Linux 目标机运行真实容器（本机 Windows + WSL2 网络路径受限） | 容器后端参数/挂载单测、隔离设计 | 在 Linux 部署机执行 `services/platform/tests/e2e` 的容器用例并记录 `docker exec` 探测结果 |
| OPS-08 | 运行 7 天后重启恢复 | 需要 7 天真实运行窗口 | 重启恢复设计 + 对账单测 | 目标环境长稳测试 |

## 2. 代码缺口（后续迭代，非阻塞当前验收）

1. **管理控制台/CLI**：禁用用户、全设备注销、查看 Runtime 状态、强制重启目前通过身份库/注册表数据操作；需补 `dsh-platform admin` 子命令与审计表（docs/05 的 `dsh_audit_events`）。
2. **登录限流/防爆破**：当前未实现 IP/账号级限流（开发包列为生产增强项）。
3. **W3 单点退出 / PKCE**：依赖 W3 支持情况，未在真实环境验证。
4. **Session 清理任务**：过期 Session/OAuth state 的定期清理未建 cron；表上有索引，可后续加定时清理。
5. **gzip/压缩与 HTTP/2**：Gateway 透传原始流，未做压缩；由反代负责。
6. **前端快照/浏览器冒烟**：平台身份插件的组件/apply 测试与 Playwright 真实浏览器验收（登录、姓名、退出、刷新、第二身份）已通过并留存 `docs/standalone-w3/evidence/` 截图；仓库自带 `test:web` 快照套件未运行（需要构建后的 Web host 与模型凭据）。
7. **旧历史数据归属迁移**：`dsh migrate-home --from ... --to-user ... --dry-run` 未实现（OPS-05）。
8. **平台审计事件表**：认证失败/运行时状态/连接归属的审计落库未实现（日志已脱敏记录稳定 code）。
9. **容器化生产验证**：平台镜像可构建且 `--check` 通过；Runtime 容器镜像（`deploy/runtime/Dockerfile`）的多阶段构建与容器内攻击面探测未在本机执行（耗时长 + Windows↔WSL 网络限制），需在 Linux 构建机/部署机执行。
10. **仓库级既有红**（与本次改动无关）：`verify-cordis-config`（`apps/cli/tests/profiles/acp/cordis.yml` 夹具）、`verify-client-domain-graph`（ui-workspace sibling import）、`pnpm run lint` 中 skill-plaza/authentication-gateway 测试/workspace-controller 的既有告警；新增代码定向 oxlint 为 0 问题。

## 3. 与开发包的已知偏差

1. **身份服务为 TypeScript 重写**而非托管 Python sidecar：行为以开发包 Python 实现与原测试逐条对拍（见 `services/platform/tests/identity.*.spec.ts`），部署不依赖 Python。
2. **断言 sub 使用内部 `user_id`** 而非 W3 subject；W3 subject 只用于身份库唯一映射。原因：Runtime 只接受一个固定 subject，使用内部不可变 id 避免 W3 subject 变更/复用带来的越权与迁移歧义。
3. **开发包 bridge README 的断言 header 写法与仓库 verifier 冲突**：以 verifier 为准（线上两段格式），已用真实 Runtime 冒烟验证。
4. **数据库**：当前 SQLite；PostgreSQL 为上述第 1 节 BLOCKED 项。
5. **宿主环境**：本机 Windows + WSL2 Docker；容器后端代码与参数单测完成，真实容器 e2e 建议在 Linux 部署机执行。
