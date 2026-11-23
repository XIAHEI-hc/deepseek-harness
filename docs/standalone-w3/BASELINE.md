# 基线报告（P0）

记录时间：2026-11-23。目标仓库：`D:\Vibe_coding\deepseek-harness`（origin `XIAHEI-hc/deepseek-harness`，分支 `master`）。

## 1. 仓库与工作树

| 项 | 值 |
|---|---|
| 分支 | `master` |
| HEAD | `master` 最新提交（`feat(authentication-gateway): verify generation-bound version 2 assertions`） |
| 工作树 | 开始实施前仅有未跟踪的 `_devpack/`（开发包解压副本）；无未提交的已有魔改改动 |
| 上游 | `upstream` 指向 `deepseek-ai/deepseek-harness` |
| Node / pnpm | Node v24.21.0 / pnpm 11.28.5 |
| 构建产物 | 各包 `lib/` 已存在（此前已构建），本阶段所有验证命令会显式重建受影响产物 |

实施策略：所有新增平台代码放在 `services/platform/`（独立服务层）与 `deploy/`，DSH 原包只做必要接入（`packages/bundle/web-app` 行与依赖、`packages/client/ui-platform-identity` 新插件、`ui-settings-general`新 slot）。不覆盖既有魔改，不改 Agent Loop / Session 格式。

## 2. 现有认证链审计（P0 关键事实，均来自当前 HEAD 源码）

| 位置 | 当前行为 | 判定 |
|---|---|---|
| `packages/host/authentication-token/src/index.ts` | 默认 Web profile 的认证插件：`createPeer({principal:{kind:'owner'}})`，所有浏览器映射到同一个 Owner Peer；Cookie 或 `?token=` 启动 Token 均可认证 | **多用户生产不可用**：多人共享一个 Owner，必须禁用 |
| `packages/host/authentication-token/src/browser-auth.ts` | 首个访问者签发持久 token Cookie；`?token=` 可换取 Cookie | 旧启动入口，平台 Runtime 必须关闭 |
| `packages/host/authentication-gateway/src/index.ts` | 可信代理模式：只接受带签名的 `x-dsh-gateway-identity` 断言，仍是每实例一个 Owner Peer；支持 v1 HMAC 与 v2 Ed25519/issuer/kid/generation/jti 重放窗口 | **平台复用点**：每用户 Runtime 用 `subject + generation + 公钥` 装配；断言格式已具备 |
| `packages/host/authentication-gateway/src/assertion.ts` | v2 规范：`dsh-gateway-identity.2.<base64url(payload)>.<base64url(sig)>`，载荷 `v,iss,aud,sub,sid,pv,gen,iat,exp,jti,kid` | Gateway 签发实现必须逐字节对齐（已写对拍测试计划） |
| `packages/client/connection/src/authentication.ts` | 有序认证 provider 注册表，首个接受者生效 | 保持原样；Runtime 只装 gateway provider |
| `packages/client/connection/src/peer.ts` | Peer 绑定 principal，生命周期作用域 | 保持原样 |
| `packages/client/connection/src/api-request-trust.ts` | Host/Origin 浏览器信任 fence：loopback、监听地址、`trustedHosts` 或同源 Origin 才放行 | Gateway 代理时必须保留公开 Host/Origin 并给 Runtime 传 `--trusted-host <public authority>` |
| `packages/bundle/web-app/cordis.patch.yml` | 默认插入 `authentication-token`；client 插件清单 | 平台接入点：新增平台身份 client 行；Runtime overlay 关闭 token 行 |
| `packages/client/ui-settings-account/src/client/AccountMenu.tsx` | 侧栏底部是 DeepSeek 模型供应商账户菜单（profile/余额/登录/退出） | **身份混淆来源**：平台身份必须独立渲染，模型账户留在 Settings |
| `apps/cli/src/args.ts` / `packages/bundle/web-app/src/startup.ts` | `dsh web --patch <overlay> --host --port --public-url --trusted-host --no-open`；`--host` 拒绝通配地址 | Runtime 启动参数依据；容器内需绑定容器私网 IP |
| `packages/util/home-paths/src/index.ts` | `DSH_HOME` 单根、`DSH_AGENTS_HOME` 共享配置根；Session/凭据/技能等默认落在该根下 | Runtime 必须为每用户独立设置 `DSH_HOME`、`HOME`、`DSH_AGENTS_HOME`、cwd、临时目录 |
| `packages/bundle/base/cordis.patch.yml` | `sessions` = `$DSH_HOME/sessions`，`storages` = `$DSH_HOME/storages` | 进程级隔离的落点；容器级再加卷隔离 |
| `packages/credentials/credentials-local/src/index.ts` | 凭据文件 = `$DSH_HOME/.credentials.yaml` | 模型密钥按用户隔离的关键路径 |
| `packages/skill/skill-filesystem` | 技能根 = `$DSH_HOME/skills` 与 `$DSH_AGENTS_HOME/skills` | 技能按用户隔离的关键路径 |

