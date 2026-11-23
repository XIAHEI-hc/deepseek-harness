# 系统融合部署

[English](README.md) | 中文

本目录提供可选的宿主系统融合资源。`DSH_INTEGRATION_ENABLED=false` 时原生 W3 平台完全不变。

## 前置条件

1. 具有 Docker Engine 与 `docker compose` 的 Linux 主机；平台进程需要 Docker CLI 与 socket 才能启动分析容器。融合预检拒绝非 Linux 主机，因为绑定挂载路径与隔离参数必须具有权威性。
2. `APP_ENV=production`、`AUTH_MODE=w3`、`DSH_RUNTIME_KIND=container`。
3. 用 `bash deploy/scripts/build-integration-job-image.sh [tag]` 从 [`job/Dockerfile`](job/Dockerfile) 构建的固定分析镜像，或提供 `/bin/sh` 与 `python3` 的等价镜像。
4. 从 [`systems.http.example.json`](systems.http.example.json) 复制的连接器注册表。部署前删除示例主机与用户。ACL 键可以是内部 user id、W3 subject 或 W3 uid；管理员实际使用 `uid` 最方便。
5. 持久卷上的快照、工作区与 Job 根目录。它们必须是互不重叠的真实目录；预检拒绝重叠与符号链接。
6. `DSH_INTEGRATION_DATA_DIR` 的备份方案。快照与 Job 元数据是来源追溯所必需的，但不是原生聊天历史所必需的。

## 启用

```dotenv
DSH_INTEGRATION_ENABLED=true
DSH_INTEGRATION_SYSTEMS_FILE=/srv/dsh/management/integration/systems.json
DSH_INTEGRATION_DATA_DIR=/srv/dsh/management/integration
DSH_INTEGRATION_JOB_RUNNER_KIND=container
DSH_INTEGRATION_JOB_IMAGE=dsh-analysis@sha256:<digest>
DSH_INTEGRATION_JOB_NETWORK=none
DSH_INTEGRATION_RUNTIME_API_URL=http://platform:8080
```

重启平台，并以已登录用户读取 `GET /api/integration/status`。`ready` 表示预检通过。`blocked` 列出稳定缺项代码；修复所需的细节保留在运维配置中，不返回浏览器。

## 停用

设置 `DSH_INTEGRATION_ENABLED=false` 并重启。融合路由消失，元数据库与快照保留在磁盘，且不会启动任何分析容器。若必须立即停止活动 Job，请先撤销它们。

## 验证

在部署主机上运行真实 Docker 门禁：

```bash
DSH_INTEGRATION_JOB_IMAGE=dsh-analysis@sha256:<digest> \
  bash deploy/scripts/verify-integration-isolation.sh
```

该门禁检查 daemon 解析后的容器：根可写、网络不是 `none`、缺少 capability 或 `no-new-privileges`、用户不是配置 uid、Docker socket 或宿主部署根可见、输入快照可写，任一情况都会失败。

## 备份、升级与回滚

- `backup.sh` 打包 `management/`，其中包含融合元数据库、快照与 Job 记录；沿用原生平台的同一备份计划。
- 使用现有 `upgrade.sh` 升级。它保留 `.env`、密钥、用户空间与 `management/integration`；只有在新的分析镜像已导入并按 digest 固定后，才更新 `DSH_INTEGRATION_JOB_IMAGE`。
- 回滚时先设置 `DSH_INTEGRATION_ENABLED=false` 并重启，确认没有分析容器残留，再恢复上一平台版本。融合快照与 Job 记录是增量数据，仍可读取。
- 停用融合就是紧急停止：移除所有融合路由并取消活动 Job 容器，同时不动原生用户与数据。

## 边界

- 分析容器只接收 `/inputs`（只读）、`/work`（选中的工作区，读写）、`/scratch`（Job 私有，读写）。`/app`、平台配置与 `/secrets` 从不挂载。
- 默认无网络。专用 broker 网络尚未实现；预检拒绝 `none` 以外的值。
- 连接器注册表由管理员持有。请求只选择已登记 endpoint id；绝不提供 URL、主机或配置只读动作之外的操作。
- Mock 连接器是开发夹具。生产预检拒绝它们。
