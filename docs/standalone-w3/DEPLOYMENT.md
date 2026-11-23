# 独立部署指南（DSH 多用户平台）

本平台与 W3 之外没有任何外部业务依赖：一个 HTTPS 入口、一个平台进程（Gateway + Identity +Runtime Manager/Supervisor）、一个 PostgreSQL/SQLite 身份库、N 个每用户 DSH Runtime 容器。W3 只负责账号认证；DSH 自己拥有用户、Session、Runtime 与数据。

## 1. 组件与部署拓扑

| 组件 | 进程/容器 | 对外端口 | 持久化 |
|---|---|---|---|
| `platform`（本仓库 `services/platform`） | 1 个 Node 进程或 `deploy/platform/Dockerfile` 镜像 | 唯一公网入口（默认 8080，由反代/负载均衡终止 TLS） | `/srv/dsh/management`（身份库、运行时注册表、Gateway 密钥、备份） |
| 用户 DSH Runtime | 每用户 1 个容器（`deploy/runtime/Dockerfile`，不可变 digest） | **无公网端口**，只挂 `dsh-private` 私有网络 | 每用户独立空间目录 `/srv/dsh/spaces/<space_key>/{dsh-home,home,agents-home,workspaces,uploads,tmp}` |
| W3 | 外部身份提供方 | — | — |

平台容器需要 `/var/run/docker.sock` 与 docker CLI（仅 Supervisor 用它创建用户容器）；用户 Runtime容器不挂 socket、不拥有宿主 root、不挂 Gateway 私钥或平台数据库。

## 2. 前置条件（生产）

1. Linux 部署机：Docker Engine 24+、docker compose v2 插件。
2. 宿主目录 `/srv/dsh/{management,spaces,backups,releases,current}`；`management/keys` 权限 700。
3. 私有网络 `dsh-private`（`init.sh` 创建）。
4. DNS + HTTPS 反代指向 `platform` 的 8080 端口；W3 应用回调白名单登记`https://<dsh-domain>/auth/callback`。
5. W3 租户信息：`W3_CLIENT_ID/W3_CLIENT_SECRET/W3_AUTHORIZE_URL/W3_TOKEN_URL/W3_USERINFO_URL`，确认 token 请求编码（JSON 或 form）与 userinfo 请求格式。
6. 生产 `.env`（从 `deploy/.env.example` 复制）注入：`APP_ENV=production`、`AUTH_MODE=w3`、`AUTH_COOKIE_SECURE=true`、`DSH_GATEWAY_PUBLIC_URL=https://<dsh-domain>`、`DSH_INTERNAL_API_KEY`（≥32）、`DSH_PLATFORM_SPACE_KEY_SECRET`（≥32，轮换会改变 space_key）、`DSH_RUNTIME_KIND=container`、`DSH_RUNTIME_IMAGE=<registry>/dsh-runtime@sha256:<digest>`；可选 `AUTH_LOGIN_RATE_LIMIT_MAX`（默认 30，0 关闭）与 `AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS`（默认 60）。
7. 构建可用的运行时镜像（见 §3）。生产镜像必须使用 digest，不用 `latest`。

## 3. 构建与发布（构建机）

```bash
bash deploy/scripts/build-image.sh 2026.11.23-1
```

产物在 `deploy/release/`：

- `dsh-runtime-<version>.tar`、`dsh-platform-<version>.tar`
- `SHA256SUMS-<version>`、`compose-<version>.yml`、`env.example-<version>`、运行时 overlay 副本

离线复制整个 `deploy/release/` 到部署机同名目录即可，无需部署机联网或重新构建。

首次构建前可先验证运行时镜像能启动：

```bash
docker run --rm --network dsh-private -e DSH_HOME=/data/dsh-home -e HOME=/data/home \
  dsh-runtime:<version> node --import tsx/esm apps/cli/src/bin.ts --help
```

## 4. 首次部署

```bash
# 1) 放置代码：/srv/dsh/current 指向本仓库（或解压后的发布目录）
# 2) 初始化目录、网络、.env 与 Gateway 密钥
bash deploy/scripts/init.sh
# 3) 按目标环境填写 deploy/.env（真实 W3、域名、密钥）
# 4) 校验配置（失败会列出缺项，不启动服务）
node --import tsx/esm services/platform/src/main.ts --check
# 5) 启动
docker compose -f deploy/compose.yml up -d --build
# 6) 健康检查
curl -fsS http://127.0.0.1:8080/health
```

浏览器访问 `https://<dsh-domain>/`：未登录会跳转 `/login`，点击“通过 W3 登录”完成授权码流程，回到原生 DSH 聊天界面；侧栏底部显示 W3 姓名与工号。

## 5. 数据与备份

- 身份库：`/srv/dsh/management/identity.sqlite`（版本化迁移，启动时自动应用未执行迁移）。
- 运行时注册表：`/srv/dsh/management/runtime/runtime.sqlite`。
- Gateway 密钥：`/srv/dsh/management/keys/gateway-ed25519-{private,public}.pem`（私钥仅平台进程可读）。
- 用户空间：`/srv/dsh/spaces/<space_key>/...`，容器停止不删除。
- 备份：`bash deploy/scripts/backup.sh <label>`（短暂停止 platform 保证 SQLite 一致性，逐用户打包空间目录并记录 SHA256）。恢复：`bash deploy/scripts/restore.sh <label>`。

