---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-16-skill-invocation-version

[English](2026-11-16-skill-invocation-version.md) | 中文

## 概述

在显式技能调用的持久化记录上写入已发布版本与服务提供方，使日志能指明 Host 实际注入的正文。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-16-skill-invocation-version
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-timeline-priority-notice"
    after: "ead8e281100eb860d8f3be96ae90389d31e1ccb5ea74b5ea0fc5b6ed0cbe5f63"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "e3405b817f8b0f7605662dd133a91bf6ca50d896af167616752259976a735d59"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "5b9b385634b24f041ab3f7cd25684fae0e7598c42197776deeb896f21f112875"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "799610bd008f0e93796bdad09d158ed623c4dfa4ea18747e4dc769360476f2c2"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

既有记录仍然有效：两个字段均为可选，忽略它们的读取方看到的调用与之前一致。写入方在调用方钉住已发布版本时写入这两个字段；缺失仍表示正文在注入时按名称解析。

<a id="verification"></a>
## 验证

pnpm run build（10 项门禁）通过；真实 dsh web 运行注入了被钉住的版本，解码后的会话日志在版本 4 已发布之后记录到 user/message source {kind: skill-invocation, name: release-metrics-compare, version: 3, provider: skill-plaza}。

<a id="dev-note"></a>
## 开发备注

无。
