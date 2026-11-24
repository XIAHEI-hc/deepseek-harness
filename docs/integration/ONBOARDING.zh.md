# 宿主系统接入条件

[English](ONBOARDING.md) | 中文

本页是接入一个宿主系统到 DSH 系统融合时的条件清单。它说明宿主负责人、W3 租户管理员、平台管理员与安全评审在融合预检报告 `ready` 之前、在生产使用之前必须提供什么。运行时行为见 [README.zh.md](README.zh.md)；部署步骤见 [deploy/integration/README.zh.md](../../deploy/integration/README.zh.md)。

## 1. 角色与决策

| 角色 | 必须提供 | 负责 |
|---|---|---|
| 宿主系统负责人 | 只读接口文档、资源目录、ACL 规则、样例资源与变更窗口 | 宿主不被修改，且暴露的每个动作都是只读 |
| W3 租户管理员 | 两个测试用户及其 subject/uid、现有 W3 客户端登记与权限变更测试 | 真实身份映射与可撤销授权 |
| DSH 平台管理员 | Linux Docker 主机、部署值、连接器注册表、分析镜像、备份与回滚 | 预检 `ready`、隔离与可恢复性 |
| 安全评审 | 数据分级、允许的网络目标、密钥处理、保留期与审计要求 | 无写入路径、无密钥暴露、无不受控出口 |

必须指定一名验收负责人，能够批准双用户测试与生产开关。

## 2. 身份与授权条件

- 目标平台上的现有 W3 授权码登录必须已经可用。融合不新增第二套登录、Cookie 或用户目录。
- 至少需要两个真实 W3 测试用户。用户 A 必须被授权访问两个资源；用户 B 只能访问其中一个；至少一个资源必须对 A 拒绝。
- ACL 键可以是 DSH 内部用户 id、W3 subject 或 W3 uid。值仅限 `list`、`read`、`export`；缺失条目默认拒绝。
- 宿主负责人必须说明用户如何失去访问权，平台必须能演示：禁用账号或修改权限版本后，现有 Session 与运行时 token 失效。
- 服务凭据只能在服务端核验用户 ACL 之后读取宿主资源。它不能作为用户身份使用，也不能交给模型、Session、Job 或浏览器。

## 3. 资源条件

| 资源类型 | 宿主必须提供 | 限制与拒绝项 |
|---|---|---|
| 接口文档 | 带版本的 OpenAPI、AsyncAPI 或 Markdown；base URL；认证；分页；错误格式；速率限制 | 不接受用户自带 URL，不接受写接口 |
| 只读源码 | 只读 Git 镜像或归档接口，以及 commit 或版本标识 | 不构建、不写 checkout、不挂载宿主工作区 |
| 数据 | 只读 SQL 视图或导出接口；schema；行数限制；样例响应 | 不允许 DML、有副作用存储过程或无界查询 |
| 日志 | 只读查询接口；时间范围；字段；脱敏规则 | 不允许删除、写入日志或宿主 shell |
| 执行产物 | 带校验和与保留期的只读对象引用 | 不允许上传、覆盖或把可执行文件交回宿主 |

每个资源必须有稳定定位、来源版本、分级与可哈希表示。默认快照上限为 16 MiB；更大资源需要显式提高平台限制并完成大小测试。

## 4. 适配器与网络条件

- 当前适配器只有离线 `mock` 与 endpoint 白名单 `http`。mock 仅用于开发与演练；生产预检会拒绝它。
- HTTP 适配器使用管理员配置的 base URL 与路径。它接受 `GET` 读取，拒绝重定向，执行超时与响应大小限制，不提供通用代理或用户可控 URL。
- 其他协议或写入集成需要新增经过评审的适配器，不能通过修改注册表启用。
- 平台容器必须能访问宿主 base URL。分析 Job 容器默认保持 `--network none`，不需要访问宿主。
- 如果 Job 需要受控出口，必须部署 broker、评审精确 `host:port` 白名单并使用 `dsh-fusion-egress`。Job 直连出口不是可选项。

## 5. 连接器注册表与授权

管理员提供一份带版本的 `systems.json` 条目。格式示例见 [systems.http.example.json](../../deploy/integration/systems.http.example.json)。

- `id`、`name`、`adapter`、`baseUrl` 与 `endpoints` 由管理员持有。
- 每个 endpoint 具有稳定的 `id`、`path`、`resourceType`、`version`、`classification` 与 `acl`。
- ACL 条目必须写真实用户；不接受通配租户、共享管理员账号或公开 endpoint。
- 请求选择已有的 endpoint id，绝不携带注册表之外的 host、URL、方法或动作。
- 测试用户 A 与 B 对同一 endpoint 必须得到不同的资源列表。

## 6. 运行时与部署条件

