---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-18-project-context-source

English | [中文](2026-11-18-project-context-source.zh.md)

## Summary

Adds a `project-context` variant to the Session message-source map, so a turn records the Workspace and instruction revision it ran with.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Reading existing logs: earlier records carry only the previous source variants, so no new value needs interpretation. Reading a new log with an earlier build: a message source is read as data and consumers compare its `kind` by equality, so a `project-context` source matches no `user` or `retry` branch and the message stays ordinary injected context. No reader rejects an unrecognized source kind, so the Session format version does not move. Producers add the variant only when the Workspace holds project instructions.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/api/workspace-controller/tests/project-context.host.spec.ts: 2 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
