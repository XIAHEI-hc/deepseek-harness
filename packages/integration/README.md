---
description: "The integration group map: model-facing tools over the DSH platform's optional system-fusion API, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/integration

English | [中文](README.zh.md)

## Summary

The integration group connects the agent to the independent platform's system-fusion API. The platform owns connector authorization, immutable snapshots, and short-lived analysis containers; these packages only expose that already-authorized surface as model tools. The group ships no host adapter and no second gateway.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`tool-integration`](tool-integration/README.md) | Lists authorized resources and workspaces, reads snapshots, runs isolated analysis jobs, and reads artifacts | registers on `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

- [System-fusion implementation](../../docs/integration/README.md) — switch, ACL, snapshots, job container, and acceptance status.
- [Platform architecture](../../services/platform/ARCHITECTURE.md) — gateway, identity, runtime, and integration composition.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The package is host-only and model-facing. Its transport is the platform's runtime capability token; it never receives the platform space-key secret, a browser session, or a direct connector URL.

</details>
