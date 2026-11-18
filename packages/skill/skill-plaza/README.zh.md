---
description: "技能广场的数据面：带展示内容的草稿与不可变发布版本、工作区媒体，以及技能目录与 /name 调用共用的工作区范围技能提供方。"
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-plaza

[English](README.md) | 中文

## 概述

本包把一段已完成的对话沉淀成可复用技能。它保存草稿、发布不可变版本、保留已发布版本展示的结果图与流程图，并注册一个技能提供方，让发布后的正文通过常规技能目录和 `/name` 手势力被 agent 读到。草稿带修订号保护；已发布版本只追加，并按调用方选择的版本取用。提供 Skills 广场的应用需要把它与 `dsh-skill` 一起挂载。

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

`skill_plaza` 存储域中有六张表：草稿（可变，按 `revision` 保护）、已发布版本（不可变，键为 `skillId@version`）、当前版本目录、生成任务、工作区媒体（不可变图片），以及版本绑定（钉给某会话下一次显式调用的版本）。每条记录都带所属工作区目录，因此一个 Harness home 可以容纳多个工作区的广场，而不需要第二套存储。域版本 2 仍可读取版本 1 的数据：展示内容出现之前写入的记录依旧可读，只是没有 `presentation`。

### Remote 能力

| 方法 | 作用 |
|---|---|
| `skillPlaza/catalog` | 某一工作区可调用的已发布技能及其当前版本、分类和封面 |
| `skillPlaza/drafts` | 某一工作区的草稿，最近保存的在前 |
| `skillPlaza/detail` | 某个精确的已发布版本——它的正文与展示数据，不会误取当前版本 |
| `skillPlaza/saveDraft` | 新建草稿，或替换修订号仍匹配的草稿 |
| `skillPlaza/check` | 发布前会阻塞的、带位置的问题，不写入任何数据 |
| `skillPlaza/publish` | 先校验，再写入不可变版本并置为当前；同一草稿修订的重复发布返回它已生成的版本 |
| `skillPlaza/pin` | 把某个已发布版本绑定到会话的下一次显式调用 |
| `skillPlaza/generate` | 启动——或加入——把在线会话的一轮完成回复沉淀成草稿的尝试；调用在尝试仍运行时即返回 |
| `skillPlaza/cancel` | 停止一次正在运行的尝试，并返回它落定的记录 |
| `skillPlaza/job` | 读取一次生成任务，包括运行中的尝试所报告的阶段与字数 |
| `skillPlaza/uploadMedia` | 在工作区保存一张 PNG、JPEG 或 WebP |
| `skillPlaza/readMedia` | 从工作区读取一张已保存图片 |

不带 `sessionId` 的读写指向 Host 默认工作目录。

### 展示内容

`PlazaDraftContent` 携带模型读取的执行字段（`title`、`slug`、`description`、`inputs`、`steps`、`outputs`、`verification`、`failureHandling`、`toolDependencies`），另有一个可选的 `presentation`，包含 `schemaVersion`、`category`、`scenarios`、`examplePrompt`、`coverAssetId`、`examples` 和 `workflow`。展示内容只用于显示：`renderSkillBody` 从不读取它，因此流程图不会意外变成模型指令。

流程图是一组平铺的层加一个根层标识。节点通过 `subflowLayerId` 指明它打开的层，这样既能表达分支、汇合和嵌套子流程，又不会产生 Remote 编解码器拒绝的递归载荷。层最多嵌套三层。

### 媒体

上传按文件签名判定，不按文件名或声明的媒体类型：PNG、JPEG 与 WebP 会被解析出像素尺寸，其余一律以 `skillPlaza/unsupported-media` 拒绝。每张图片以上传工作区内的不可变 `assetId` 保存一次，单张上限 10 MiB、单边 8192 像素。已发布版本引用资源标识，因此之后替换草稿里的图片不会改变旧版本显示的内容。

### 技能提供方

已发布技能以提供方名 `skill-plaza` 进入 `ctx.skills`，`modelInvocable` 与 `userInvocable` 均为真。提供方列出当前版本，并精确加载 `list` 返回的那个已发布正文，因此一次选择不会因为之后发布了同名技能而改变。发布会使目录失效，下一次读取即列出新版本。

