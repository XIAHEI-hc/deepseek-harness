---
description: "Durable skill drafts, immutable published versions with display content, workspace media, and the workspace-scoped provider the Skills plaza and the agent's skill catalog both read."
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-plaza

English | [中文](README.zh.md)

## Summary

Use this package to turn a finished conversation into a reusable skill. It stores drafts, publishes immutable versions, keeps the result images and process graph a published version shows, and registers a skill provider so the published bodies reach the agent through the ordinary skill catalog and the `/name` gesture. Drafts are revision-guarded; published versions are append-only and named by the version a caller selected. Mount it beside `dsh-skill` in an application that offers a Skills plaza.

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

Six durable tables in the `skill_plaza` storage domain: drafts (mutable, `revision`-guarded), published versions (immutable, keyed `skillId@version`), the active-version catalog, generation attempts, workspace media (immutable images), and version bindings (the version pinned to a Session's next explicit invocation). Every record names the workspace directory it belongs to, so one Harness home can hold plazas for several workspaces without a second store. Domain version 2 admits version-1 data: records written before display content existed stay readable, and `presentation` is simply absent.

### What the Remote offers

| Method | Effect |
|---|---|
| `skillPlaza/catalog` | Published skills callable in one workspace, with their active version, category, and cover |
| `skillPlaza/drafts` | Drafts of one workspace, newest first |
| `skillPlaza/detail` | One exact published version — its content and display data — never the active version by accident |
| `skillPlaza/saveDraft` | Create a draft, or replace one whose `expectedRevision` still matches |
| `skillPlaza/check` | Located problems that would block publication, without writing |
| `skillPlaza/publish` | Validate, then write an immutable version and make it active; a repeated publish of the same draft revision returns the version it produced |
| `skillPlaza/pin` | Bind one published version to the Session's next explicit invocation |
| `skillPlaza/generate` | Start — or join — an attempt that distills a draft from a live Session's completed turn; the call answers while the attempt runs |
| `skillPlaza/cancel` | Stop one running attempt and return the record it settled into |
| `skillPlaza/job` | Read one generation attempt, including the stage and character count a running one reports |
| `skillPlaza/uploadMedia` | Store one PNG, JPEG, or WebP in the workspace |
| `skillPlaza/readMedia` | Read one stored image from the workspace |

A read or write with no `sessionId` addresses the Host's default working directory.

### Display content

`PlazaDraftContent` carries the operating fields the model reads (`title`, `slug`, `description`, `inputs`, `steps`, `outputs`, `verification`, `failureHandling`, `toolDependencies`) plus an optional `presentation` with `schemaVersion`, `category`, `scenarios`, `examplePrompt`, `coverAssetId`, `examples`, and `workflow`. Presentation is display data: `renderSkillBody` never reads it, so a process graph cannot become model instructions by accident.

A workflow is a flat list of layers plus a root layer identity. A node names the layer it opens through `subflowLayerId`, which expresses branches, joins, and nested subflows without a recursive payload the Remote codec rejects. Layers nest at most three deep.

### Media

Uploads are admitted by file signature, not by the declared name or media type: PNG, JPEG, and WebP are decoded for their pixel size, and anything else is refused with `skillPlaza/unsupported-media`. Each image is stored once under an immutable `assetId` in the uploading workspace, capped at 10 MiB and 8192 pixels per side. A published version references asset identities, so replacing a draft's image later cannot change what an older version shows.

### Skill provider

Published skills enter `ctx.skills` under the provider name `skill-plaza` with `modelInvocable` and `userInvocable` both true. The provider lists the active version and loads exactly the published body a `list` returned, so a selection survives a later publication of the same slug. A publish invalidates the catalog so the next read lists the new version.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Drafts move forward under optimistic concurrency: `saveDraft` compares `expectedRevision` with the stored revision and raises `skillPlaza/conflict` with both numbers rather than overwriting, and `publish` does the same before writing a version. Publication writes the version record first, then the catalog row, then the draft's `skillId` claim; a repeated publish finds the existing version by draft revision, so a retried request cannot create a second version.

Publication validates the whole display payload against the workspace's media: duplicate node identities, a missing entry node, dangling edges, unreachable nodes and layers, unlabeled decision branches, unresolvable assets, and the size bounds are reported as `PlazaIssue`s with a content path. `check` returns those same issues without writing, so an editor can mark them before the attempt.

Generation records an attempt before the model call and answers the caller immediately; the call itself runs behind the record, which reports the stage it reached (`harvest`, `distill`, `check`, `save`) and the characters the model produced. A repeated request while an attempt runs joins it instead of starting a second model call, and a request after a failed or cancelled attempt runs the next attempt of the same job. `cancel` aborts that model call and stores `cancelled`; a call that arrives after the attempt settled returns it unchanged. A failure stores a readable reason on the job and produces no draft, so a retry starts from a clean attempt. Slug collisions are refused at publication with `skillPlaza/name-conflict`; the check reads the workspace's catalog, not the caller's list.

A version binding is written to the `pins` table when a caller pins a version, and consumed by the `agent/pre-step` handler of the next step that names the slug. Persisting it is what makes a selection survive a Host restart; the handler also drops a binding whose workspace no longer matches, so a plaza read in one workspace cannot inject into a conversation in another.

## Model Experience

### Published skill bodies

#### What the model sees

The published markdown body verbatim inside `<skill_content>`, with the skill's kebab-case name in the opening attribute, rendered by the skill registry for the `skill` tool or the user-explicit `/name` gesture. Drafts, display content, media, and job records never reach a model.

#### Token effect

One injected body per explicit invocation, bounded by that body's length. Nothing is added to the catalog beyond the skill's name and description.

#### KV Cache effect

A new published version changes the body a later invocation injects; earlier tool results and injected blocks remain historical facts in the Session log. Display content and images never enter the request, so editing them cannot move the cache.

## Known Limitations and Deferred Work

- **An attempt outlives its request but not the Host** — `generate` answers at once and the model call runs in the Host process. A Host restart during a generation loses that attempt; the stored record still reports the last stage it reached, and the caller requests a new one. There is no durable queue.
- **Cancellation stops the call, not the record** — `cancel` aborts the model call and settles the attempt as `cancelled`; the job, its stage history, and its attempt counter stay readable.
- **The distilled material ends at the clicked reply** — generation bounds the conversation at that reply's message identity; an identity the Session no longer holds falls back to the last messages.
- **Media lives in the storage domain** — images are base64 in the `media` table rather than files beside the Domain, so one entry costs its encoded size in the domain document that the backend rewrites. A per-record layout or a blob store is the change to make before images routinely reach the 10 MiB bound.
- **Media has no deletion path** — an uploaded image is never removed, which is what keeps an older published version readable after its draft changes; the cost is that abandoned uploads stay.
- **Turn identity is not verified** — `generate` records the `turnId` it was handed without checking that the Session log contains that turn.
- **One workspace per call** — reads and writes resolve a single workspace directory; there is no cross-workspace plaza view.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The workflow layer shape is flat because the Remote codec rejects unnamed recursive payloads; a nested `subflow` object would fail Typert generation rather than at runtime.

</details>
