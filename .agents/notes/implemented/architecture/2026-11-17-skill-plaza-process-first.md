# Agent Note: A process-first Skills plaza

Status: implemented

English | [中文](2026-11-17-skill-plaza-process-first.zh.md)

## Problem

The plaza stored and rendered operating content, but it read like a database record: the catalog showed text cards, the detail page split its content into three tabs, and the process graph was one tab among them. A version without an authored workflow fell back to a numbered list, so the surface that was supposed to explain "what this skill does" could lose its only diagram. Nothing expressed that a published skill is one reusable package whose body, examples, and tools belong together.

## Decision

**The detail page is one document, and the process is its primary surface.** Result examples, scenarios, the process, and the stored body are sections of the same scroll page with an anchor row instead of tabs. The process canvas takes the full content width and keeps its node inspector beside it; selecting a node still shows that step's purpose, inputs, checks, outputs, verification, and failure handling.

**A version without a workflow is drawn from its steps.** `flow-model.ts` turns ordered steps into the same flat layer shape an authored workflow uses, marks the result as derived, and the view states where it came from. The derived flow is display-only: it is never stored, published, or read by the model-facing renderer, so the operating body stays the only model input.

**Catalog entries carry a process preview derived at read time.** `PlazaSkillEntry.flow` holds up to four shortened labels from the active version's root layer, or from its steps when no workflow exists, plus a decision count. The catalog maps each row through its active version record inside the same domain read, so a card draws a flow without one detail request per card. Publication's returned entry omits the preview because the plaza does not use it there.

**The detail read returns the stored body.** `PlazaDetailValue.body` is the exact text `renderSkillBody` wrote at publication; the package section renders it instead of re-deriving the body on the client. A draft preview has no body and hides the section, so a preview never claims a publication it does not have.

**One recent skill is presented as a feature only when the catalog has more than one.** A one-skill workspace keeps the plain grid, which keeps the single card's own cover and controls reachable instead of lifting its only entry into a banner.

## Verification

`pnpm exec vitest run packages/client/ui-skill-plaza/tests packages/skill/skill-plaza/tests` covers: the catalog entry carrying a step-derived preview, the stored body returning from `detail`, the derived-flow view with its hint, node selection and subflow return on the single page, the featured card's pin-before-use path, and the flow-model counts including a self-loop. The Web e2e spec drives the built client over a seeded Host, takes the browse, detail, node, and narrow screenshots, and asserts the flow hint and the result image on the assembled page.

## Alternatives considered

**Read every card's detail to draw its thumbnail** — rejected: one request per card on a page that already reads the catalog, and a card would show a flow the catalog cannot describe.

**Render `SKILL.md` from the content on the client** — rejected: it duplicates `renderSkillBody` and would let the preview drift from what the model actually reads.

**Keep the tabs and add the graph to the overview** — rejected: it leaves two places describing the same process, and the tab order still decides whether a reader ever sees it.

## Consequences

A catalog read now also fetches each active version record from the same storage domain; the entry grows one optional field and the detail value grows the stored body. An older published version keeps working: it stores a body like every version does, and it gains a derived flow the first time the catalog lists it.
