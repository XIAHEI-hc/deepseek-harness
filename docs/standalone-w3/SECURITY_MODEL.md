# 安全模型与负向验证

## 1. 信任边界

1. **浏览器 → Gateway**：不可信。每个请求都用 HttpOnly Cookie 查库解析身份；校验 Host/Origin/CSRF；请求体、路径、头、Session 失效、账号状态全部服务端判定；浏览器无法指定 user_id、Runtime、路径或端口。
2. **Gateway → Identity**：同进程模块调用（`IdentityService`），不暴露公网；`/internal/*` 对外一律 404。
3. **Gateway → Runtime**：内网/回环连接；删除浏览器 `Cookie/Authorization/x-dsh-*/x-user-*/x-auth-*/x-workbench-*/x-forwarded-*/forwarded/proxy-*` 后，由 Gateway 附加短 TTL 的 Ed25519 v2 断言（`iss/aud/sub=内部 user_id/sid/pv/gen/iat/exp/jti/kid`）。
4. **Runtime → 文件系统**：每用户独立空间目录（进程后端）或独立非 root 容器 + 只读代码 + 独立卷（生产后端）；不挂 Docker socket、宿主 root、Gateway 私钥、平台数据库。
5. **管理员 → Supervisor**：Supervisor 只在平台进程内，普通用户无管理接口；容器/镜像/挂载由配置决定，不接受用户输入。

## 2. 身份与 Session 不变量

- W3 授权码流程：32 字节 state + 浏览器 nonce Cookie 双绑定，state 原子一次性消费（并发只有一个成功）；失败/过期/重放不签发 Session。
- 会话 token 48 字节随机、库中只存 SHA-256；CSRF = 非 HttpOnly Cookie + `x-csrf-token` 头 + 库中 hash 三方一致。
- 生产强制 `AUTH_MODE=w3`、`AUTH_COOKIE_SECURE=true`、HTTPS 端点；Mock 在 `APP_ENV=production` 启动即失败。
- 账号禁用或 `permission_version` 变化立即拒绝旧 Session；注销只撤销当前 Session，不误伤其他设备。
- WebSocket 握手前验证 Session + 同源 Origin；连接期间每 ≤20 秒复验 Session 与 generation，失效立即断开。

## 3. 断言 v2（Ed25519）

- 私钥只在 Gateway（`/srv/dsh/management/keys`，权限 700）；Runtime 只读公钥文件。
- 线上格式：`<base64url(payload)>.<base64url(signature)>`，被签消息为`dsh-gateway-identity.2.<base64url(payload)>`（与仓库 verifier 逐字节对齐）。
- Runtime 校验 `iss/aud/sub/kid/gen/iat/exp/lifetime/jti 重放窗口`；`sub` 为内部 user_id，`gen` 由 Supervisor单调递增，实例重建后旧断言立即失效。
- 已用真实 Runtime 冒烟：带合法断言请求原生 UI → 200；不带断言 → 401；伪造/过期/跨 generation 断言被拒（单测覆盖见 `services/platform/tests/gateway.*.spec.ts`）。

## 4. 隔离设计

| 资源 | 进程后端（开发） | 容器后端（生产） |
|---|---|---|
| DSH_HOME / HOME / DSH_AGENTS_HOME / cwd / tmp | 每用户独立目录与环境变量 | 每用户独立卷挂载到固定路径 |
| Session / Workspace / 附件 / 交付物 | 上述目录下 | 上述卷内 |
| 模型凭据 / MCP 凭据 | `$DSH_HOME/.credentials.yaml` | 同上，卷内 |
| Skills / 插件数据 | `$DSH_HOME`、`$DSH_AGENTS_HOME` | 同上 |
| Shell / Terminal / 浏览器自动化 | 受限进程（非安全边界，仅开发） | 非 root 用户 + 资源限制 + 私有网络 |
| 宿主访问 | 开发机同用户（明确非沙箱） | 不挂 socket/宿主目录，capabilities 最小化 |

## 5. 负向验证矩阵（自动化位置）

| 攻击 | 测试位置 |
|---|---|
| 未登录访问 API/页面 | `services/platform/tests/gateway.*.spec.ts`、e2e |
| 伪造 `x-dsh-gateway-identity` | gateway 单测：断言头被清理并替换 |
| A 的 Cookie 访问 B 的 Runtime | gateway 单测 + e2e：按 Session 选 target |
| 跨站 WebSocket / 缺失 Origin | gateway 单测 |
| 注销后旧 Cookie / 旧 WS | gateway 单测 + e2e（≤复验周期断开） |
| 断言篡改/过期/换 gen/换 kid/重放 jti | gateway signer 对拍 + runtime verifier 单测 |
| state 重放/并发/错 nonce/开放跳转 | identity 单测 |
| 无 CSRF 修改请求 | identity + gateway 单测 |
| 生产 Mock | config + identity 工厂单测 |
| 任意 userId/路径/挂载 | runtime 单测 |
| 用户 Runtime 读 Docker socket/平台私钥 | 容器后端挂载参数断言（单测）；生产需在目标主机复核 |

## 6. 日志与数据最小化

- 不记录 Cookie、session token、CSRF、W3 access token、client_secret、断言原文、私钥。
- 日志只记录稳定错误码、user_id 哈希/后四位、状态迁移、Runtime 状态。
- `/api/runtime/*` 永不返回内部 host/port/路径/镜像 digest；错误码映射为稳定 code。
- 身份审计表 `dsh_audit_events`（migration v2）记录登录成功/拒绝/限流、注销、全设备注销与管理员操作，字段只有 action/outcome/user_id/subject/客户端地址/JSON detail；`admin audit list` 只读输出。审计写入复用身份库事务，不含 Cookie、token、CSRF、W3 token 等敏感值。
- 登录限流：按 transport 观测到的客户端地址做进程内滑动窗口（`AUTH_LOGIN_RATE_LIMIT_MAX`/`AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS`，0 关闭）；超出返回 429 + `Retry-After` 并写一条 `rate-limited` 审计。多副本部署需在共享反代执行同等额度（见已知限制）。

## 7. 已知限制

- 真实 W3 租户验证与容器级攻击面实测需要目标环境（见 OPEN_ISSUES.md）；PostgreSQL 身份库后端已实现并本地实测。
- 进程后端（开发）不构成安全沙箱：同宿主用户可访问彼此目录，仅用于开发/测试。
- 登录限流是单进程内存窗口；多副本部署必须在共享反代/网关层执行同样或更严格的额度，否则每个副本各自计数。
- 管理后台/禁用用户/全设备注销的管理 CLI 尚未提供图形界面（API 与数据操作已具备，审计可通过 `admin audit list` 读取）。
