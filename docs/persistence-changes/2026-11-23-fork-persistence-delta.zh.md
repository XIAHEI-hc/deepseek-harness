---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-23-fork-persistence-delta

[English](2026-11-23-fork-persistence-delta.md) | 中文

## 概述

一并记录本 fork 的两处增量式 Session 类型更改，因为上游合并把二者共用的 root 放到了更新的上游确认之后。显式 skill 调用现在记录已发布版本与提供方，记录下来的用户消息也可以带 `project-context` 来源，指明该轮使用的 Workspace 与指令修订号。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-23-fork-persistence-delta
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-19-cua-input-notices"
    after: "0eae9705ea499ebe53079c434eea7f8bb9223a8ca28eac3c9199f816343104c2"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-19-cua-input-notices"
    after: "002e1dcca8f12f5215627d9b8630afcd720b026428b251d27a730f466504c90a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-19-cua-input-notices"
    after: "6ecc5ec88e441562d58bc96ee4aa25ec3baafc7b3903dd4f75e5556139b3aec5"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-19-cua-input-notices"
    after: "9ad7672c1809dae84b8923e0f3f0eda7c4a5ccfaafd5fabfbd0ef254e6475006"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效。调用字段是可选的，忽略它们的读取方看到的调用与之前相同；当调用方固定了已发布版本时写入方会写入它们，缺省仍表示正文在注入时按名称解析。对消息来源而言，旧日志只带此前的变体，无需解释新值；用较早版本读取新日志时，来源按数据处理，消费方用相等比较判断 `kind`，因此 `project-context` 不匹配 `user` 或 `retry` 分支，消息按普通注入上下文处理。没有读取方会拒绝未知来源类型，因此 Session 格式版本不变。

<a id="verification"></a>
## 验证

pnpm run build（10 个 gate）通过；一次真实的 dsh web 运行注入了固定版本，解码后的日志记录了 `{kind: skill-invocation, name: release-metrics-compare, version: 3, provider: skill-plaza}`。pnpm exec vitest run packages/api/workspace-controller/tests/project-context.host.spec.ts 两项测试通过。

<a id="dev-note"></a>
## 开发备注

无。
