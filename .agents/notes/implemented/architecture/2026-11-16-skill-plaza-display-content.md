# Agent Note: Skills plaza display content, workspace media, and durable pins

Status: implemented

English | [中文](2026-11-16-skill-plaza-display-content.zh.md)

## Problem

The Skills plaza stored operating content only. A published version carried a title, a description, the ordered steps, and the verification text, so the plaza could list and invoke a skill but could not show what its result looks like, how its process branches, or what a caller should try. The overview, execution-process, and usage surfaces the product needs have no place to read from, and two behaviours were unsafe for that product: a detail page had no way to read one exact published version, and a pinned version lived only in Host memory, so a restart between choosing a version and sending the task silently ran whatever version was active.

Two shapes also failed on their own terms. A nested `subflow` object is a recursive type, and the Typert Remote codec rejects an unnamed recursive payload during artifact generation. Storing images as files beside the storage domain would have added a second medium whose consistency with drafts and versions nothing owned.

## Decision

**A version carries optional `presentation` content beside its operating fields.** `PlazaDraftContent` keeps `title` through `toolDependencies` as the model-facing body, and adds `schemaVersion`, `category`, `scenarios`, `examplePrompt`, `coverAssetId`, `examples`, and `workflow`. `renderSkillBody` never reads `presentation`, so display content cannot become model instructions by accident, and the editor states that the graph and the steps are independent content.

**A workflow is a flat set of layers plus a root layer identity.** Each layer holds nodes and edges; a node names the layer it opens through `subflowLayerId`. This expresses branches, joins, and nested subflows while remaining a non-recursive wire type, and it bounds nesting at three layers. Flattening was chosen over a hand-written nested-to-flat converter because one shape for storage, wire, and editor keeps the located validation paths, the editor, and the process view reading the same thing.

**Publication validates inside the operation that makes it.** `publish` checks the whole display payload against the publishing workspace's media and refuses with the first located issue: duplicate node identities, a missing entry node, dangling edges, unreachable nodes and layers, unlabeled decision branches, unresolvable assets, and the size bounds. `check` returns the same issues without writing, so the editor can mark them; the front end never decides publication.

**Images are immutable workspace records in the same domain.** Uploads are admitted by file signature rather than by declared name or media type, an image is stored once under an immutable asset identity scoped to its workspace, and a published version references identities. Replacing a draft's image therefore cannot change what an older version shows. A version's display snapshot and its operating body are written together, so restoring the medium restores both.

**A version binding is durable and workspace-checked.** `pin` writes the `pins` table instead of a Host-local map, and the pre-step handler drops a binding whose workspace no longer matches before injecting anything. A restart between selecting a version and sending the task therefore still injects that version, and a binding made in one workspace cannot inject into a conversation in another.

## Verification

Host specs cover the presentation round trip through save, publish, and detail; the located problems that block publication and the clean payload that passes; media admission for each accepted format, the byte and pixel bounds, and the workspace read filter; an older version's content surviving a newer publication; and the pin record readable from a fresh reader of the same medium. Client specs cover the browse filters, the version-exact detail read, node selection with its subflow round trip, the steps fallback, the editor's save, blocked publish, conflict panel, and preview, and the pin-before-insert path on the page face. `verify-client-ui-i18n` covers the new copy, and the aggregate typecheck covers the widened contract.

## Alternatives considered

**Keep display content out of the version snapshot** — rejected: a draft edited after publication would change what an older detail page shows, so the version would no longer be immutable.

**Store media as files beside the domain** — rejected for now: it adds a medium whose consistency with the version snapshot nothing owns, and the domain read filter already provides workspace isolation. The cost is recorded as a Known Limitation: an image occupies its encoded size in the domain document.

**Derive the process graph from the steps** — rejected: guessing branch labels and checks from prose would put display structure into the model path and make each step edit silently rewrite the graph.

## Consequences

Every publishing surface must now satisfy the display checks, including drafts written by earlier releases, whose absent `presentation` is accepted unchanged. A version's display content and its images stay readable as long as the medium does; nothing removes an upload, which keeps older versions intact at the cost of retaining abandoned images. Detail reads, media reads, and pins all resolve a workspace first, so a caller that passes no Session keeps addressing the Host's default directory.