## 3. 模块处置清单

| 模块/能力 | 处置 | 隔离/风险 |
|---|---|---|
| Agent Loop、Session 格式、工具、审批、Jobs、Goal、Schedule、Workflow、SubAgent | **保留原样** | 不共享 Runtime 即天然隔离；任何跨用户访问需 Gateway 拒绝 |
| `authentication-token` | 平台 Runtime **禁用** | 生产 profile 不允许它作为备选 provider |
| `authentication-gateway` | 每用户 Runtime **启用**，固定 subject/generation/公钥 | 私钥只在 Gateway；Runtime 只读公钥；短 TTL + jti 重放窗口 |
| Session/Workspace/Skill/MCP/凭据/模型设置 | 保留原插件，数据根改为每用户空间 | 进程后端靠环境变量隔离；生产容器靠卷 + 非 root UID |
| Workspace 用户目录 | 保留用户现有工作目录选择能力 | 平台默认 cwd = `<space>/workspaces/default`；用户可再用 DSH 原生目录选择器指向自己容器内路径 |
| 前端账户菜单 | 保留（模型供应商） | 新增平台身份启动器 slot，明确区分；退出 DSH ≠ 退出模型账户 |
| 启动 Token / `?token=` | 平台 Runtime 关闭 | 验收 GATE-01 |
| WebServer/Connection | 保留，Runtime 信任 Gateway 转发的公开 Host/Origin | 网关清理不可信头并附加断言 |
| 浏览器自动化/Computer Use/Terminal/Shell | 保留 | 容器内隔离；进程模式为开发用途 |
| 平台服务（身份/网关/运行时管理） | **新增** | 全部 DSH 自有代码，无外部业务依赖 |

## 4. 技术决策（P0 锁定）

1. **路线 B：TypeScript 重写** `source/dsh_auth_core` 的身份核心，而不是长期托管 Python sidecar。原因：DSH 仓库测试/构建/部署均为 Node；Python 3.14 环境与生产镜像额外维护成本高；行为由原Python 测试逐条对拍（见 `services/platform/tests/identity.*.spec.ts`）。原 Python 源码保留在开发包内作为行为基准，不进入部署依赖。
2. 平台服务位于 `services/platform/`（单包多模块），零第三方运行时依赖：`node:http`、`node:sqlite`、`node:crypto`、`node:child_process`。避免引入新 npm 依赖改变仓库供应链策略。
3. 身份库 SQLite（`node:sqlite`）+ 版本化迁移表。**PostgreSQL 生产后端为已记录的缺口**（见`docs/standalone-w3/OPEN_ISSUES.md`），代码不会静默降级或假装支持。
4. 开发/测试默认 `DSH_RUNTIME_KIND=process`（开发包明确允许受限进程）；生产默认 `container`，由 Supervisor 管理容器与卷。
5. 浏览器入口只有 Gateway；Runtime 端口不公开。默认同域：`/auth/*`、`/login`、`/api/runtime/*` 由平台处理，其余全部代理到当前用户的 Runtime（保留原生 DSH 全部路由语义）。
6. Mock 仅 `APP_ENV != production` 且 `AUTH_MODE=mock`；真实 W3 需显式配置，生产缺配置启动失败。

## 5. 基线验证（本阶段实际执行）

| 命令 | 结果 |
|---|---|
| `git -C ... remote -v && branch --show-current && log -1` | PASS（见 §1） |
| `git status --short` | PASS（仅 `_devpack/` 未跟踪） |
| `node --version; pnpm --version` | PASS（v24.21.0 / 11.28.5） |
| `wsl -d Ubuntu --exec docker --version` | PASS（Docker 29.7.2，Compose v5.5.0，可用于容器后端验证） |
| `pnpm exec tsc -p services/platform/tsconfig.json --noEmit`（新骨架） | PASS |

后续阶段验证结果记录在 `docs/standalone-w3/TEST_REPORT.md`。

## 6. 未验证/风险

- 真实 W3 租户的 authorize/token/userinfo 地址、编码约定与回调白名单不可用 → AUTH-24 BLOCKED（Mock 不可替代）。
- 生产部署主机、内网 Git、现有生产 `.env` 与历史数据不在本机 → OPS 系列部分 BLOCKED，需目标环境执行。
- Windows 宿主通过 WSL2 Docker 验证容器后端时，Windows↔WSL 网络路径受限；容器验收优先在 WSL/Linux 内执行。
- 仓库原有全量质量门（`test:coverage` 100% 每文件、`test:web` 快照）对新增 services 层不适用/未全量运行，本阶段只运行与改动面匹配的检查并在报告中区分。
