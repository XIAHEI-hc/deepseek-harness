---
description: "技能广场的界面：目录与详情页、带草稿预览的编辑器、完成回复上的生成入口，以及输入框的技能选择器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-skill-plaza

[English](README.md) | 中文

## 概述

本插件为 Web 客户端提供技能广场：一个侧栏入口，其页面用来浏览工作区里已发布的技能、打开某个精确版本的概览、执行流程与使用说明，并在发布前编辑草稿的展示内容。它还提供完成回复上的「生成 Skill」操作，以及把已发布技能的原生 `/name` 手势写入草稿的输入框选择器。所有读写都经由 `skillPlaza` Remote，插件本身不持有广场状态。

## 目录

- [使用本包](#use-this-package)
- [Model Experience](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

把该行挂载到 Web profile 的浏览器端清单：

```yaml
- id: ui-skill-plaza
  name: '@deepseek-ai/dsh-client-ui-skill-plaza'
```

插件依赖 `conversation`、`layout`、`locale`、`remote.skillPlaza`、`sessions`、`slots` 与 `uiWorkspace` 服务，并需要在 Host 上挂载 `@deepseek-ai/dsh-skill-plaza`。

### 界面位置

| 界面 | 插槽 | 作用 |
|---|---|---|
| 侧栏入口与页面 | `sidebar.panellist`、`main` | 带搜索与分类的目录浏览、打开某个已发布版本、编辑并预览草稿、发布版本 |
| 生成入口 | `conversation.chat.assistant-actions` | 把该回复所属的轮次沉淀成草稿，并在编辑器中精确定位该草稿 |
| 技能选择器 | `conversation.input.left` | 列出已发布技能，按名称、标题或用途筛选，并把 `/name ` 写入草稿 |

草稿编辑会带上渲染时的修订号，因此另一个窗口的保存会表现为冲突，并保留本地内容供复制，而不是静默覆盖。

### 页面与状态

页面所属的工作区，取当前挂载了会话界面的那个会话；没有挂载会话时指向 Host 默认目录。工作区变化会整体重挂视图，这样某个工作区的详情页、已加载图片与进行中的读取不会渗到另一个工作区。

「在对话中使用」会钉住详情页当前显示的版本，只有钉住成功后才插入调用指令；输入框已有内容保留，且不会自动发送。当前没有会话时，它走平台已有的新建会话入口创建会话，再插入。

## Model Experience

本插件不产生模型输入：它只把原生 /name 文本写入未发送的草稿，并读取 Host 的广场 Remote。

#### KV 缓存影响

无；发布正文由 `@deepseek-ai/dsh-skill-plaza` 提供方提供，缓存影响归它所有。

## 已知限制与后续工作

- **选择器插入的是文本，不是绑定引用** — 选中的技能变成原生 `/name` 文本，因此 Host 会注入下一步钉住的版本，没有钉住时注入当前版本。广场自身的页面总是在插入前先钉住。
- **流程编辑器是表单式的** — 节点与带标签的连线通过表单列表增删改，没有拖拽式画布编辑。
- **每张示例图一次上传** — 节点引用草稿里已上传的某张示例图，而不是自己独立的上传控件。
- **页面读取已挂载会话的工作区** — 在没有打开会话时进入广场，指向 Host 默认目录，而不是用户挑选的某个工作区。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>维护者工作上下文——点击展开</summary>

流程层按标识寻址而不是嵌套，与 Host 的平铺流程载荷一致；流程视图保存一个「打开节点」的栈，因此从子流程返回时会恢复父节点的选中状态。

</details>