-----

<a id="understand-the-implementation"></a>
## 实现说明

草稿以乐观并发推进：`saveDraft` 比较 `expectedRevision` 与已存修订号，不一致时抛出带双方数值的 `skillPlaza/conflict` 而不覆盖，`publish` 在写入版本前也做同样检查。发布会先写版本记录，再写目录行，最后补草稿的 `skillId`；重复发布按草稿修订号找到已存在的版本，因此重试不会产生第二个版本。

发布会对整份展示载荷按工作区媒体做完整校验：重复节点标识、缺失入口节点、断链、不可达节点与层、判断分支缺标签、无法解析的资源，以及尺寸上限，都以带内容路径的 `PlazaIssue` 报告。`check` 不写入就返回同一批问题，编辑器可以在尝试发布前标出它们。

生成会在模型调用前记录一次尝试并立即回答调用方；模型调用在该记录之后运行，记录它到达的阶段（`harvest`、`distill`、`check`、`save`）以及模型已产生的字数。尝试运行期间的重复请求会加入它，而不是再起一次模型调用；失败或已取消之后的请求会运行同一任务的下一次尝试。`cancel` 中止这次模型调用并存为 `cancelled`；在尝试落定之后到达的调用原样返回它。失败会把可读原因存到任务上且不产生草稿，因此重试从干净的一次尝试开始。调用名冲突在发布时以 `skillPlaza/name-conflict` 拒绝；该检查读取工作区目录，而不是调用方手里的列表。

调用方钉住版本时，绑定写入 `pins` 表，并由 `agent/pre-step` 处理器在下一步真正点名该调用名时消费。持久化正是选择能跨 Host 重启生效的原因；处理器还会丢弃工作区已不匹配的绑定，因此在一个工作区读取的广场不会被注入到另一个工作区的会话里。

## Model Experience

### 已发布技能正文

#### 模型看到什么

已发布的 markdown 正文原样出现在 `<skill_content>` 内，开标签带技能的 kebab-case 名称，由技能注册表为 `skill` 工具或用户显式 `/name` 手势渲染。草稿、展示内容、媒体与任务记录都不会进入模型。

#### Token 影响

每次显式调用注入一份正文，长度以该正文为限。目录中除技能名称与用途外不新增任何内容。

#### KV 缓存影响

新的已发布版本会改变之后调用注入的正文；更早的工具结果与注入块仍是会话日志中的历史事实。展示内容与图片从不进入请求，因此编辑它们不会移动缓存。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **一次尝试比请求活得久，但活不过 Host** — `generate` 立即返回，模型调用运行在 Host 进程里。生成期间重启 Host 会丢失该次尝试；已存的记录仍会报告它最后到达的阶段，调用方重新发起即可。没有持久队列。
- **取消停止的是调用，不是记录** — `cancel` 中止模型调用并把尝试落定为 `cancelled`；任务、它的阶段历史与尝试计数仍可读取。
- **沉淀素材止于被点击的那条回复** — 生成以该回复的消息标识为界；会话中已不存在该标识时退回最近若干消息。
- **媒体存放在存储域里** — 图片以 base64 存于 `media` 表而非域旁的文件，因此一条记录会在后端整体重写的域文档里占下其编码后的体积。在图片经常逼近 10 MiB 上限之前，应改为逐记录布局或独立的 blob 存储。
- **媒体没有删除路径** — 已上传的图片永不删除，这正是旧发布版本在其草稿改动后仍然可读的原因；代价是被弃用的上传会一直保留。
- **轮次标识未经验证** — `generate` 直接记录传入的 `turnId`，不检查会话日志中是否真的存在该轮。
- **每次调用一个工作区** — 读写只解析一个工作区目录，没有跨工作区的广场视图。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>维护者工作上下文——点击展开</summary>

流程图采用平铺的层结构，是因为 Remote 编解码器拒绝未命名的递归载荷；嵌套的 `subflow` 对象会在 Typert 生成阶段失败，而不是在运行时。

</details>
