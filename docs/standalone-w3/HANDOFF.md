# 交付与运维交接（DSH 独立多用户平台）

本页是最终交付物的入口：当前状态、可分发文件、部署命令、运维命令、证据位置与剩余外部阻塞。详细设计见 [README.md](README.md)、[DEPLOYMENT.md](DEPLOYMENT.md)、[SECURITY_MODEL.md](SECURITY_MODEL.md)，验收逐条见 [ACCEPTANCE_MATRIX.csv](ACCEPTANCE_MATRIX.csv) 与 [TEST_REPORT.md](TEST_REPORT.md)。

## 1. 当前状态（最终提交）

- 分支：`feat/standalone-w3-platform`；最终交付版本 `2026.11.23.7`（Git 历史见本仓库）。
- 验收矩阵：**PASS 81 / NOT_RUN 0 / BLOCKED 3**；三项 BLOCKED 均需目标环境（真实 W3 租户、7 天窗口、内网 Git）。
- 平台能力：W3/Mock 登录、服务端身份与 CSRF、每用户独立 Runtime/卷、Session/Workspace/Agent/Skills/MCP/Shell/浏览器隔离、WebSocket 注销撤销、PostgreSQL/SQLite 身份库、审计流、一键安装/升级/回滚/备份恢复。

## 2. 可分发文件

| 文件 | 大小 / sha256 | 说明 |
|---|---|---|
| `deploy/release/dsh-runtime-2026.11.23.7.tar` | 1,008,221,696 bytes / `02a36530…bcf9` | 每用户 DSH Runtime 镜像 |
| `deploy/release/dsh-platform-2026.11.23.7.tar` | 93,329,408 bytes / `32308213…` | 平台镜像（Gateway/Identity/Supervisor，含 pg 驱动与 docker CLI） |
| `deploy/release/SHA256SUMS-2026.11.23.7` | — | 双镜像校验 |
| `deploy/release/compose-2026.11.23.7.yml`、`env.example-2026.11.23.7`、`platform-runtime-2026.11.23.7.patch.yml` | — | 编排、环境模板、Runtime overlay |
| `deploy/release/dsh-platform-source-2026.11.23.7.tar.gz` | 1,232,525 bytes / `9c3fb407…` | 源码发布包（473 条目，无 `.env`/数据库/凭据） |

二进制造物在本机 `deploy/release/`，不提交 Git；构建命令与校验见 [DEPLOYMENT.md](DEPLOYMENT.md) §3，证据见 [release-manifest-2026.11.23.7.txt](evidence/release-manifest-2026.11.23.7.txt) 与 [source-release-2026.11.23.7.log](evidence/source-release-2026.11.23.7.log)。

## 3. 首次部署（目标 Linux 部署机）

1. 前置：Docker Engine 24+ / compose v2、`node`（密钥与配置校验）、可写部署根（默认 `/srv/dsh`）、DNS + HTTPS 反代、真实 W3 租户信息。
2. 将 `deploy/release/` 复制到部署机；准备生产 `env`（从 `env.example-2026.11.23.7` 填写 `APP_ENV=production`、`AUTH_MODE=w3`、四个 W3 端点与回调、`DSH_GATEWAY_PUBLIC_URL=https://…`、`DSH_INTERNAL_API_KEY`/`DSH_PLATFORM_SPACE_KEY_SECRET` ≥32、`DSH_RUNTIME_IMAGE=dsh-runtime:2026.11.23.7`、可选 `DSH_PLATFORM_STORAGE=postgres` + `DSH_POSTGRES_URL`）。
3. 执行一键安装：

```bash
bash deploy/scripts/install.sh --version 2026.11.23.7 --env-file /path/to/prod.env
```

4. 健康检查：`curl -fsS https://<dsh-domain>/health`；浏览器访问 `/login` 走 W3 授权码，登录后左下角显示 W3 姓名与 uid。
5. 部署机冒烟（可选，Mock）：`bash deploy/scripts/install.sh --version 2026.11.23.7 --profile local --port 18080` 后运行 `deploy/scripts/verify-installed-stack-w3-ab.sh --version 2026.11.23.7 --fresh`。

