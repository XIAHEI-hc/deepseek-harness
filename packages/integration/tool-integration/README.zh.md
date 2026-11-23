---
description: "DSH 平台融合 API 之上的模型工具：通过运行时能力 token 读取授权只读资源、不可变快照、隔离分析 Job 与产物。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-integration

[English](README.md) | 中文

## 概述

该包注册 Host 工具，让 Agent 使用独立平台的融合 API，同时不接收浏览器 Session、连接器 URL 或平台密钥。发现范围限定为当前登录用户；读取生成不可变快照；脚本运行在平台的短生命周期分析容器；产物随哈希返回。平台未注入 API URL 或能力时，插件不注册任何工具。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

插件需要 `tools` 服务以及平台 Supervisor 注入的两个运行时环境值：`DSH_INTEGRATION_API_URL` 与 `DSH_INTEGRATION_CAPABILITY_TOKEN`。基础 bundle 以禁用状态挂载该行；平台运行时 overlay 只在平台服务就绪的 Runtime 中启用它。

工具包括：

- `integration_list_resources` 与 `integration_list_workspaces`：发现。
- `integration_read_resource` 与 `integration_create_snapshot`：授权读取。
- `integration_run_analysis_job`、`integration_job_status` 与 `integration_read_job_artifact`：执行与输出。

<a id="understand-the-implementation"></a>
## 理解实现

### 信任与传输

能力 token 是绑定单个用户、单个权限版本与短过期时间的 HMAC token。token 到达平台 Gateway 的 `/api/integration/runtime/*` 接口；Gateway 将其解析为 Session 形状的主体，融合服务执行与浏览器 API 相同的 owner、ACL 与 epoch 检查。该 token 从不授权原生 Runtime 代理。

### 内容上限

资源与产物文本在到达模型前由 `maxContentChars` 截断。分析 Job 在 `/inputs` 读取快照，只写 `/work` 与 `/scratch`，且没有网络。工具文本会标明每次截断。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [系统融合实现](../../../docs/integration/README.zh.md) — 开关、ACL、快照、Job 容器与验收状态。
- [平台架构](../../../services/platform/ARCHITECTURE.md) — Gateway、身份、Runtime 与融合组合。
- [模型工具约定](../../../docs/cookbook/adding-a-tool.zh.md) — 工具 schema、结果与展示规则。

-----

<a id="model-experience"></a>
## 模型体验

### 融合分析工具

#### 模型看到的内容

平台能力存在时有七个工具定义：`integration_list_resources`、`integration_list_workspaces`、`integration_read_resource`、`integration_create_snapshot`、`integration_run_analysis_job`、`integration_job_status` 与 `integration_read_job_artifact`。每个返回无损 JSON；资源与产物文本有上限并在截断时标记。

#### Token 影响

schema 与描述为每个融合 Runtime 的请求增加固定提示成本。工具结果只加入该次调用返回的资源或产物文本，并受 `maxContentChars` 限制。

#### KV Cache 影响

同一 Runtime 代际内工具 schema 稳定，因此不会使缓存项失效。读取结果只在调用后进入请求，不改变更早的提示前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **没有模型侧融合 Session 限制** — 这些工具是增量能力；平台尚未在融合 Session 中禁用 Shell、MCP、PTY、SSH、子 Agent、Schedule 或浏览器工具。
- **没有流式 Job 状态** — 模型轮询 `integration_job_status`。
- **产物只按文本读取** — 二进制产物按 UTF-8 解码，可能不可读。
- **没有连接器 URL 或业务写操作** — 工具不能直接调用宿主系统，也不能执行写操作。

<a id="dev-note"></a>
### 开发备注

空配置 no-op 是有意为之：基础 bundle 以禁用状态挂载该行，没有平台能力的 Runtime 必须保持原样。
