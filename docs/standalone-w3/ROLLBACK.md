# 升级与回滚（详细）

配套脚本：`deploy/scripts/{build-image,backup,restore,upgrade,rollback}.sh`。本文说明边界与手工步骤，脚本只做脚本里写明的事。

## 1. 升级对象与保留项

| 对象 | 升级方式 | 是否保留 |
|---|---|---|
| 平台代码/镜像（Gateway/Identity/Manager） | 新镜像 + `compose up -d` | `.env`、密钥、库、用户卷全部保留 |
| 用户 Runtime 镜像（DSH 本体） | 新不可变 digest；Supervisor 对旧 generation 容器在空闲后替换 | 用户空间目录按 space_key 原样保留 |
| 运行时 overlay（禁用 token / 装配 gateway provider） | 随 `current` 目录一起切换 | 无状态 |
| 数据库 | 平台启动时执行版本化迁移 | 先备份；破坏性迁移需停机窗口 |
| 前端客户端插件 | 随运行时镜像重建 | 无状态 |

## 2. 升级顺序（在线升级）

1. 备份：`bash deploy/scripts/backup.sh pre-upgrade-<version>`（会短暂停止 platform）。
2. 导入：`docker load -i deploy/release/dsh-runtime-<version>.tar`、`dsh-platform-<version>.tar`。
3. 切换：`DSH_RUNTIME_IMAGE=dsh-runtime:<version>` 写入 `deploy/.env`（或由 orchestrator 注入），`ln -sfn <repo> /srv/dsh/current`。
4. `docker compose -f deploy/compose.yml up -d`。
5. 健康检查：GET `/health`、`/auth/health`；A/B 双账号冒烟（登录、姓名、历史、隔离、注销）。
6. 旧 generation 的 Runtime 容器：新版本 Supervisor 启动时按注册表对账，对仍 READY 的旧容器检测到image/generation 不匹配后标记为待替换；空闲（无 lease）时停止并以新 generation 启动。

## 3. 有界排空（有任务在跑）

- Supervisor 不立即强杀有活动 WebSocket/任务 lease 的 Runtime。
- 新版本发布后，旧容器继续服务直到空闲窗口；管理员可用 `POST /api/runtime/retry` 的等价管理操作（后续管理 CLI）触发受控重启。
- 不允许为了升级直接删除 `spaces/<key>`；升级脚本不触碰用户卷。

## 4. 回滚

1. 先确认迁移是否向后兼容：若新版本执行了破坏性迁移，回滚必须恢复备份（停机窗口）。
2. `bash deploy/scripts/rollback.sh <backup-label>`：应用回滚提示 + `restore.sh` 恢复management 与全部用户空间。
3. 回滚后重启 platform；`generation` 由注册表单调递增，旧实例的断言（含旧 generation）失效。
4. 校验同一 W3 subject 的 user_id 与 `space_key` 连续：`HMAC(realm, user_id)` 不变；数据目录不迁移。
5. 禁止把 A 的空间挂给 B：space 目录只由 `space_key` 定位。

## 5. 故障处理矩阵

| 故障 | 检测 | 处理 |
|---|---|---|
| 平台容器启动失败 | compose 状态 / 日志 / `--check` | 修正 `.env`；不会自动进入 Mock |
| 迁移失败 | 启动日志（迁移版本与错误） | 停止 platform，恢复备份，回滚镜像 |
| 用户 Runtime 启动失败 | `/api/runtime/me` 返回 FAILED + 错误码 | UI 重试（限流）；检查 docker 网络/镜像/资源 |
| 用户 Runtime 意外退出 | Supervisor 对账 | 标记 FAILED，用户重试；数据卷不受影响 |
| WebSocket 未随注销断开 | 观察连接数 | 检查 `DSH_GATEWAY_WS_REVALIDATE_SECONDS`（必须 ≤20） |
| 数据库损坏 | SQLite 完整性检查失败 | 从最近备份恢复；记录数据丢失窗口 |

## 6. 验收记录要求

每次升级记录：版本号、镜像 digest、备份 label、迁移版本、健康检查输出、A/B 冒烟结果、回滚演练结果。真实 W3 与生产环境不可用时，对应条目在 `ACCEPTANCE_MATRIX.csv` 标 BLOCKED 并写明缺失条件。
