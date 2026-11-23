---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-23-fork-persistence-delta

English | [中文](2026-11-23-fork-persistence-delta.zh.md)

## Summary

Records the fork's two additive Session type changes together, because the upstream merge placed their shared roots behind newer upstream acknowledgements. An explicit skill invocation now records the published version and serving provider, and a logged user message can name a `project-context` source carrying the Workspace and instruction revision the turn ran with.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing records remain valid. The invocation fields are optional, so a reader that ignores them sees the same invocation it saw before; producers write them whenever a caller pinned a published version, and absence still means the body was resolved by name at injection time. For the message source, earlier logs carry only the previous variants and need no interpretation; an earlier build reading a newer log treats a source as data and compares `kind` by equality, so a `project-context` source matches no `user` or `retry` branch and the message stays ordinary injected context. No reader rejects an unknown source kind, so the Session format version does not move.

<a id="verification"></a>
## Verification

pnpm run build (10 gates) passed and a live dsh web run injected the pinned version, whose decoded log recorded `{kind: skill-invocation, name: release-metrics-compare, version: 3, provider: skill-plaza}` after version 4 was published. pnpm exec vitest run packages/api/workspace-controller/tests/project-context.host.spec.ts passed both tests.

<a id="dev-note"></a>
## Dev Note

None.
