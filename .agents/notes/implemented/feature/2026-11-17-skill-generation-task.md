# Agent Note: Skill generation is a visible task

Status: implemented

English | [中文](2026-11-17-skill-generation-task.zh.md)

## Problem

The generate action on a finalized reply was a fire-and-forget Remote call. `skillPlaza/generate` ran the whole model call inside the request, the caller saw a disabled button for tens of seconds, and completion replaced the entire main panel with the draft editor. A user could not tell a slow generation from a broken one, could not stop it, and lost the reply they were reading the moment it succeeded.

## Decision

**`generate` answers at once, and the attempt carries its own progress.** The Host records the attempt, starts the model call behind it, and returns the record. While it runs, `job` reports the stage the attempt reached (`harvest`, `distill`, `check`, `save`) and the characters the model produced; `cancel` aborts that model call and settles the attempt as `cancelled`. A repeated request joins the attempt still running, and a request after a failed or cancelled attempt runs the next attempt of the same job. Progress writes are throttled to one record write per 400 ms because the attempt is one JSON document.

**The client follows the durable record instead of holding a promise.** One task per Turn is mirrored into a per-Session generation store, keyed by the Turn's closing message identity, and the client polls `job` while the attempt runs. Following a record rather than a pending RPC is what makes a second click, a retry, and a cancel all act on the same attempt.

**The task card sits above the action row, not in a new region.** It renders in `conversation.chat.turnTail`, whose owner currency gained the closing message identity, so the card is anchored to the reply that produced it. The four states are the whole surface: running (stage list, characters so far, elapsed, cancel), succeeded (title, purpose, tags, one action that opens the draft), failed and cancelled (readable reason plus retry).

**Completing a generation navigates nowhere.** Opening the plaza is an explicit action on the result card or the action itself. The action also carries the durable state, so a Turn that already produced a draft reads `已生成 · 查看` instead of offering a second generation.

## Testing

`packages/skill/skill-plaza/tests` drives the real service over real storage: joined requests, retry after failure, stage and character reports, cancellation of a running model call, a late cancellation that leaves a settled attempt untouched, and an unknown attempt identity. `packages/client/ui-skill-plaza/tests` covers the action's four labels, the card's stages and result, cancel and retry wiring, and the store the two entries share.

## Alternatives considered

**A streaming Remote (`@Remote({ mode: 'stream' })`) instead of polling.** A stream would push progress without a timer, but it needs a transport the plaza does not otherwise use, ends with the tab, and cannot answer a reloaded page. Polling reads the durable record the Host already writes, so every caller sees the same attempt regardless of when it attached.

**Navigating to the plaza when the attempt settles.** The original behavior made the result impossible to miss, and impossible to decline: the conversation disappeared and the editor arrived whether or not the user wanted it. Opening on request keeps the result one click away and keeps the reply on screen.

**A spinner with invented stage timing.** Staging the wait from a client timer would have needed no Host change, and would have told the user a story the Host had not confirmed. The card reports the stage the Host reached, and shows no stage when it has none.

**Rendering the card as a conversation node.** A node would survive replay, but a generation is a side task whose material never enters the Session's model input; writing a session event for it would put UI state into the transcript. The plaza's attempt and draft records are the durable truth, and the card is a view of them.

## Consequences

The wait is legible, stoppable, and retryable, and the reply stays on screen while the skill is made. The cost is that the mapping from a Turn to its attempt lives in the browser: after a reload the card is gone while the draft persists, and starting again joins the attempt the Host is still running. A running card reports the stage and character count rather than the draft's fields, because the Host publishes no partial content. Each running attempt costs one small `job` read per 700 ms.

## What this record does not claim

Generation still has no durable queue: the model call lives in the Host process, so a restart during an attempt loses it while the record keeps the last stage it reached. Running two generations in one Turn is not supported; the action and the card both address one attempt per message identity.
