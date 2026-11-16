# Agent Note: 技能广场垂直切片

Status: implemented

[English](2026-11-16-skills-plaza-vertical-slice.md) | 中文

## Problem

一段完成的对话里留着一条成功的方法：走过的步骤、调用的工具、识别坏结果的方式。此前没有任何东西把这条方法带到下一个任务里，技能也只能从磁盘目录进入目录。DevPack 要求一条人能跑通的闭环：把完成的一轮提炼成草稿，发布不可变版本，然后在输入框选中该版本，让 Host 为新的任务加载它。

## Decision

**广场已发布的技能进入既有 `ctx.skills` 注册表，而不是第二套目录。** `@deepseek-ai/dsh-skill-plaza` 在一个 `skill_plaza` 存储域里持有草稿、不可变版本、当前版本目录与生成任务，并注册一个提供方（`skill-plaza`，rank 400）：`list` 按工作区返回当前版本，`get` 严格加载候选所指定的已发布正文。模型目录、`skill` 工具、`/slug` pre-step 手势与 Web 选择器因此读同一份已发布表示，不存在会分叉的第二条加载路径。

**工作区是隔离键。** 每条记录都带所属工作区目录；每次读写都从调用方的 Session 解析一个目录（活动 agent 走 `workingDirectory.ensure`，否则读投影头），未指定 Session 时回落到 Host 默认目录。另一个工作区的记录是 `skillPlaza/not-found`，而不是被过滤掉的行，因此猜到 id 也拿不到。

**草稿以乐观并发推进，版本只追加。** `saveDraft` 与 `publish` 都比较调用方修订号与已存修订号，不一致时抛出带双方数值的 `skillPlaza/conflict`。发布先写版本记录（`skillId@version`，正文冻结），再写目录行，最后给草稿打 `skillId`；对同一草稿修订重复发布会返回它已产生的版本，而不是再造一个。调用名被其他技能占用时以 `skillPlaza/name-conflict` 拒绝。

**生成是一次 Host 侧结构化调用，不是第二个 agent loop。** `skillPlaza/generate` 先记录任务，取活动 Session 派生消息的尾部，用配置的默认路由按 JSON 合约调用，校验回复并存成草稿；模型或校验失败时把可读原因写进任务且不产生草稿。源 Session 的日志不会被写入。

**选择即绑定：一次选择把一个已发布版本钉到下一个指名它的任务。** `skillPlaza/pin` 为会话记录 `{skillId, version}`；广场自己的 `agent/pre-step` 监听器（`prepend` 注册）在既有 `/slug` 注入之后运行，名称匹配时丢弃那次注入，读取被钉版本的已存正文，再追加一条 `skill-invocation` 来源带 `version` 与 `provider` 的注入。被钉版本不存在时该步骤失败，而不会重新按名称解析。钉住状态存在 Host 内存里，因为持久化的逐消息引用需要新增 `SessionPromptRequest` 字段与来源成员；但被钉住的结果本身是持久化的。

**客户端是三处贡献，而不是分叉输入框。** `sidebar.panellist` + `main` 承载广场页与编辑器，`conversation.chat.assistant-actions` 在完成的回复上提供生成入口，`conversation.input.left` 提供把原生 `/slug` 文本经对话输入门面写进草稿的选择器。页面是无会话的根面板，因此插件从对话注册里记录活动 Session 并按它的工作区读写；没有 Session 时读 Host 默认目录。

## Evidence

目标检出：分支 `master`，提交 `39163dd30f`，仓库版本 `0.2.2-rc.3`，Windows，源码构建的 `dsh web` 配合 `DeepSeek-V4.1-Flash`，工作区 `D:\Vibe_coding\dsh-plaza-demo`。广场自身的持久记录位于 `/storages/skill_plaza.json`。

1. 一轮问答通过读取 `releases.md` 回答了指标对比（一次模型请求、三步、真实工具调用）。
2. 「生成 Skill」把该轮提炼成草稿 `draft-bedb3ec4…`，调用名 `compare-release-metrics-from-markdown`，修订号 1，落在该会话的工作区。
3. 广场页列出该草稿；修改标题与调用名后按「发布」保存为修订号 2，并发布 `release-metrics-compare` 版本 2（`skill-a7fff7a1…@2`，正文 2241 字节）。
4. 回到对话，「选择 Skill」只列出已发布条目（`release-metrics-compare · 版本 2`），并把 `/release-metrics-compare ` 写入输入框。
5. 发送后，模型在找不到 `v1.1.0` 时逐字引用了已发布正文里的失败处理规则（"If only one entry exists, state that no comparison is possible"），并为可读到的数据给出了技能格式的对比表。
6. 版本绑定：选择器提供版本 3 并写入 `/release-metrics-compare `；随后把草稿重新发布为版本 4，并在失败处理里加入唯一标记（`VNEW-…-SHOULD-NOT-APPEAR`）；发送草稿中的任务后，回复中没有该标记，而解码后的会话日志记录到 `user/message`，其 `source` 为 `{kind: skill-invocation, name: release-metrics-compare, version: 3, provider: skill-plaza}`。更新的发布没有替换这次选择。

