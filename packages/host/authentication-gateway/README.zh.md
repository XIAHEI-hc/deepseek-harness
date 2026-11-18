---
description: "受信代理身份提供者：只让经网关访问的 DSH 实例接受请求，用逐请求签名声明取代浏览器 Cookie。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-authentication-gateway

[English](README.md) | 中文

## 概述

当一个 DSH 实例由网关持有——每个账号一个实例、绑定私有网卡、只能经已完成浏览器认证的网关访问——使用本包。网关为每个请求签发一条身份声明；本包用共享密钥、部署受众和该实例服务的唯一主体校验它，然后把请求作为唯一的 owner Peer 放行。浏览器 Cookie 和启动 token 都不参与，因为浏览器根本无法直连监听端口。每个请求都重新认证，因此网关一旦停止签发，访问立即结束，无需改动实例进程。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 Web 组合中把它挂在 Connection 旁，并关闭默认 token 提供者，使 Cookie 无法绕过网关。一个 profile 补丁同时完成两件事：

```yaml
- id: authentication-token
  disabled: true
- insert:
    - id: authentication-gateway
      name: '@deepseek-ai/dsh-host-authentication-gateway'
      config:
        secret: ${DSH_WORKBENCH_GATEWAY_SECRET}
        audience: pixlab-prod
        subject: user-a
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `secret` | 必填 | 与网关共享的 HMAC 密钥；至少 32 个字符。 |
| `audience` | 必填 | 网关签发时使用的部署受众；一个集群一个值。 |
| `subject` | 必填 | 本实例服务的主体标识；其他主体一律拒绝。 |
| `headerName` | `x-dsh-gateway-identity` | 承载身份声明的请求头。 |
| `clockSkewSeconds` | `30` | 网关时钟与本机之间可接受的偏差。 |
| `maxLifetimeSeconds` | `300` | 可接受的 `expiresAt - issuedAt` 最长间隔。 |

部署必须把监听绑定到私有或回环网卡、用 `--trusted-host` 声明浏览器可见的 authority，并在转发前剥离挂载前缀，具体做法见[在反向代理后发布 Web 界面](../../../docs/user/guide/public-deployments.zh.md)。网关在每个 HTTP 请求和每个 WebSocket 升级上附带身份声明，并且只有网关进程知道密钥。

<a id="understand-the-implementation"></a>
## 理解实现

身份声明是 `base64url(payload).base64url(HMAC-SHA256)`，签名原文为 `dsh-gateway-identity.1.<payload 段>`。载荷包含 `v`、`aud`、`sub`、`sid`、`pv`、`iat` 和 `exp`；`sid` 与 `pv` 只用于记录网关会话及其权限版本，因为实例自身不做会话判定。校验按固定顺序拒绝：格式错误、签名不符、版本或字段类型不支持、受众或主体不符、有效期超过上限、起始或过期时间超出时钟偏差。签名先于任何载荷字段影响判定。

通过校验的请求得到本插件在加载时创建的唯一 owner Peer。一个实例只有一个 Peer，正是审批、用户提问和转发 waterfall 能正常工作的前提：网关已把浏览器解析为该主体，实例内部的第二重身份没有意义。注册挂在 `connection.authentication` 上，因此 HTTP 路由与升级准入共用同一份校验。

<a id="further-exploration"></a>
## 延伸阅读

- [Connection](../../client/connection/README.zh.md) —— `connection.authentication` 注册表、Peer 准入与 `trustedHosts` 校验。
- [默认 token 认证](../authentication-token/README.zh.md) —— 本包取代的启动 token 与浏览器 Cookie。
- [Web 服务器](../webserver/README.zh.md) —— 请求与升级准入。
- [在反向代理后发布 Web 界面](../../../docs/user/guide/public-deployments.zh.md) —— 前置代理需要做什么。

<a id="model-experience"></a>
## 模型体验

无：本包只认证 HTTP 调用方，不产生任何模型输入。

#### KV Cache 影响

无；认证不修改模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 提供者只能看到请求头，无法校验对端地址。信任建立在监听绑定私有网卡、密钥只留在网关这两件事上。
- 撤销只作用于新请求：网关停止签发之前已建立的 WebSocket 会保持到它自行关闭。关闭在线连接由网关负责，本包因此不持有会话状态。
- 除 `exp` 之外没有重放窗口；被截获的声明在过期前仍可使用。请把 `maxLifetimeSeconds` 设短，并只在私有网络内转发。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

为 PixLab 工作台签发声明的网关使用 HMAC-SHA256 对 `dsh-gateway-identity.1.<段>` 签名，并以 `x-dsh-gateway-identity` 附带。改动签名原文或默认请求头对签发方是破坏性变更。

</details>
