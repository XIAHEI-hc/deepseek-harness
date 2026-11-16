/**
 * Wire vocabulary for the Skills plaza: drafts, immutable published versions,
 * and the catalog the conversation composer selects from.
 *
 * @module @deepseek-ai/dsh-skill-plaza
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One published plaza skill as the browser lists it. */
export interface PlazaSkillEntry {
  /** Durable skill identity; stable across published versions. */
  readonly skillId: string
  /** Callable kebab-case name, stable across versions of the same skill. */
  readonly slug: string
  /** Display title, which may be written in any language. */
  readonly title: string
  /** Routing description shown in the picker and in the model catalog. */
  readonly description: string
  /** Active published version number, starting at 1. */
  readonly version: number
  /** ISO timestamp of the active version's publication. */
  readonly updatedAt: string
}

/** Editable content shared by the plaza editor, the draft record, and the published body. */
export interface PlazaDraftContent {
  /** Display title. */
  readonly title: string
  /** Callable kebab-case name. */
  readonly slug: string
  /** What the skill is for, shown in the picker. */
  readonly description: string
  /** Named inputs the skill expects. */
  readonly inputs: readonly string[]
  /** Ordered operating steps. */
  readonly steps: readonly string[]
  /** Expected outputs. */
  readonly outputs: readonly string[]
  /** How a result is verified. */
  readonly verification: string
  /** What to do when preconditions do not hold. */
  readonly failureHandling: string
  /** Tool names the skill depends on. */
  readonly toolDependencies: readonly string[]
}

/** Where a draft was distilled from, retained for provenance and authorization. */
export interface PlazaDraftSource {
  /** Session the material came from. */
  readonly sessionId: string
  /** Completed turn the material came from. */
  readonly turnId: string
}

/** One draft as the plaza editor reads it. */
export interface PlazaDraftView extends PlazaDraftContent {
  /** Durable draft identity. */
  readonly draftId: string
  /** Skill this draft publishes into; absent until the first publication. */
  readonly skillId?: string
  /** Optimistic-concurrency revision, incremented by every save. */
  readonly revision: number
  /** ISO timestamp of the last save. */
  readonly updatedAt: string
  /** Provenance of a distilled draft. */
  readonly source?: PlazaDraftSource
}

/** Status of one generation attempt. */
export type PlazaJobStatus = 'queued' | 'running' | 'succeeded' | 'failed'

/** One generation attempt as the plaza generation view reads it. */
export interface PlazaJobView {
  /** Durable job identity. */
  readonly jobId: string
  /** Current status; `succeeded` carries `draftId`, `failed` carries `error`. */
  readonly status: PlazaJobStatus
  /** Attempt counter, incremented by an explicit retry. */
  readonly attempt: number
  /** Draft produced by a succeeded attempt. */
  readonly draftId?: string
  /** Readable reason a failed attempt produced no draft. */
  readonly error?: string
  /** ISO timestamp of the last status change. */
  readonly updatedAt: string
}

/**
 * Address one workspace for plaza reads and writes: the Session's working
 * directory when a Session is named, otherwise the Host's default directory.
 */
export interface PlazaSessionRequest {
  /** Session whose working directory selects the workspace; omission reads the Host default. */
  readonly sessionId?: SessionId
}

/** Published skills callable in one Session's workspace. */
export interface PlazaCatalogValue {
  /** Active published skills, sorted by slug. */
  readonly skills: readonly PlazaSkillEntry[]
}

/** Drafts visible in one Session's workspace. */
export interface PlazaDraftsValue {
  /** Drafts sorted by last save, newest first. */
  readonly drafts: readonly PlazaDraftView[]
}

/** Create or update one draft. */
export interface PlazaSaveDraftRequest {
  /** Session whose working directory owns the draft; omission uses the Host default. */
  readonly sessionId?: SessionId
  /** Existing draft to update; omission creates a draft. */
  readonly draftId?: string
  /** Replacement content. */
  readonly content: PlazaDraftContent
  /** Revision the caller read; omission overwrites unconditionally. */
  readonly expectedRevision?: number
}

/** One saved draft. */
export interface PlazaSaveDraftValue {
  /** The stored draft at its new revision. */
  readonly draft: PlazaDraftView
}

/** Publish one draft as an immutable version. */
export interface PlazaPublishRequest {
  /** Session whose working directory owns the draft; omission uses the Host default. */
  readonly sessionId?: SessionId
  /** Draft to publish. */
  readonly draftId: string
  /** Revision the caller read; a mismatch is a conflict, not a silent overwrite. */
  readonly expectedRevision: number
  /** Client-minted key making a repeated publish return the same version. */
  readonly idempotencyKey: string
}

/** The published catalog entry a publication produced. */
export interface PlazaPublishValue {
  /** Active catalog entry after publication. */
  readonly skill: PlazaSkillEntry
}

/** Distill a draft from one completed turn. */
export interface PlazaGenerateRequest {
  /** Session holding the completed turn. */
  readonly sessionId: SessionId
  /** Completed turn to distill. */
  readonly turnId: string
  /** Client-minted key making a repeated request return the same draft. */
  readonly idempotencyKey: string
}

/** One generation attempt. */
export interface PlazaGenerateValue {
  /** Attempt created or recovered by this request. */
  readonly job: PlazaJobView
}

/** Bind one published version to a Session's next explicitly invoked step. */
export interface PlazaPinRequest {
  /** Session whose next task names the skill. */
  readonly sessionId: SessionId
  /** Published skill identity. */
  readonly skillId: string
  /** Exact published version the caller displayed. */
  readonly version: number
  /** Callable name the composer inserted. */
  readonly slug: string
}

/** Version bound to the Session's next explicit invocation. */
export interface PlazaPinValue {
  /** Skill the binding names. */
  readonly skillId: string
  /** Version that will be injected. */
  readonly version: number
  /** Callable name as stored, which is what the injection records. */
  readonly slug: string
}

/** Read one generation attempt. */
export interface PlazaJobRequest {
  /** Job to read. */
  readonly jobId: string
}

/** One generation attempt. */
export interface PlazaJobValue {
  /** The requested attempt. */
  readonly job: PlazaJobView
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A draft or published version changed; plaza surfaces refetch their
     * workspace lists.
     * @mode emit
     */
    'skill-plaza/changed'(): void
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No draft, skill, or job carries that identity in this workspace. */
    'skillPlaza/not-found': { readonly id: string }
    /** The caller's revision is behind the stored one. */
    'skillPlaza/conflict': { readonly expected: number; readonly actual: number }
    /** Another skill already uses that callable name. */
    'skillPlaza/name-conflict': { readonly slug: string }
    /** The caller's content failed validation. */
    'skillPlaza/invalid': { readonly reason: string }
  }
}
