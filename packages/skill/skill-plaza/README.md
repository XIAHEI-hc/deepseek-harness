---
description: "Durable skill drafts, immutable published versions, and the workspace-scoped provider the Skills plaza and the agent's skill catalog both read."
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-plaza

English | [中文](README.zh.md)

## Summary

Use this package to turn a finished conversation into a reusable skill. It stores drafts, publishes immutable versions, and registers a skill provider so the published bodies reach the agent through the ordinary skill catalog and the `/name` gesture. Drafts are revision-guarded; published versions are append-only and named by the version a caller selected. Mount it beside `dsh-skill` in an application that offers a Skills plaza.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin to give one Harness home a durable skill plaza:

```yaml
- id: skill-plaza
  name: '@deepseek-ai/dsh-skill-plaza'
```

It requires `ctx.storageDomain`, `ctx.skills`, `ctx.llm`, `ctx.agents`, `ctx.sessionQuery`, and `ctx.workingDirectory`, and it adds the `skillPlaza` Remote namespace.

### What it stores

Four durable tables in the `skill_plaza` storage domain: drafts (mutable, `revision`-guarded), published versions (immutable, keyed `skillId@version`), the active-version catalog, and generation attempts. Every record names the workspace directory it belongs to, so one Harness home can hold plazas for several workspaces without a second store.

### What the Remote offers

| Method | Effect |
|---|---|
| `skillPlaza/catalog` | Published skills callable in one workspace, with their active version |
| `skillPlaza/drafts` | Drafts of one workspace, newest first |
| `skillPlaza/saveDraft` | Create a draft, or replace one whose `expectedRevision` still matches |
| `skillPlaza/publish` | Write an immutable version and make it active; a repeated publish of the same draft revision returns the version it produced |
| `skillPlaza/pin` | Bind one published version to the Session's next explicit invocation |
| `skillPlaza/generate` | Distill a draft from a live Session's completed turn through the configured model |
| `skillPlaza/job` | Read one generation attempt |

A read or write with no `sessionId` addresses the Host's default working directory.

### Skill provider

Published skills enter `ctx.skills` under the provider name `skill-plaza` with `modelInvocable` and `userInvocable` both true. The provider lists the active version and loads exactly the published body a `list` returned, so a selection survives a later publication of the same slug. A publish invalidates the catalog so the next read lists the new version.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Drafts move forward under optimistic concurrency: `saveDraft` compares `expectedRevision` with the stored revision and raises `skillPlaza/conflict` with both numbers rather than overwriting, and `publish` does the same before writing a version. Publication writes the version record first, then the catalog row, then the draft's `skillId` claim; a repeated publish finds the existing version by draft revision, so a retried request cannot create a second version.

Generation runs the configured model route synchronously and records the attempt before and after the call. A failure stores a readable reason on the job and produces no draft, so a retry starts from a clean attempt. Slug collisions are refused at publication with `skillPlaza/name-conflict`; the check reads the workspace's catalog, not the caller's list.

## Model Experience

### Published skill bodies

#### What the model sees

The published markdown body verbatim inside `<skill_content>`, with the skill's kebab-case name in the opening attribute, rendered by the skill registry for the `skill` tool or the user-explicit `/name` gesture. Drafts, revisions, and job records never reach a model.

#### Token effect

One injected body per explicit invocation, bounded by that body's length. Nothing is added to the catalog beyond the skill's name and description.

#### KV Cache effect

A new published version changes the body a later invocation injects; earlier tool results and injected blocks remain historical facts in the Session log.

## Known Limitations and Deferred Work

- **Generation is synchronous** — `generate` runs the model call inside the Remote request and records the attempt around it; a repeat request joins the attempt already running. There is no durable queue, so a Host restart during a generation loses that attempt and the caller must request a new one.
- **The distilled material ends at the clicked reply** — generation bounds the conversation at that reply's message identity; an identity the Session no longer holds falls back to the last messages.
- **The pin lives in Host memory** — `skillPlaza/pin` records the selection for the Session's next explicitly invoked step and is consumed there. A Host restart between selection and send drops it, and that step then resolves the name to the active version like any other `/slug` invocation.
- **Turn identity is not verified** — `generate` records the `turnId` it was handed without checking that the Session log contains that turn.
- **One workspace per call** — reads and writes resolve a single workspace directory; there is no cross-workspace plaza view.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>