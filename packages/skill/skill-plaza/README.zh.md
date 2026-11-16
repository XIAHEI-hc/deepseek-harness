---
description: "技能广场的数据面：草稿、不可变的发布版本，以及技能目录与 /name 调用共用的工作区范围技能提供方。"
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-plaza

[English](README.md) | 中文

## 概述

本包把一段已完成的对话沉淀成可复用技能。它保存草稿、发布不可变版本，并注册一个技能提供方，让发布后的正文通过常规技能目录和 `/name` 手势力被 agent 读到。草稿带修订号保护；已发布版本只追加，并按调用方选择的版本取用。提供 Skills 广场的应用需要把它与 `dsh-skill` 一起挂载。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [Model Experience](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

挂载插件，为一个 Harness home 提供持久技能广场：

```yaml
- id: skill-plaza
  name: '@deepseek-ai/dsh-skill-plaza'
```

它依赖 `ctx.storageDomain`、`ctx.skills`、`ctx.llm`、`ctx.agents`、`ctx.sessionQuery` 和 `ctx.workingDirectory`，并新增 `skillPlaza` Remote 命名空间。

### 存储内容

`skill_plaza` 存储域中有四张表：草稿（可变，按 `revision` 保护）、已发布版本（不可变，键为 `skillId@version`）、当前版本目录，以及生成任务。每条记录都带所属工作区目录，因此一个 Harness home 可以容纳多个工作区的广场，而不需要第二套存储。

### Remote 能力

| 方法 | 作用 |
|---|---|
| `skillPlaza/catalog` | 某一工作区可调用的已发布技能及其当前版本 |
| `skillPlaza/drafts` | 某一工作区的草稿，最近保存的在前 |
| `skillPlaza/saveDraft` | 新建草稿，或替换修订号仍匹配的草稿 |
| `skillPlaza/publish` | 写入不可变版本并置为当前版本；对同一草稿修订重复发布会返回它已产生的版本 |
| `skillPlaza/pin` | 把一个已发布版本绑定到该会话的下一次显式调用 |
| `skillPlaza/generate` | 通过已配置模型从活动会话的已完成轮次提炼草稿 |
| `skillPlaza/job` | 读取一次生成任务 |

不带 `sessionId` 的读写使用 Host 的默认工作目录。

### 技能提供方

已发布技能以 `skill-plaza` 提供方名进入 `ctx.skills`，`modelInvocable` 与 `userInvocable` 均为 true。提供方列出当前版本，并严格加载 `list` 当时返回的已发布正文，因此一次选择不会因为随后发布了同名新版本而改变。发布会使目录失效，下一次读取即列出新版本。

-----

<a id="understand-the-implementation"></a>
## 实现说明

草稿以乐观并发推进：`saveDraft` 比较 `expectedRevision` 与已存修订号，不一致时抛出 `skillPlaza/conflict` 并带上双方数值，而不是覆盖；`publish` 在写版本前做同样的校验。发布先写版本记录，再写目录行，最后给草稿打上 `skillId`；重复发布会按草稿修订找到已有版本，因此重试不会产生第二个版本。

生成同步运行已配置的模型路由，并在调用前后记录任务。失败时把可读原因写进任务且不产生草稿，重试从干净的一次尝试开始。调用名冲突在发布时以 `skillPlaza/name-conflict` 拒绝，判据是工作区目录而非调用方列表。

## Model Experience

### 已发布技能正文

间接生效，经由 `@deepseek-ai/dsh-skill`：已发布正文只有在技能注册表为 `skill` 工具或用户显式 `/name` 手势渲染 `<skill_content>` 块时才会到达模型。

#### What the model sees

`<skill_content>` 中逐字出现的已发布 Markdown 正文，开头属性里是技能的 kebab-case 名称。草稿、修订号和任务记录不会进入模型。

#### Token effect

每次显式调用注入一份正文，长度以该正文为限。目录中除技能名与描述外不增加任何内容。

#### KV Cache effect

新的发布版本会改变之后注入的正文；此前的工具结果和注入块仍是 Session 日志中的历史事实。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **生成是同步的** — `generate` 在 Remote 请求内完成模型调用并记录任务；重复请求会加入正在运行的那次尝试。没有持久队列，所以生成期间重启 Host 会丢失该次尝试，调用方需要重新发起。
- **素材以被点击的回复为界** — 生成以该回复的消息身份截取对话；若 Session 已不持有该身份，则回退到最近若干条消息。
- **钉住状态只存在于 Host 内存** — `skillPlaza/pin` 只记录该会话下一次显式调用的版本并在该步骤消费。选择与发送之间重启 Host 会丢失它，该步骤随后按名称解析到当前版本。
- **轮次身份未校验** — `generate` 记录传入的 `turnId`，但不核对 Session 日志中是否存在该轮次。
- **每次调用只处理一个工作区** — 读写只解析一个工作区目录，没有跨工作区视图。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>