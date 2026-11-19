---
description: "受信代理身份提供者：只让经网关访问的 DSH 实例接受请求，用逐请求签名声明取代浏览器 Cookie。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-authentication-gateway

[English](README.md) | 中文

## 概述

当一个 DSH 实例由网关持有——每个账号一个实例、绑定私有网卡、只能经网关访问——使用本包。网关为每个请求签发一条身份声明，本包用配置的密钥材料、受众和该实例服务的唯一主体校验它，然后把请求作为唯一的 owner Peer 放行；Cookie 与启动 token 都不参与。每个请求都重新认证。版本 2 身份声明增加签发方、密钥标识、代际绑定、用于拒绝重放的声明标识，并可选用 Ed25519 校验。

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
| `algorithm` | `hmac-sha256` | 版本 2 身份声明使用的签名算法：`hmac-sha256` 或 `ed25519`。 |
| `secret` | `hmac-sha256` 必填 | 与网关共享的 HMAC 密钥；至少 32 个字符。 |
| `publicKey` | — | 网关签名所用的 PEM Ed25519 公钥。 |
| `publicKeyFile` | — | PEM Ed25519 公钥的路径；`publicKey` 缺失时使用。 |
| `keyId` | — | 版本 2 身份声明必须携带的签名密钥标识；其他 `kid` 一律拒绝。 |
| `issuer` | — | 版本 2 身份声明必须携带的签发方；其他 `iss` 一律拒绝。 |
| `generation` | — | 版本 2 身份声明必须携带的运行时代际；其他 `gen` 一律拒绝。 |
| `replayWindowSeconds` | `0` | 已接受版本 2 声明标识的保留秒数；`0` 表示接受重复。 |
| `audience` | 必填 | 网关签发时使用的部署受众；一个集群一个值。 |
| `subject` | 必填 | 本实例服务的主体标识；其他主体一律拒绝。 |
| `headerName` | `x-dsh-gateway-identity` | 承载身份声明的请求头。 |
| `clockSkewSeconds` | `30` | 网关时钟与本机之间可接受的偏差。 |
| `maxLifetimeSeconds` | `300` | 可接受的 `expiresAt - issuedAt` 最长间隔。 |

用 `algorithm: ed25519` 搭配 `publicKey` 或 `publicKeyFile`，即可用公钥校验版本 2 身份声明；网关用私钥签名，本实例不再持有 HMAC 密钥。加载时，缺少公钥的 Ed25519 配置、无法解析或非 Ed25519 的公钥、以及缺少至少 32 字符密钥的 `hmac-sha256` 配置都会被拒绝。

部署必须把监听绑定到私有或回环网卡、用 `--trusted-host` 声明浏览器可见的 authority，并在转发前剥离挂载前缀，具体做法见[在反向代理后发布 Web 界面](../../../docs/user/guide/public-deployments.zh.md)。网关在每个 HTTP 请求和每个 WebSocket 升级上附带身份声明，并且只有网关进程持有签名密钥。

<a id="understand-the-implementation"></a>
## 理解实现

身份声明的线格式是 `base64url(payloadJson utf8, 无填充).base64url(signature, 无填充)`。版本 1 对 ASCII 字符串 `dsh-gateway-identity.1.<payload 段>` 做 HMAC-SHA256 签名，载荷包含 `v`、`aud`、`sub`、`sid`、`pv`、`iat` 和 `exp`；`sid` 与 `pv` 只用于记录网关会话及其权限版本，因为实例自身不做会话判定。版本 2 用配置的算法对 `dsh-gateway-identity.2.<payload 段>` 签名，载荷包含 `v`、`iss`、`aud`、`sub`、`sid`、`pv`、`gen`、`iat`、`exp`、`jti` 和 `kid`。其载荷是键已排序、以 `,` 和 `:` 分隔的 UTF-8 JSON，Ed25519 签名是对同一消息字节的 64 字节分离签名。

对版本 1 签名原文的签名始终把声明判为版本 1，因此版本 1 载荷在 `algorithm: ed25519` 下保持原有的拒绝结果，不支持的 `v` 也保持原有原因。版本 2 按下述顺序校验：签名、载荷结构与版本、受众、主体、已配置的签发方、已配置的密钥标识、已配置的代际、有效期上下限、已记录的声明标识、尚未生效的起始时间、过期时间。签名先于任何载荷字段影响判定，只有通过全部检查的声明才会进入重放窗口。

重放窗口属于已加载的插件实例：被接受的 `jti` 保留 `replayWindowSeconds` 秒，过期条目会被清理，重新加载后为空。因此内存占用取决于已接受请求的速率乘以窗口长度，而不是进程存活时间。`replayWindowSeconds: 0` 时不保存任何标识，接受重复。

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

- 提供者只能看到请求头，无法校验对端地址。信任建立在监听绑定私有网卡、签名密钥只留在网关这两件事上。
- 撤销只作用于新请求：网关停止签发之前已建立的 WebSocket 会保持到它自行关闭。关闭在线连接由网关负责，本包因此不持有会话状态。
- 版本 1 身份声明除 `exp` 之外没有重放拒绝，被截获的声明在过期前仍可使用。版本 2 身份声明会保留 `replayWindowSeconds` 秒；两种情况下都应把 `maxLifetimeSeconds` 设短，并只在私有网络内转发。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

为 PixLab 工作台签发声明的网关使用 HMAC-SHA256 对 `dsh-gateway-identity.1.<段>` 签名，并以 `x-dsh-gateway-identity` 附带；版本 2 身份声明对 `dsh-gateway-identity.2.<段>` 使用 HMAC-SHA256 或 Ed25519 对规范 JSON 签名。改动任一签名原文或默认请求头对签发方都是破坏性变更。

</details>
