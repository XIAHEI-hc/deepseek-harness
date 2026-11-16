---
description: "技能广场的界面：侧栏页面与编辑器、完成回复上的生成入口，以及输入框的技能选择器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-skill-plaza

[English](README.md) | 中文

## 概述

本插件为 Web 客户端提供技能广场：一个侧栏入口及其页面（读取草稿、编辑并发布版本）、完成回复上的「生成 Skill」操作，以及把已发布技能的原生 `/name` 手势写入草稿的输入框选择器。所有读写都经由 `skillPlaza` Remote，插件本身不持有广场状态。

## 目录

- [使用本包](#use-this-package)
- [Model Experience](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

把该行挂进 Web profile 的浏览器清单：

```yaml
- id: ui-skill-plaza
  name: '@deepseek-ai/dsh-client-ui-skill-plaza'
```

插件依赖 `conversation`、`layout`、`locale`、`remote.skillPlaza`、`sessions` 和 `slots` 服务，并要求 Host 侧挂载 `@deepseek-ai/dsh-skill-plaza`。

### 界面入口

| 入口 | 槽位 | 作用 |
|---|---|---|
| 侧栏入口与页面 | `sidebar.panellist`、`main` | 列出工作区的草稿与已发布技能；保存草稿、发布版本 |
| 生成入口 | `conversation.chat.assistant-actions` | 从该回复的轮次提炼草稿，然后打开广场页面 |
| 技能选择器 | `conversation.input.left` | 列出已发布技能，可按名称、标题或用途过滤，并把 `/name ` 插入草稿 |

草稿保存会带上渲染时的修订号，因此另一个窗口的保存会表现为冲突，而不是静默覆盖。

## Model Experience

None, as this plugin writes the native /name text into the unsent composer draft and reads Host plaza Remotes.

#### KV Cache effect

None; the published body is supplied by the `@deepseek-ai/dsh-skill-plaza` provider, which owns that effect.

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **选择器插入的是文本而非绑定引用** — 选中的技能变成原生 `/name` 文本，因此 Host 在 pre-step 加载的是当时生效的版本，而不是选择器展示的版本。
- **页面面向 Host 的默认工作区** — 尚未实现按会话切换工作区的广场视图；只有对话入口会传会话身份。
- **没有富预览** — 编辑器只编辑纯文本字段，不渲染草稿正文的 Markdown 或 Mermaid 预览。
- **不能编辑图片与示例附件** — 草稿只承载文本字段。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>