# Agent Note: Skills plaza vertical slice

Status: implemented

English | [中文](2026-11-16-skills-plaza-vertical-slice.zh.md)

## Problem

A finished conversation holds a method that worked: the steps taken, the tools called, the way a bad result was recognized. Nothing carried that method into the next task, and a skill could only enter the catalog from a directory on disk. The DevPack asked for a loop a person can run: distill a finished turn into a draft, publish an immutable version, then pick that version in the composer and have the Host load it for a new task.

## Decision

**Published plaza skills enter the existing `ctx.skills` registry rather than a second catalog.** `@deepseek-ai/dsh-skill-plaza` owns drafts, immutable versions, the active-version catalog, and generation attempts in one `skill_plaza` storage domain, and registers a provider (`skill-plaza`, rank 400) whose `list` returns the active version per workspace and whose `get` loads the exact published body its candidate named. The model catalog, the `skill` tool, the `/slug` pre-step gesture, and the Web picker therefore read one published representation, and no new loading path exists to diverge from the shipped one.

**Workspace is the isolation key.** Every record carries the workspace directory it belongs to; every read and write resolves one directory from the caller's Session (`workingDirectory.ensure` for a live agent, the projection header otherwise) and falls back to the Host default when the request names no Session. A record from another workspace is `skillPlaza/not-found`, not a filtered list, so cross-workspace access cannot be reached by guessing an id.

**Drafts move forward under optimistic concurrency, versions are append-only.** `saveDraft` and `publish` both compare the caller's revision with the stored one and raise `skillPlaza/conflict` carrying both numbers. Publication writes the version record (`skillId@version`, body frozen), then the catalog row, then the draft's `skillId` claim; a repeat publish of the same draft revision returns the version it already produced instead of creating a second one. A slug another skill owns is refused at publication with `skillPlaza/name-conflict`.

**Generation is one Host-owned structured call, not a second agent loop.** `skillPlaza/generate` records the attempt, harvests the tail of the live Session's derived messages, calls the configured default route with a JSON contract, validates the reply, and stores the draft; a model or validation failure stores a readable reason on the attempt and produces no draft. The call answers when the attempt is recorded and runs the model behind it, so the attempt is a task the client follows rather than a request it waits on ([visible-task note](2026-11-17-skill-generation-task.md)). The source Session's log is never written to.

**A composer selection binds one published version to the next task that names it.** `skillPlaza/pin` records `{skillId, version}` for the Session; the plaza's own `agent/pre-step` listener (registered `prepend`) runs after the shipped `/slug` injection, drops that injection when its name matches the pin, loads the pinned version's stored body, and appends an injection whose `skill-invocation` source carries `version` and `provider`. A pin whose version is gone fails the step instead of resolving the name again. The pin lives in Host memory because a durable per-message reference would need a new `SessionPromptRequest` field and a new source member; the pinned *result* is durable either way.

**The client surface is four contributions, not a fork of the composer.** `sidebar.panellist` + `main` carry the plaza page and editor, `conversation.chat.assistant-actions` carries the generate action on a finalized reply, `conversation.chat.turnTail` carries the task card that shows that generation, and `conversation.input.left` carries the picker that writes the native `/slug` text through the conversation input facade. The action and the card read one per-Session store keyed by the reply's message identity. The page is a root panel, so the plugin records the active Session from its conversation registrations and addresses that workspace; without one it reads the Host default.

## Evidence

A real run on a source-built `dsh web` (0.2.2-rc.3, Windows, `DeepSeek-V4.1-Flash`) over the workspace `D:\Vibe_coding\dsh-plaza-demo`:

1. A turn answered a metric comparison by reading `releases.md` (one model request, three steps, real tool call).
2. `生成 Skill` distilled that turn into draft `draft-bedb3ec4…`, slug `compare-release-metrics-from-markdown`, revision 1, stored under the Session's workspace.
3. The plaza page listed the draft; editing title and slug and pressing `发布` saved revision 2 and published `release-metrics-compare` version 2 (`skill-a7fff7a1…@2`, body 2241 bytes).
4. Back in the conversation, `选择 Skill` listed only the published entry (`release-metrics-compare · 版本 2`) and inserted `/release-metrics-compare ` into the composer.
5. Sending that turned the model's answer into a failure-handling report that quoted the published body verbatim ("If only one entry exists, state that no comparison is possible") after failing to find the requested `v1.1.0` row, and offered a skill-shaped comparison table for the data it could read.
6. Version binding: the picker offered version 3 and inserted `/release-metrics-compare `; the draft was then republished as version 4 with a uniquely marked failure-handling rule (`VNEW-…-SHOULD-NOT-APPEAR`); sending the drafted task produced a reply without that marker, and the decoded Session log records `user/message` with `source {kind: skill-invocation, name: release-metrics-compare, version: 3, provider: skill-plaza}`. A newer publication therefore did not replace the selection.

The stored active body contains that sentence, so the quoted rule is Host state rather than a prompt coincidence: the injection happened, and it happened from the version the picker displayed.