- 需要带 Docker Engine、cgroups 与非 root 部署用户的 Linux 主机。Windows 经 WSL2 仅用于开发。
- 分析镜像必须提供 `/bin/sh` 与 `python3`，以非 root uid 运行，并按 digest 固定。启用融合前，宿主必须先加载镜像。
- 快照、工作区与 Job 根必须是互不重叠的真实目录。符号链接与重叠根会被拒绝。
- 平台将融合元数据存放在 `management/integration` 下；现有备份与恢复会随 `management` 一起保留该目录。
- 必需部署值包括 `DSH_INTEGRATION_ENABLED`、`DSH_INTEGRATION_SYSTEMS_FILE`、`DSH_INTEGRATION_DATA_DIR`、`DSH_INTEGRATION_JOB_RUNNER_KIND=container`、`DSH_INTEGRATION_JOB_IMAGE`、`DSH_INTEGRATION_JOB_NETWORK` 与 `DSH_INTEGRATION_RUNTIME_API_URL`。
- 并发受每用户 `DSH_INTEGRATION_MAX_ACTIVE_JOBS` 与平台级 `DSH_INTEGRATION_MAX_ACTIVE_JOBS_TOTAL` 限制。
- `admin integration status` 必须报告 `ready`；任何缺项都是阻塞项，不是可忽略的警告。

## 7. 安全条件

- 宿主凭据必须是只读、最小权限、可轮换并通过带外渠道提供。它绝不能出现在注册表、快照、Job、模型提示、Session 事件或日志中。
- 宿主源码、部署文件、`.env`、密钥与原始数据绝不挂载到每用户 Runtime 或分析 Job。
- Job 没有 Docker socket、宿主 root、平台密钥或持久宿主 token。
- 宿主必须提供 TLS、稳定的 DNS 名或地址，以及仅允许平台的防火墙规则。如果使用 broker，其白名单不得包含 metadata 服务。
- 宿主负责人定义数据分级、保留期与删除方式。平台管理员必须确认快照、工作区、产物与备份遵守该策略。
- 审计必须覆盖读取、快照创建、Job 启动、取消、下载与拒绝访问。宿主同时保留自己的读取审计。

## 8. 生产前必须完成的验收证据

| 检查 | 必需证据 |
|---|---|
| 真实 W3 登录 | 两个用户通过现有 W3 流程登录；不存在融合专用登录 |
| ACL 隔离 | 用户 A 看到两个已批准资源；用户 B 看到一个；被拒绝资源返回 403/404 |
| 快照元数据 | 来源版本、哈希、授权、分级与权限 epoch 已保存，并能在 Job 审计中看到 |
| 工作区隔离 | Job 只写所选工作区；切换到工作区 B 后不能写 A |
| Job 隔离 | 真实 Docker 负向测试通过：根与输入只读、仅 work/scratch 可写、无 socket、无宿主 root；除非有受评审 broker，否则 `--network none` |
| 撤销 | 禁用或权限变更会阻止新请求并取消活跃 Job |
| 产物下载 | owner 校验、哈希校验、`x-artifact-sha256` 与 `x-artifact-job-id` 已验证 |
| 预检 | 缺项产生 `blocked`；条件完整产生 `ready` |
| 备份与恢复 | `management` tar 往返保持元数据计数与快照字节 |
| 升级与回滚 | 目标机演练保留原生用户与融合数据 |
| 七天运行 | 真实目标机运行完成，且无安全或数据完整性事件 |

需要真实租户或目标机的项目在拿到证据前保持 `BLOCKED`。本地测试或远程报告不能替代这些证据。

## 9. 接入信息表

在接入工单中提供以下信息。不要把凭据粘贴到工单；通过批准的密钥渠道交付。

```text
Host system:
Owner and contact:
Environment and version:
Base URL and TLS:
Network path from the platform:
Authentication method and read-only scopes:
Credential rotation owner:
Resource types and stable ids:
Expected size, content type, and rate limit per resource:
Sample response for each resource:
ACL keys and values:
Test user A: subject / uid / internal id / allowed resources
Test user B: subject / uid / internal id / allowed resources
Denied-resource case for user A:
Data classification, retention, and deletion:
Egress destinations and ports:
Target Linux host and Docker version:
Analysis image digest:
Backup, rollback, and change-window owner:
Acceptance owner and test dates:
```

## 10. 必须停止接入的条件

- 宿主只提供写接口，或要求共享管理员 token。
- 平台需要通用代理、任意 URL 抓取，或包含云 metadata endpoint 的白名单。
- 宿主无法提供两个真实用户或资源级拒绝用例。
- 源码不是只读，或平台需要修改宿主代码、部署文件、`.env`、密钥或原始数据。
- 分析 Job 需要 Docker socket、宿主 root、持久宿主 token 或不受限网络。
- 生产部署会使用 Mock 适配器、可变镜像 tag 或未加载的分析镜像。
- 没有目标机、备份路径、回滚负责人或七天窗口。

## 11. 接入顺序

1. 完成接入信息表并指定验收负责人。
2. 与宿主负责人冻结资源清单、ACL 与只读保证。
3. 用 Mock 适配器演练两个用户与拒绝资源。
4. 将真实 HTTP 系统加入 `systems.json`，运行 `admin integration status` 直到报告 `ready`。
5. 在预发布部署上完成双用户、工作区、网络、撤销与下载检查。
6. 加载分析镜像，验证隔离与出口脚本，并在目标机演练备份与回滚。
7. 用真实 W3 用户完成七天试运行。
8. 仅对已批准用户启用融合，并持续复核开关、审计与回滚路径。
