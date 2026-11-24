---
description: "DSH 多用户平台的 Web 客户端插件：侧栏平台身份入口与个人运行环境启动/失败状态层，并与模型供应商账户严格分开。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-platform-identity

[English](README.md) | 中文

## 概述

Web 客户端在保持原生 DSH 页面不变的前提下新增两个界面：侧栏底部显示已登录平台用户的显示名、工号与生成式首字母头像的入口，以及网关准备该用户个人 DSH 运行环境时全屏显示的状态卡片。入口提供只读账号面板、模型供应商设置页、平台退出与退出所有设备。平台身份来自网关的 `/auth/me`；模型供应商账户界面永不被读取、复用或冒充成该身份。没有平台网关时（`/auth/me` 返回 404 或无法访问），两个界面都不渲染，原生客户端保持原样。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

插件需要 `slots` 与 `locale` 服务。它向设置外壳渲染的侧栏底部贡献 `settings.platform-launcher`（single、root），并向应用框架的 overlay 层贡献 `shell.overlay`。

### 平台身份入口

入口仅在平台用户已登录时渲染。它显示 W3 显示名、以 `W3 · <uid>` 呈现的工号，以及生成式首字母头像；不读取任何第三方图片源。侧栏收起为窄条时只保留头像，并以“显示名 · 工号”作为无障碍名称。

菜单包含四项：

- **账号信息**：打开只读面板，展示显示名、工号与 W3 subject，并说明这是 DSH 平台身份、模型供应商账户在别处单独管理。
- **模型供应商设置**：通过外壳自己的导航打开设置面板的 `models` 分区。若外壳占位不提供设置导航能力，则回退到应用根页面。
- **退出 DSH**：撤销当前浏览器的平台会话并返回 `/login`。请求失败时显示 toast，页面保持不变。
- **退出所有设备**：确认后撤销该身份在所有浏览器上的平台会话（含当前浏览器）。取消不发送请求；请求失败时显示 toast，页面保持不变。

### 个人运行环境状态

网关为每个平台用户分配一个 DSH 运行环境。运行环境就绪前状态层会遮挡原生客户端，并按结果给出反馈：

| 运行状态 | 界面 |
|---|---|
| `UNALLOCATED`、`STOPPED` | 申请运行环境，然后轮询 |
| `PROVISIONING`、`STARTING`、`STOPPING` | “正在准备你的个人工作区”，每两秒轮询一次 |
| `READY` | 不显示状态层；原生客户端完全可用 |
| `FAILED` | 展示网关错误码与重试按钮；网关报告 `retryable: false` 时按钮禁用 |
| 无法连接 | 提供重新尝试动作 |

轮询在 60 次检查后停止，改为提供重新尝试而不是无限等待。

### 退出与本地状态

任何平台 API 返回 401 都会先清理本地身份与运行状态，再返回 `/login?return_to=<当前路径>`，上一个用户的数据不会留在界面上。退出时读取非 HttpOnly 的 `dsh_csrf` Cookie 并作为 `x-csrf-token` 发送；退出所有设备还发送 `x-dsh-confirm: logout-all`，身份服务在撤销全部会话前要求该确认头，避免跨站表单触发。HttpOnly 会话 Cookie 始终只由浏览器携带。模型供应商退出仍是设置账户菜单中的独立动作，不会触碰该会话。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 —— 点击展开</summary>

### 身份状态机

`src/client/state.ts` 为每个插件主体持有一个控制器。它发布一个快照，包含平台身份（`loading`、`ready`、`unauthorized`、`disabled`、`unavailable`）与运行环境视图（`idle`、`checking`、`starting`、`failed`、`unavailable`、`ready`）。两个界面都通过 `platformIdentity` hook 隔间读取它；控制器不创建模块级单例。

- `GET /auth/me` 区分 401（会话结束）、403（账号停用）、404 与网络失败（平台界面不可用），以及格式错误响应（同样视为不可用）。
- 身份就绪后，`GET /api/runtime/me` 选择运行环境分支。`UNALLOCATED` 与 `STOPPED` 先调用 `POST /api/runtime/wake`；启动中状态安排下一次检查；`FAILED` 记录网关的 `errorCode` 与 `retryable`。
- 变更类请求——wake、retry、退出——都会把 `dsh_csrf` Cookie 回显到 `x-csrf-token`；读取类请求不携带 CSRF 头。

插件随 Cordis fiber 释放控制器、定时器与监听器。

### 槽位与布局归属

设置外壳（`ui-settings-general`）声明并渲染自身启动器行上方的 `settings.platform-launcher`；本包用 `ctx.slots.inject` 等待该声明。状态层是应用框架（`ui-layout`）拥有的 `shell.overlay` 列表条目，并把阻塞卡片 portal 到 document body。两个贡献与 `platform` 字典都随插件 fiber 移除。

### 文案与样式

所有可见文案都在 `platform` 字典中（zh/en 以及 ja、es、fr、de、ru、pt），并通过标准 `t` 座位到达组件。样式是共享 `--dsw-*` 别名之上的 CSS Modules；状态层在下方保留原生客户端挂载，是本包唯一绘制的阻塞界面。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-settings-general](../ui-settings-general/README.zh.md) —— 声明平台启动器槽位的设置外壳。
- [ui-layout](../ui-layout/README.zh.md) —— 拥有 shell overlay 层的应用框架。
- [槽位参考](../../../docs/subsystems/slots.zh.md) —— 槽位声明、注入面与 hook 隔间。
- [平台服务架构](../../../services/platform/ARCHITECTURE.md) —— 本包消费的网关身份与运行时 API。

-----

<a id="model-experience"></a>
## 模型体验

### 仅浏览器端的平台界面

#### 模型看到的内容

没有。启动器与运行状态层在浏览器中读取 `/auth/me` 与 `/api/runtime/*`，不注册提示词段落、工具、工具结果或 Session 事件。

#### Token 影响

无。本包不发起模型请求，也不向请求添加任何上下文。

#### KV Cache 影响

无。本包注册的内容不会改变模型请求，因此没有依赖它的缓存条目。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了当前的平台 UI 契约。

- **没有平台网关就没有身份界面** —— `/auth/me` 返回 404 或失败时，原生 DSH 客户端保持原样；平台入口刻意不渲染错误行。
- **账号面板是只读的** —— 资料编辑与会话列表属于平台服务，本包不提供。
- **运行环境恢复按页面受限** —— 轮询在 60 次两秒检查后停止；始终不就绪的运行环境需要重新尝试或刷新页面。
- **模型供应商账户按设计分离** —— 本包从不读取 DeepSeek 账户、余额或模型登录状态，模型供应商菜单仍是这些动作的唯一入口。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

网关契约记录在 `services/platform/ARCHITECTURE.md`；浏览器永远看不到运行环境端口或路径。状态层的阻塞卡片不做键盘焦点陷阱，这与原生客户端的非模态状态行为一致。

</details>
