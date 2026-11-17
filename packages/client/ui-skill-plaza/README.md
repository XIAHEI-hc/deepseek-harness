---
description: "The Skills plaza surfaces: the catalog and detail pages, the draft editor with its preview, the finalized-reply generate action, and the composer skill picker."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-skill-plaza

English | [中文](README.zh.md)

## Summary

Use this plugin to give the Web client a Skills plaza. It registers a sidebar entry whose pages browse the workspace's published skills, open one exact version's overview, execution process, and usage notes, and edit a draft with its display content before publishing. It also contributes a "Generate skill" action on finalized assistant messages and a composer picker that inserts one published skill's native `/name` gesture. Every read and write goes through the `skillPlaza` Remote; the plugin holds no plaza state of its own.

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
| Sidebar entry and pages | `sidebar.panellist`, `main` | Browses the catalog with search and categories, opens one published version, edits and previews a draft, and publishes a version |
| Generate action | `conversation.chat.assistant-actions` | Distills a draft from that reply's turn, then opens exactly that draft in the editor |
| Skill picker | `conversation.input.left` | Lists published skills, filters them by name, title, or purpose, and inserts `/name ` into the draft |

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
- **The process editor is form-based** — nodes and labeled edges are added and edited through a form list; there is no drag-and-drop canvas authoring.
- **Media upload is one image per example** — a node references one of the draft's uploaded example images rather than its own upload control.
- **The page reads the workspace of the mounted conversation** — opening the plaza with no conversation open addresses the Host's default directory, not a workspace the user picked.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Workflow layers are addressed by identity rather than by nesting, matching the Host's flat workflow payload; the process view keeps a stack of opening nodes so returning from a subflow restores the parent selection.

</details>
