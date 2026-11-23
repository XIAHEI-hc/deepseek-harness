---
description: "DSH 平台融合 API 的可选 Web 客户端工作台：授权只读资源、分析工作区与作业来源；融合不可用时没有界面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-integration-workbench

[English](README.md) | 中文

## 概述

该插件在原生 DSH 外壳中加入一个可选启动器。它只读取一次 `/api/integration/status`；未启用融合的部署不渲染任何内容，也不会再发起请求。服务可用时，面板只列出当前登录用户被授权的系统与资源，创建不可变快照、逻辑分析工作区、短生命周期分析作业，并展示带来源的产物。聊天 Runtime、模型供应商与原生 Session UI 均保持不变。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

插件需要 `slots` 与 `locale` 服务，并向 `shell.overlay` 贡献一个入口。可用性加载中或部署级关闭融合时，启动器不存在。服务被阻止时仍会打开面板并列出缺项代码；数据路由继续由网关拒绝。

面板支持与 HTTP API 相同的流程：选择系统、为授权资源创建快照、创建或选择工作区、选择 Shell 或 Python、运行脚本、刷新作业状态、取消排队中或运行中的作业，并下载每个产物。

<a id="understand-the-implementation"></a>
## 理解实现

### 可用性

`src/client/controller.ts` 只读取一次 `/api/integration/status`。404 或传输失败发布 `unavailable`，组件返回空。200 发布服务状态；`disabled` 也视为不可用。控制器随插件 fiber 释放。

### 数据与变更

`src/client/api.ts` 执行同源请求。变更请求把非 HttpOnly 的 `dsh_csrf` cookie 放入 `x-csrf-token`；浏览器从不读取 HttpOnly 会话 cookie。组件把面板数据保存在局部状态，只在用户操作时刷新，因此插件不持有轮询定时器或模块级缓存。

### 文案与样式

可见文案位于 `fusion` 字典（zh/en 以及 ja、es、fr、de、ru、pt），通过 `t` 座位到达组件。样式是共享 `--dsw-*` 别名之上的 CSS Modules。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [系统融合实现](../../../docs/integration/README.zh.md) — 开关、ACL、快照、作业与安全边界。
- [平台架构](../../../services/platform/ARCHITECTURE.md) — Gateway、身份、Runtime 与融合组合。
- [Slots 参考](../../../docs/subsystems/slots.zh.md) — 槽声明、注入面与 hook 隔间。

-----

<a id="model-experience"></a>
## 模型体验

### 仅浏览器的融合界面

#### 模型看到的内容

无。工作台在浏览器中读写 `/api/integration/*`，不注册提示段、工具、工具结果或 Session 事件。

#### Token 影响

无。该包不发起模型请求，也不向模型请求添加上下文。

#### KV Cache 影响

无。该包注册的内容不能改变模型请求，因此没有缓存项依赖它。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **没有融合 API 就没有界面** — 未启用该功能的部署不渲染启动器，除首次状态读取外不发起融合请求。
- **没有模型侧工具** — 工作台是人的界面；读取资源与运行作业的 Agent 工具不属于该包。
- **没有作业流式推送** — 状态变化在用户刷新行后出现；面板不订阅服务端事件。
- **只有逻辑 id** — 面板从不显示或接受宿主路径；工作区与产物身份由平台生成。

<a id="dev-note"></a>
### 开发备注

面板是网关 API 之上的人用界面。缺少 Agent 工具、服务端作业事件与宿主路径是有意为之：它们需要独立的能力装配，不是该包里的隐藏回退。
