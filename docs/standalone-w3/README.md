# DSH 原生 W3 / Mock 多用户平台（实施记录）

本目录记录在 `XIAHEI-hc/deepseek-harness` 仓库内实现的独立多用户平台：DSH 自身通过 W3 登录，每个身份拥有独立 DSH Runtime 与数据卷，Gateway 按有效 Session 路由 HTTP/WS，生产禁用旧 token 入口，Mock 仅限开发/测试。W3 只提供账号认证，平台不依赖任何其他业务系统。

## 文档索引

| 文档 | 内容 |
|---|---|
| [BASELINE.md](BASELINE.md) | P0 基线：仓库状态、现有认证链审计、模块处置、技术决策 |
| [ARCHITECTURE.md](../../services/platform/ARCHITECTURE.md) | 平台服务模块、信任边界、Runtime 启动约定、断言格式、开发测试约定 |
| [DEPLOYMENT.md](DEPLOYMENT.md) | 生产拓扑、前置条件、首次部署、备份、升级、日常运维 |
| [ROLLBACK.md](ROLLBACK.md) | 升级/回滚边界、有界排空、故障处理矩阵 |
| [SECURITY_MODEL.md](SECURITY_MODEL.md) | 信任边界、身份/Session 不变量、断言 v2、隔离设计、负向验证矩阵 |
| [TEST_REPORT.md](TEST_REPORT.md) | 实际执行的测试、命令、结果与证据；BLOCKED/NOT_RUN 说明 |
| [OPEN_ISSUES.md](OPEN_ISSUES.md) | 客观阻塞、代码缺口、与开发包的已知偏差 |
| [ACCEPTANCE_MATRIX.csv](ACCEPTANCE_MATRIX.csv) | 逐条验收矩阵与真实状态 |
| [DIFF_SUMMARY.md](DIFF_SUMMARY.md) | 相对基线的文件变更与设计差异摘要 |

## 代码位置

```
services/platform/           平台服务（TypeScript，零第三方运行时依赖）
  src/identity/              W3/Mock 身份核心（移植 source/dsh_auth_core 行为）
  src/runtime/               Runtime Manager + Supervisor（进程/容器后端）
  src/gateway/               公网 Gateway（Session、CSRF、Ed25519 v2 断言、HTTP/SSE/WS 代理）
  src/app.ts, src/main.ts    组合根与进程入口
  tests/                     单元/组件测试；tests/e2e/ 真实双用户端到端
deploy/                      生产镜像、compose、运行时 overlay、初始化/备份/升级/回滚脚本
packages/client/ui-platform-identity/   原生 DSH 前端平台身份插件
deploy/runtime/platform-runtime.patch.yml  禁用 authentication-token、装配 authentication-gateway
```

## 快速开始（本地开发）

```bash
pnpm run start:platform      # 或 bash deploy/scripts/run-dev.sh / pwsh -File deploy/scripts/run-dev.ps1
# 浏览器打开 http://127.0.0.1:8080，Mock 登录后进入原生 DSH
```

本地流程：Mock 身份（仅开发）→ 建立 HttpOnly Session → Gateway 为该身份启动独立 DSH Runtime → 代理原生 UI 与 WebSocket。A/B 双用户与隔离见 `services/platform/tests/e2e/`。旧单用户历史用 `admin migrate-home`（默认 dry-run）显式归属到某个 W3 身份，不自动给首位登录者。

## 状态

实现与验证状态以 [TEST_REPORT.md](TEST_REPORT.md)、[OPEN_ISSUES.md](OPEN_ISSUES.md) 和[ACCEPTANCE_MATRIX.csv](ACCEPTANCE_MATRIX.csv) 为准。真实 W3 租户、生产部署机、PostgreSQL 与容器级攻击面复验等客观缺失项已逐条标 BLOCKED，未把 Mock 结果当作真实 W3 通过。
