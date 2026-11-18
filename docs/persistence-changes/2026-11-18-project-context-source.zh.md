---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-18-project-context-source

[English](2026-11-18-project-context-source.md) | 中文

## 概述

为 Session 消息来源映射新增 `project-context` 变体，使一轮对话记录它所使用的 Workspace 与指令修订号。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-18-project-context-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-16-skill-invocation-version"
    after: "cc1793651441137011a66c84c9b6695ce6dc92aac3bad118a4a55de0cde16fea"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-16-skill-invocation-version"
    after: "a6508174a97d33bf479626daec5ea88f0e12ddf9567aec514fc79c42b6d8e3aa"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-16-skill-invocation-version"
    after: "7522698c4e7062ff0384ab959ec52823e161a3f91857d72f0a627e9740b5adbe"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-16-skill-invocation-version"
    after: "70bc8eaedb969d7c9e7b52a461e73200f276e6ce7cfba29258b0b41824e23a15"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

读取已有日志：旧记录只带此前的来源变体，无需解释新值。用较早的版本读取新日志：消息来源按数据处理，消费方用相等比较判断 `kind`，因此 `project-context` 来源不匹配 `user` 或 `retry` 分支，该消息按普通注入上下文处理。没有读取方会拒绝未知来源类型，因此 Session 格式版本不变。只有当 Workspace 持有项目指令时，写入方才会产生该变体。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/api/workspace-controller/tests/project-context.host.spec.ts：2 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
