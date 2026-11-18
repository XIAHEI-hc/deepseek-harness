---
description: "The Skills plaza surfaces: the catalog and detail pages, the draft editor with its preview, the finalized-reply generate action, and the composer skill picker."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-skill-plaza

English | [中文](README.zh.md)

## Summary

Use this plugin to give the Web client a Skills plaza. Its sidebar entry browses published skills as process thumbnails, opens one exact version as a single page — examples, an interactive process, scenarios, and the stored body — and edits a draft before publishing. It also adds a "Generate skill" action on finalized replies, the task card that shows that generation while it runs, and a composer picker that inserts one skill's native `/name` gesture. Every read and write goes through the `skillPlaza` Remote; the plugin holds the running task, not plaza records.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the row in the Web profile's browser roster:

```yaml
- id: ui-skill-plaza
  name: '@deepseek-ai/dsh-client-ui-skill-plaza'
```

The plugin requires the `conversation`, `layout`, `locale`, `remote.skillPlaza`, `sessions`, `slots`, and `uiWorkspace` services, and it needs `@deepseek-ai/dsh-skill-plaza` mounted on the Host.

### Surfaces

| Surface | Slot | Effect |
|---|---|---|
| Sidebar entry and pages | `sidebar.panellist`, `main` | Browses the catalog as process thumbnails, opens one published version as one page, edits and previews a draft, and publishes a version |
| Generate action | `conversation.chat.assistant-actions` | Starts the generation for that reply's turn, then reads as running, generated, or ready to retry |
| Generation card | `conversation.chat.turnTail` | Paints the running attempt — stage list, characters so far, elapsed time, cancel — and the draft it produced, with one action that opens it |
| Skill picker | `conversation.input.left` | Lists published skills, filters them by name, title, or purpose, and inserts `/name ` into the draft |

A generation is one task, not one request. The action starts it, the card follows the Host's attempt record until it settles, and the plaza opens only when the user asks for the draft: completing a generation never replaces the conversation with another page. A repeated click while an attempt runs joins it, and a click after a failed or cancelled attempt starts the next attempt of the same job.

Both entries read one generation store per Session, keyed by the closing message identity, so the reply's Turn and its card cannot disagree about where the attempt stands.

Draft edits send the revision they were rendered from, so a second window's save surfaces as a conflict with the local content kept for copying instead of silently overwriting.

### Pages and state

The workspace the pages address is the Session whose conversation surfaces are mounted; with none mounted they address the Host's default directory. A change of workspace remounts the whole view, which is what keeps a detail page, its loaded images, and an in-flight read from one workspace out of another.

"Use in conversation" pins the version the detail page displays, and inserts the invocation only after the pin succeeded; existing composer text is kept, and nothing is sent. With no conversation mounted it creates one through the platform's own new-conversation entry, then inserts into it.

## Model Experience

None, as this plugin writes the native /name text into the unsent composer draft and reads Host plaza Remotes.

#### KV Cache effect

None; the published body is supplied by the `@deepseek-ai/dsh-skill-plaza` provider, which owns that effect.

## Known Limitations and Deferred Work

- **The picker inserts text, not a bound reference** — a chosen skill becomes the native `/name` text, so the Host loads the version pinned for the next step, or the active version when nothing was pinned. The plaza's own pages always pin before inserting.
- **Card thumbnails follow the catalog, not the graph** — each card draws the active version's root-layer labels and decision count from the catalog entry; nested layers and edge structure appear only on the detail page.
- **The package section shows stored content, not files** — a plaza skill lives in the plaza's storage domain, so the section renders the stored model-facing body with its examples and tools; there is no directory listing or archive export.
- **The process editor is form-based** — nodes and labeled edges are added and edited through a form list; there is no drag-and-drop canvas authoring, and the editor keeps its separate preview instead of a live one.
- **Media upload is one image per example** — a node references one of the draft's uploaded example images rather than its own upload control.
- **The generating task lives in this client** — the card mirrors the Host's attempt record, but the mapping from a Turn to its attempt is browser state. After a reload the card is gone; the draft it produced is still in the plaza, and starting the generation again joins the attempt still running on the Host.
- **The running card reports progress, not the draft** — it shows the stage the Host reached and the characters the model produced, and the draft's fields appear when the attempt settles. Streaming the fields would need a partial-content contract the Host does not publish.
- **The page reads the workspace of the mounted conversation** — opening the plaza with no conversation open addresses the Host's default directory, not a workspace the user picked.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Workflow layers are addressed by identity rather than by nesting, matching the Host's flat workflow payload; the process view keeps a stack of opening nodes so returning from a subflow restores the parent selection. A version without a workflow is drawn from its steps by `flow-model.ts`, which is display-only and never enters the stored content.

</details>
