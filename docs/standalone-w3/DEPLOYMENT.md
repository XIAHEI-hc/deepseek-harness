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

### 推荐：一键离线安装（发布包）

前置：部署机有 `docker` + compose 插件 + `node`（生成密钥/校验配置），部署目录 `/srv/dsh` 由 root 或具备写权限的账号预先创建（`install.sh` 不会 sudo）。

```bash
# 1) 把构建机的 deploy/release/ 整目录复制到部署机同名位置
# 2) 生产：准备目标环境 .env（从 env.example-<v> 填写真实 W3/域名/密钥）
bash deploy/scripts/install.sh --version <version> --env-file /path/to/prod.env
#    本地冒烟（部署机 Docker 验证，Mock，无需 W3）：
bash deploy/scripts/install.sh --version <version> --profile local --port 18080
# 3) 脚本会：校验 SHA256 → 导入双镜像 → 建目录/网络/密钥 → 写编排与 overlay →
#    docker run 配置校验 → compose up → 等待 health；幂等保留 .env/密钥/用户卷
```

安装完成后访问 `DSH_GATEWAY_PUBLIC_URL`；生产还需在反代终止 TLS 并按 §2 登记 W3 回调。卸载：`docker compose -f /srv/dsh/compose.yml down`（用户空间目录保留）。

### 源码方式（开发机）

```bash
bash deploy/scripts/init.sh
# 按目标环境填写 deploy/.env（真实 W3、域名、密钥）
node --import tsx/esm services/platform/src/main.ts --check
docker compose -f deploy/compose.yml up -d --build
curl -fsS http://127.0.0.1:8080/health
```

浏览器访问 `https://<dsh-domain>/`：未登录会跳转 `/login`，点击“通过 W3 登录”完成授权码流程，回到原生 DSH 聊天界面；侧栏底部显示 W3 姓名与工号。

> 生产平台容器以 root 运行以访问 docker socket；Supervisor 在创建用户空间顶层目录后会 chown 到运行时容器 uid（默认 1000），用户 Runtime 本身始终以非 root 运行。

## 5. 数据与备份

- 身份库：`/srv/dsh/management/identity.sqlite`（版本化迁移，启动时自动应用未执行迁移）。
- 运行时注册表：`/srv/dsh/management/runtime/runtime.sqlite`。
- Gateway 密钥：`/srv/dsh/management/keys/gateway-ed25519-{private,public}.pem`（私钥仅平台进程可读）。
- 用户空间：`/srv/dsh/spaces/<space_key>/...`，容器停止不删除。
- 备份：`bash deploy/scripts/backup.sh <label>`（维护窗口内同时停止 platform 与该主机的用户 Runtime 容器，保证 SQLite 与空间目录一致；逐用户打包空间目录、记录 SHA256 与容器 id，完成后按原 id 重启 Runtime 再启动 platform 以 adopt）。恢复：`bash deploy/scripts/restore.sh <label>`。

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
| 查看审计流 | `admin audit list [--limit n] [--offset n]`：登录/注销/限流/管理员操作，JSON 输出 |
| 到期数据清理 | `admin session cleanup [--retention-days 7] [--confirm]`：默认 dry-run，确认后删除过期 Session/OAuth state 并写审计；可由 cron 按天执行 |
| Runtime 状态 | `admin runtime status (--user|--subject|--all)`：state/generation/runtimeId/错误码 |
| 强制重启 Runtime | `admin runtime restart (--user|--subject) --confirm`：仅容器后端；停止旧实例并启动新 generation。容器化部署在 platform 容器内执行：`docker exec dsh-platform-platform-1 node services/platform/src/main.ts admin runtime restart --user <id> --confirm` |
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
# 部署机安装栈 W3 双身份 A/B（测试 W3 Provider + 两个真实 Runtime 容器；--fresh 会清空 /srv/dsh，仅用于一次性验证机）
bash deploy/scripts/verify-installed-stack-w3-ab.sh --version <release-version> --fresh
```

开发模式：`AUTH_MODE=mock`、`DSH_RUNTIME_KIND=process`（受限进程，非生产安全边界），数据位于仓库根 `.dsh-platform/`。真实 A/B 双用户与隔离验收见`services/platform/tests/e2e/`，真实 W3 登录需要目标环境凭据。