> 生产 PostgreSQL 后端为已记录缺口（见 `docs/standalone-w3/OPEN_ISSUES.md`）：当前版本生产同样使用 SQLite（WAL），并保留版本化迁移表；切换到 PostgreSQL 必须提供等价迁移与验收证据后才可声明完成。

### 旧历史数据归属迁移（一次性，OPS-05）

旧单用户部署的 `$DSH_HOME` 不会被自动归给首位登录用户。先让目标用户登录一次以建立稳定 `user_id`，再显式迁移：

```bash
# 默认 dry-run：只打印目标 space 与将复制的条目，不写任何数据
node --import tsx/esm services/platform/src/main.ts admin migrate-home \
  --from /home/legacy/.dsh --subject <W3 stable subject>

# 确认后执行复制，并在 <dataDir>/migrations/ 写 manifest
node --import tsx/esm services/platform/src/main.ts admin migrate-home \
  --from /home/legacy/.dsh --subject <W3 stable subject> --confirm
```

规则：`--subject` 与 `--user` 必须二选一；未知用户/未知 subject 直接拒绝；源不得位于托管 spaces 或平台数据目录内；目标已存在同名条目时需 `--overwrite`；符号链接不复制；迁移只复制、不删除旧 home，便于核对后再人工清理。

## 6. 升级（离线）

```bash
# 构建机：bash deploy/scripts/build-image.sh <new-version>，复制 deploy/release/ 到部署机
bash deploy/scripts/upgrade.sh <new-version>
```

`upgrade.sh` 依次：校验 SHA256 → 备份 → `docker load` → 把 `current` 指向新代码 → `compose up -d` →健康检查；任一步失败自动调用回滚（应用回滚 + 数据恢复）。升级保留 `.env`、密钥、用户卷与现有服务。运行中的用户任务有界排空：Supervisor 对旧 generation 容器在空闲后停止并替换（见 ROLLBACK.md）。

## 7. 回滚

```bash
bash deploy/scripts/rollback.sh <backup-label>
```

- 应用可回滚不等于数据库可安全降级：破坏性迁移必须先恢复备份（停平台窗口）。
- 回滚后 generation 更新使旧实例断言失效；复用同一 W3 subject 验证 user_id 与数据目录连续性。
- 回滚不得把 A 的空间卷挂到 B；`space_key` 只由 `HMAC(realm, user_id)` 派生。

## 8. 日常运维

| 操作 | 命令/位置 |
|---|---|
| 健康检查 | `bash deploy/scripts/healthcheck.sh`；GET `/health` |
| 平台日志 | `docker compose -f deploy/compose.yml logs -f platform`（不含 Cookie/token/密钥） |
| 用户 Runtime 列表 | `docker ps --filter label=dsh.platform=1` |
| 禁用用户 | `admin user disable --subject <w3-subject> --confirm`：拒绝后续认证并撤销全部活动 Session |
| 恢复用户 | `admin user enable --subject <w3-subject> --confirm`：旧 Session 仍失效，需重新登录 |
| 强制下线（不禁用账号） | `admin session revoke-all --subject <w3-subject> --confirm`：Gateway ≤20s 内断开现存 WebSocket |
| 旧历史归属 | `admin migrate-home --from <legacy> --subject <subject> [--confirm]`（默认 dry-run） |
| 清理空闲 Runtime | 自动：`DSH_RUNTIME_IDLE_SECONDS`（默认 1800s），仅在无 WebSocket/lease 时停止，数据保留 |

## 9. 本地开发与容器隔离验证（Windows/Linux）

```bash
bash deploy/scripts/run-dev.sh          # Linux/WSL
pwsh -File deploy/scripts/run-dev.ps1   # Windows
# 真实容器隔离验证（需要 Docker；WSL 内执行）
wsl -d Ubuntu --exec bash deploy/scripts/verify-container-isolation.sh
# 完整运行时镜像构建 + 真实容器模式双用户 e2e
bash deploy/scripts/build-runtime-image.sh dev
wsl -d Ubuntu --exec bash deploy/scripts/verify-container-runtime.sh
# 并发 Agent 文件/会话隔离（keyless Mock LLM，真实 headless Agent）
pwsh -File deploy/scripts/verify-agent-isolation.ps1
# Session WebSocket 流事件隔离与注销实时撤销（真实浏览器）
pwsh -File deploy/scripts/verify-ws-stream-isolation.ps1
# 后台 Job 跨用户隔离（keyless Mock LLM 驱动真实 Runtime）
pwsh -File deploy/scripts/verify-job-isolation.ps1
# 原生 MCP stdio 工具往返（keyless）
pwsh -File deploy/scripts/verify-mcp-native.ps1
# 浏览器自动化原生往返 / 跨用户上下文隔离（需要本机 Chromium）
pwsh -File deploy/scripts/verify-browser-native.ps1
pwsh -File deploy/scripts/verify-browser-isolation.ps1
```

开发模式：`AUTH_MODE=mock`、`DSH_RUNTIME_KIND=process`（受限进程，非生产安全边界），数据位于仓库根 `.dsh-platform/`。真实 A/B 双用户与隔离验收见`services/platform/tests/e2e/`，真实 W3 登录需要目标环境凭据。