## 验收

| 编号 | 结果 | 证据 |
|---|---|---|
| A01 | 通过 | 真实运行中广场直接打开了该回复产出的草稿 |
| A02 | 通过 | 生成以被点击回复的消息身份为界截取素材，而分叉会话自带独立日志，因此其他分支的内容无法进入（plaza-pre-step.spec.ts） |
| A03 | 通过 | 回复完成前不存在该入口：空会话与流式回复都不渲染生成入口，这由槽位契约保证 |
| A04 | 通过 | 第二个相同请求会加入正在运行的那次尝试，只产生一个任务与一个草稿；入口在忙时也会禁用（plaza-pre-step.spec.ts） |
| A05 | 通过（单测） | 生成失败时在任务上记录可读原因且不产生草稿（`plaza.spec.ts`） |
| A06 | 通过 | 生成的草稿把输入参数化，未携带源轮次中的具体 id、路径或数值 |
| A07 | 通过（单测） | 过期修订号以双方数值冲突，匹配的修订号推进（`plaza.spec.ts`）。未驱动两个窗口 |
| A08 | 通过 | 草稿存在期间，选择器只列出已发布条目 |
| A09 | 通过（单测） | 重复发布返回它已产生的版本；被占用的调用名被拒绝（`plaza.spec.ts`） |
| A10 | 通过 | 新版本无需重启应用即可列出 |
| A11 | 通过 | 选择器按名称、标题与用途经共享匹配器过滤，无匹配时显示空状态；选择与移除草稿文本仍然可用 |
| A12 | 通过 | 解码后的会话日志记录 `version: 3` 与提供方，该轮调用了文件工具 |
| A13 | 通过 | 选择之后发布了版本 4，其标记未到达模型 |
| A14 | 通过 | 同一次运行即「选择之后发布」的情形 |
| A15 | 通过（单测） | 另一个工作区列不出内容，也无法按 id 发布（`plaza.spec.ts`） |
| A16 | 通过 | 另注册的同名技能按 rank 胜出且广场条目仍然发布；与宿主命令同名时客户端会在其成为提示前先按命令裁决（plaza.spec.ts） |
| A17 | 通过 | 每个流程中的普通问答都正常，包括技能调用之后 |
| A18 | 通过 | 用 overlay 关闭两行后，侧栏入口与输入框选择器消失，对话仍正常渲染且无控制台错误；已存草稿仍在同一存储域文件中 |

## Verification commands

- `pnpm run build` —— 十项构建门禁，产物包含两个新包。
- `dsh --profile web --dump-config` —— 组合出 `skill-plaza` 与 `ui-skill-plaza`。
- `verify-package-readme-{summaries,limitations,model-experience}`、`check-workspace-constraints`、`verify-agent-note-format` —— 全绿。
- `pnpm run persistence-changes --record 2026-11-16-skill-invocation-version` —— 记录新增的两个可选来源字段。
- `npx vitest run packages/skill/skill-plaza/tests packages/client/ui-skill-plaza/tests` —— 20 个测试通过：11 个真实组合的 Host 测试（草稿、冲突、发布、提供方加载、钉住、工作区隔离、生成失败）与 9 个客户端测试（注册、注入面、拒绝钉住、拆除、惰性的 node 半边）。

## Alternatives considered

**只给广场做一套独立目录并直接喂给输入框**能让草稿与版本留在技能注册表之外，但会造成第二条加载路径：选择器展示一份正文，`/slug` 手势加载另一份。注册一个提供方保留了一种表示，并让既有的目录、工具与手势承载结果。

**复用文件系统提供方，把 `SKILL.md` 写到磁盘**能免费获得目录带来的版本身份，但发布就变成了对用户工作区的文件改动，且不可变版本与被编辑的文件无法区分。把正文存在广场域里让发布保持原子，并且不动工作区内容。

**通过 profile 的 bundle 机制发布**会把技能变成插件，这与产品模型冲突：广场技能是给 agent 的内容，不是服务组合。

## Consequences

写入方每次保存与发布多一次修订比较，读取方每个工作区一次目录读取；发布会失效提供方目录，使下一次读取列出新版本。由于提供方在进程内，Host 重启后下一次查找会重新读域，第二个 Host 进程能看到已存目录但没有变更通知。

输入框仍保留纯文本引用模型，因此一次选择是 `/slug` 文本加上 Host 侧查找；这保持了既有引用语义，但把持久化的逐消息绑定留作下一步。任何 Session 都未指向的草稿在页面里不可达，直到有 Session 选中它的工作区，页面如实说明这一点而不是掩盖。

## What this record does not claim

钉住状态是 Host 内按会话保存的内存，因此在选择与发送之间重启 Host 会回落到按名称解析；持久化引用需要 `SessionPromptRequest` 字段、`MessageSource` 成员与 `tool-skill` 读取，以及对应的持久化记录。生成仍在 Remote 请求内同步执行，没有持久队列。两个新包还没有 spec，因此逐文件覆盖门禁对它们是红的；提交进仓库的生成物（`api-catalog.ts`、`config-catalog`、`module-graph`、`client-catalog`、`packages.md`）尚未重新生成。