## Acceptance

| Item | Result | Evidence |
|---|---|---|
| A01 | pass (unit) | The reply's card reports the attempt and the action opens the draft the client was told to open (`browser-plugin.client.spec.tsx`); the plaza is no longer entered automatically |
| A02 | pass | Generation bounds its material at the clicked reply's message identity, and a fork carries its own log, so another branch's content cannot enter (plaza-pre-step.spec.ts) |
| A03 | pass | The action does not exist before a reply finishes: an empty Session and a streaming reply render no generate entry, which the slot contract enforces |
| A04 | pass | A second identical request joins the attempt already running, producing one job and one draft; the entry also disables itself while busy (plaza-pre-step.spec.ts) |
| A05 | pass (unit) | A non-JSON reply is repaired once; a failed attempt stores a readable reason and produces no draft, and the next identical request runs the next attempt of the same job (`plaza-pre-step.spec.ts`) |
| A06 | pass | The generated draft parameterized its inputs and carried no concrete ids, paths, or values from the source turn |
| A07 | pass (unit) | A stale revision conflicts with both numbers; a matching one advances (`plaza.spec.ts`). Two windows were not driven |
| A08 | pass | The picker listed only the published entry while a draft existed |
| A09 | pass (unit) | A repeated publish returns the version it produced; a taken callable name is refused (`plaza.spec.ts`) |
| A10 | pass | The new version was listed without restarting the app |
| A11 | pass | The picker filters by name, title, and purpose through the shared matcher, and a query with no match shows the empty state; selection and removal of the draft text still work |
| A12 | pass | The decoded Session log records `version: 3` and the provider, and the turn called the file tool |
| A13 | pass | Version 4 was published after the selection and its marker never reached the model |
| A14 | pass | The same run is the after-selection publication case |
| A15 | pass (unit) | Another workspace lists nothing and cannot publish by id (`plaza.spec.ts`) |
| A16 | pass | A separately registered skill with the same name wins by rank while the plaza entry stays published, and a name shared with a host command is claimed client-side before it becomes a prompt (plaza.spec.ts) |
| A17 | pass | Ordinary turns ran normally in every flow, including after a skill invocation |
| A18 | pass | With both rows disabled by an overlay, the sidebar entry and the composer picker disappear and the conversation still renders without console errors; stored drafts remain in the same domain file |

## Verification commands

- `pnpm run build` — ten build gates, artifacts include both new packages.
- `dsh --profile web --dump-config` — composes `skill-plaza` and `ui-skill-plaza`.
- `verify-package-readme-{summaries,limitations,model-experience}`, `check-workspace-constraints` — green.
- `pnpm run persistence-changes --record 2026-11-16-skill-invocation-version` — records the two optional source fields.
- `npx vitest run packages/skill/skill-plaza/tests packages/client/ui-skill-plaza/tests` — ninety-five tests pass at 100% statement, branch, function, and line coverage for both packages: thirty-five Host tests (drafts, conflicts, publication, provider serving, name shadowing, pinning, pinned pre-step injection, workspace isolation, concurrent and repeated generation, retry after failure, one-shot JSON repair, bounded harvest, model failure modes) and sixty client tests (plugin registrations, injected faces, page rendering and mutations, picker filtering, pin refusal, teardown, inert node half).

## Alternatives considered

**A plaza-specific catalog served straight to the composer** would have kept drafts and versions out of the skill registry, but it would have created a second loading path: the picker would show one body and the `/slug` gesture another. Registering a provider keeps one representation and lets the shipped catalog, tool, and gesture carry the result.

**Reusing the filesystem provider by writing `SKILL.md` files** would have given version identity for free through directories, but publication would become file mutation on user workspaces, and an immutable version would be indistinguishable from an edited file. Storing bodies in the plaza domain keeps publication atomic and keeps workspace contents untouched.

**Publishing through the profile's bundle system** would have made a skill a plugin, which contradicts the product model: a plaza skill is content for an agent, not a composition of services.

## Consequences

Writers pay one revision comparison per save and publication, and readers pay one catalog read per workspace; publication invalidates the provider catalog so the next read lists the new version. Because the provider is process-local, a Host restart re-reads the domain on the next lookup, and a second Host process sees the stored catalog without a change notification.

The composer keeps its plain-text reference model, so a selection is the `/slug` text plus a Host-side lookup; that keeps the existing reference semantics but leaves version binding open, recorded above as the next required change. A draft that no Session addresses is unreachable from the page until a Session selects its workspace, which the page states rather than papering over.

## What this record does not claim

The pin is Host memory keyed by Session, so a Host restart between selection and send falls back to name resolution; a durable reference needs a `SessionPromptRequest` field, a `MessageSource` member, and a `tool-skill` read, plus their persistence record. Generation has no durable queue: the model call lives in the Host process, while the attempt record keeps the last stage it reached. Both packages meet the per-file coverage gate. Three defensive arms carry reasoned `v8 ignore` comments: a published version cannot be removed by any API in this package, and the provider never receives a non-version locator. The generated catalogs are current.