---
description: "The Skills plaza surfaces: the sidebar page and editor, the finalized-reply generate action, and the composer skill picker."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-skill-plaza

English | [中文](README.zh.md)

## Summary

Use this plugin to give the Web client a Skills plaza. It registers a sidebar entry and its page for reading and editing drafts and publishing versions, a "Generate skill" action on finalized assistant messages, and a composer picker that inserts one published skill's native `/name` gesture. Every read and write goes through the `skillPlaza` Remote; the plugin holds no plaza state of its own.

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

The plugin requires the `conversation`, `layout`, `locale`, `remote.skillPlaza`, `sessions`, and `slots` services, and it needs `@deepseek-ai/dsh-skill-plaza` mounted on the Host.

### Surfaces

| Surface | Slot | Effect |
|---|---|---|
| Sidebar entry and page | `sidebar.panellist`, `main` | Lists the workspace's drafts and published skills; saves a draft and publishes a version |
| Generate action | `conversation.chat.assistant-actions` | Distills a draft from that reply's turn, then opens the plaza page |
| Skill picker | `conversation.input.left` | Lists published skills, filters them by name, title, or purpose, and inserts `/name ` into the draft |

Draft edits send the revision they were rendered from, so a second window's save surfaces as a conflict instead of silently overwriting.

## Model Experience

None, as this plugin writes the native /name text into the unsent composer draft and reads Host plaza Remotes.

#### KV Cache effect

None; the published body is supplied by the `@deepseek-ai/dsh-skill-plaza` provider, which owns that effect.

## Known Limitations and Deferred Work

- **The picker inserts text, not a bound reference** — a chosen skill becomes the native `/name` text, so the Host loads the version active at pre-step rather than the version the picker displayed.
- **The page addresses the Host's default workspace** — a Session-scoped plaza view (one workspace per open Session) is not implemented; only the conversation entries pass a Session identity.
- **No rich preview** — the editor edits plain fields and renders no Markdown or Mermaid preview of the draft body.
- **No image or example attachment editing** — drafts carry text fields only.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>