## 4. 日常运维

| 操作 | 命令 |
|---|---|
| 查看审计（登录/注销/限流/管理员/Runtime 生命周期） | `docker exec dsh-platform-platform-1 node services/platform/src/main.ts admin audit list --limit 50` |
| 用户禁用/恢复 | `admin user disable|enable --subject <w3-subject> --confirm` |
| 撤销某用户全部 Session | `admin session revoke-all --subject <w3-subject> --confirm` |
| 过期身份数据清理 | `admin session cleanup [--retention-days 7] [--confirm]` |
| Runtime 状态 | `admin runtime status (--user|--subject|--all)` |
| 强制重启 Runtime | `admin runtime restart (--user|--subject) --confirm`（容器后端，在 platform 容器内执行） |
| 旧 home 归属迁移 | `admin migrate-home --from <legacy> --subject <subject> [--confirm]` |
| 备份 / 恢复 | `backup.sh <label>` / `restore.sh <label>`；PostgreSQL 后端需部署机安装 `postgresql-client` |
| 离线升级 | 复制新版本 release 目录后 `install.sh --version <new> --env-file <prod.env>`，保留 `.env`/密钥/用户卷 |
| 网络与容器 | `docker ps --filter label=dsh.platform=1`；Runtime 只在 `dsh-private`，无发布端口 |

## 5. 关键设计约束

- 一个身份一个 DSH Runtime；Runtime 内部 principal 固定 `{kind:'owner'}`；Gateway 用有效 DSH Session 绑定唯一 user_id，多窗口复用同一 Runtime。
- Gateway 断言 v2（Ed25519、generation、公钥验签、短 TTL），HTTP 与 WebSocket 都经 Gateway；注销/撤销后 WS 在 ≤20s 内断开。
- 平台身份（W3）与模型供应商账户严格分离；Mock 仅 development/testing，生产启动拒绝 Mock。
- Runtime 容器非 root（uid 1000）、只挂用户空间与只读公钥/overlay，不挂 Docker socket/宿主根/Gateway 私钥；空闲停止不删用户数据。
- 身份库迁移版本化（SQLite 或 PostgreSQL，`schema_migrations`），备份/恢复同时覆盖数据库、密钥与用户空间。

## 6. 剩余外部阻塞

| ID | 缺失条件 | 解除后命令 |
|---|---|---|
| AUTH-24 | 真实 W3 租户 `W3_CLIENT_ID/SECRET/AUTHORIZE/TOKEN/USERINFO` 与回调白名单 | 填生产 `.env` 后 `install.sh`，两个真实账号走 `/login`，记录姓名与隔离结果 |
| OPS-08 | 7 天真实运行窗口 | 目标机部署后保持运行 7 天，期间执行重启与备份，记录 `admin runtime status`/审计 |
| OPS-10 | 内网 Git 地址、分支与凭据 | 按内网流程推送 `feat/standalone-w3-platform` 与版本标签 |

精确阻塞说明与已有部分见 [OPEN_ISSUES.md](OPEN_ISSUES.md) 与 [ACCEPTANCE_MATRIX.csv](ACCEPTANCE_MATRIX.csv)。

## 7. 证据索引

- 身份/安全：`evidence/admin-audit.log`、`evidence/runtime-audit.log`、`evidence/final-security-drill.log`。
- 多用户/浏览器：`evidence/install-w3-ab.log`、`evidence/browser-w3-installed/`、`evidence/reuse-restart.log`。
- 部署/升级/备份：`evidence/install-smoke.log`、`evidence/backup-upgrade-rehearsal.log`、`evidence/postgres-backup-restore.log`。
- 原生能力：`evidence/final-probes.log`、`evidence/agent-isolation.log`、`evidence/ws-stream-isolation/`、`evidence/job-isolation/`、`evidence/mcp-native/`、`evidence/browser-isolation/`。
- 发布包：`evidence/release-manifest-2026.11.23.7.txt`、`evidence/final-release-2026.11.23.7.log`、`evidence/source-release-2026.11.23.7.log`。
