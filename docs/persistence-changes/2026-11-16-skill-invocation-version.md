---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-16-skill-invocation-version

English | [中文](2026-11-16-skill-invocation-version.zh.md)

## Summary

Records the published skill version and serving provider on an explicit skill invocation, so the log names the body the Host injected.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing records remain valid: both fields are optional and a reader that ignores them sees the same invocation it saw before. Producers now write them whenever a caller pinned a published version; absence still means the body was resolved by name at injection time.

<a id="verification"></a>
## Verification

pnpm run build (10 gates) passed; a live dsh web run injected the pinned version and the decoded session log recorded user/message source {kind: skill-invocation, name: release-metrics-compare, version: 3, provider: skill-plaza} after version 4 had been published.

<a id="dev-note"></a>
## Dev Note

None.
