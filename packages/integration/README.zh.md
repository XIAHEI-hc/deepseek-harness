---
description: "integration 组地图：DSH 平台可选系统融合 API 之上的模型工具，供用户与维护者导航该组。"
kind: "package-group"
---

# packages/integration

[English](README.md) | 中文

## 概述

integration 组把 Agent 连接到独立平台的系统融合 API。平台负责连接器授权、不可变快照与短生命周期分析容器；这些包只把已经授权的接口暴露为模型工具。该组不包含宿主适配器，也不新建第二个 Gateway。

## 目录

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## 包

| Package | Role | ctx key |
|---|---|---|
| [`tool-integration`](tool-integration/README.zh.md) | 列出授权资源与工作区、读取快照、运行隔离分析 Job、读取产物 | 注册到 `ctx.tools` |

-----

<a id="related-documentation"></a>
## 相关文档

- [系统融合实现](../../docs/integration/README.zh.md) — 开关、ACL、快照、Job 容器与验收状态。
- [平台架构](../../services/platform/ARCHITECTURE.md) — Gateway、身份、Runtime 与融合组合。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

该包只运行在 Host 侧并面向模型。传输使用平台的运行时能力 token；它从不接收平台 space-key 密钥、浏览器 Session 或直连连接器 URL。

</details>
