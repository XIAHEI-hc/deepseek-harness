/**
 * Wire vocabulary for the Skills plaza: drafts, immutable published versions,
 * presentation content, workspace media, and the catalog the conversation
 * composer and the plaza pages select from.
 *
 * @module @deepseek-ai/dsh-skill-plaza
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Short flow labels a catalog card draws as its process thumbnail. */
export interface PlazaFlowPreview {
  /** Node labels in execution order, already shortened for a card. */
  readonly labels: readonly string[]
  /** How many of those nodes branch on a check. */
  readonly decisions: number
  /** How many nodes the active version's root layer or steps hold. */
  readonly nodes: number
}

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
  /** Optional author-chosen category the browse filter groups by. */
  readonly category?: string
  /** Optional workspace media asset shown as the card cover. */
  readonly coverAssetId?: string
  /** Process thumbnail derived from the active version, when it has one. */
  readonly flow?: PlazaFlowPreview
}

/** One result image of a skill's overview. */
export interface PlazaExample {
  /** Workspace media asset holding the image. */
  readonly assetId: string
  /** Short label naming the example. */
  readonly title: string
  /** Alternative text describing what the image shows. */
  readonly alt: string
  /** Caption rendered under the image. */
  readonly caption: string
}

/** One node of a workflow layer. */
export interface PlazaWorkflowNode {
  /** Layer-unique stable node identity the editor mints once. */
  readonly id: string
  /** Action nodes do work; decision nodes branch on a check. */
  readonly type: 'action' | 'decision'
  /** Display name of the step. */
  readonly title: string
  /** What the step is for, in one or two sentences. */
  readonly purpose?: string | undefined
  /** Named inputs the step consumes. */
  readonly inputs?: readonly string[] | undefined
  /** Checks a decision node evaluates. */
  readonly checks?: readonly string[] | undefined
  /** Outputs the step produces. */
  readonly outputs?: readonly string[] | undefined
  /** How the step's outcome is verified. */
  readonly verification?: string | undefined
  /** What to do when the step cannot complete, including retries. */
  readonly failureHandling?: string | undefined
  /** Workspace media assets illustrating the step. */
  readonly assetIds?: readonly string[] | undefined
  /** Identity of the nested layer this node opens, when it has one. */
  readonly subflowLayerId?: string | undefined
}

/** One directed edge between nodes of the same workflow layer. */
export interface PlazaWorkflowEdge {
  /** Source node identity in this layer. */
  readonly from: string
  /** Target node identity in this layer. */
  readonly to: string
  /** Branch condition a decision edge carries, such as "failed". */
  readonly label?: string | undefined
}

/** One workflow layer: the top-level graph or one node's subflow. */
export interface PlazaWorkflowLayer {
  /** Layer identity, unique within the workflow. */
  readonly id: string
  /** Identity of the node execution starts at in this layer. */
  readonly entryNodeId: string
  /** Nodes of this layer. */
  readonly nodes: readonly PlazaWorkflowNode[]
  /** Directed edges between this layer's nodes. */
  readonly edges: readonly PlazaWorkflowEdge[]
}

/**
 * A workflow as a flat set of layers plus the root layer identity. Layers are
 * flat rather than nested because a nested shape is recursive and the Remote
 * codec rejects unnamed recursive payloads.
 */
export interface PlazaWorkflow {
  /** Identity of the layer execution starts at. */
  readonly rootLayerId: string
  /** Every layer of the workflow, top level first. */
  readonly layers: readonly PlazaWorkflowLayer[]
}

/** Optional presentation content: how the plaza shows a published version. */
export interface PlazaPresentation {
  /** Version of the presentation schema this content was written against. */
  readonly schemaVersion: number
  /** Author-chosen category the browse filter groups by. */
  readonly category?: string | undefined
  /** Situations the skill applies to. */
  readonly scenarios?: readonly string[] | undefined
  /** Example request the caller can take into the composer. */
  readonly examplePrompt?: string | undefined
  /** Workspace media asset shown as the card cover. */
  readonly coverAssetId?: string | undefined
  /** Result images shown in the overview, in author order. */
  readonly examples?: readonly PlazaExample[] | undefined
  /** Structured workflow shown in the execution-process view. */
  readonly workflow?: PlazaWorkflow | undefined
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
  /** Optional display content; absent for drafts written before it existed. */
  readonly presentation?: PlazaPresentation
}

/** Where a draft was distilled from, retained for authorization and audit. */
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
  /** Source turn of a distilled draft. */
  readonly source?: PlazaDraftSource
}

/** Status of one generation attempt. */
export type PlazaJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/**
 * Stage one running attempt reports, in the order it reaches them. A caller
 * renders the steps it has not reached yet as pending, from `stage` alone.
 */
export type PlazaJobStage = 'harvest' | 'distill' | 'check' | 'save'

/** One generation attempt as the plaza generation view reads it. */
export interface PlazaJobView {
  /** Durable job identity. */
  readonly jobId: string
  /** Current status; `succeeded` carries `draftId`, `failed` carries `error`. */
  readonly status: PlazaJobStatus
  /** Attempt counter, incremented by an explicit retry. */
  readonly attempt: number
  /** Stage a running attempt reached; absent once the attempt settled. */
  readonly stage?: PlazaJobStage
  /** Characters the model had produced when the attempt last reported. */
  readonly chars?: number
  /** ISO timestamp the attempt started. */
  readonly startedAt?: string
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

/**
 * One generation attempt. The call returns as soon as the attempt exists, not
 * when it settles; callers read progress with {@link PlazaJobRequest}.
 */
export interface PlazaGenerateValue {
  /** Attempt started by this request, or the attempt a repeated request joined. */
  readonly job: PlazaJobView
}

/** Stop one running attempt. */
export interface PlazaCancelRequest {
  /** Attempt to stop. */
  readonly jobId: string
}

/** The attempt after a cancellation request. */
export interface PlazaCancelValue {
  /** Attempt as stored; a call that arrives after it settled returns it unchanged. */
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

/** Read one published version's presentation and operating content. */
export interface PlazaDetailRequest extends PlazaSessionRequest {
  /** Published skill identity. */
  readonly skillId: string
  /** Exact published version the page displays. */
  readonly version: number
}

/** One published version as the detail pages read it. */
export interface PlazaDetailValue {
  /** Catalog identity of the skill this version belongs to. */
  readonly skillId: string
  /** Callable name of that version. */
  readonly slug: string
  /** Title of that version. */
  readonly title: string
  /** The exact version that was read. */
  readonly version: number
  /** ISO timestamp of that version's publication. */
  readonly publishedAt: string
  /** The version's complete content, including optional presentation. */
  readonly content: PlazaDraftContent
  /** The model-facing body this version stores, exactly as the skill tool reads it. */
  readonly body: string
}

/** One problem the plaza reports about draft content, located where an editor can mark it. */
export interface PlazaIssue {
  /** Machine-readable kind of problem. */
  readonly code: PlazaIssueCode
  /** Content path such as `workflow.nodes[2].id`, which the editor maps back to a control. */
  readonly path: string
  /** Readable reason, without product copy in any single locale. */
  readonly detail: string
  /** Workflow node the problem belongs to, when it belongs to one. */
  readonly nodeId?: string
  /** Media asset identity the problem names, when it names one. */
  readonly assetId?: string
}

/** Kinds of content problem the plaza reports. */
export type PlazaIssueCode =
  | 'slug-invalid'
  | 'title-missing'
  | 'description-missing'
  | 'presentation-unsupported'
  | 'example-limit'
  | 'asset-missing'
  | 'workflow-root-missing'
  | 'layer-id-duplicate'
  | 'layer-unreachable'
  | 'subflow-missing'
  | 'workflow-entry-missing'
  | 'node-id-duplicate'
  | 'node-id-empty'
  | 'edge-dangling'
  | 'node-unreachable'
  | 'decision-unlabeled'
  | 'workflow-depth'
  | 'node-limit'
  | 'node-title-missing'
  | 'node-asset-missing'

/** Validate draft content or a publication candidate without writing. */
export interface PlazaCheckRequest extends PlazaSessionRequest {
  /** Content to validate, exactly as the editor currently holds it. */
  readonly content: PlazaDraftContent
}

/** Located problems found in the checked content; empty means publishable. */
export interface PlazaCheckValue {
  /** Every problem found, ordered by content path. */
  readonly issues: readonly PlazaIssue[]
}

/** Static image formats the plaza accepts as result media. */
export type PlazaMediaType = 'image/png' | 'image/jpeg' | 'image/webp'

/** One stored workspace image, without its bytes. */
export interface PlazaMediaAsset {
  /** Immutable asset identity, unique inside its workspace. */
  readonly assetId: string
  /** Detected format of the stored bytes. */
  readonly mimeType: PlazaMediaType
  /** Pixel width. */
  readonly width: number
  /** Pixel height. */
  readonly height: number
  /** Size of the stored file in bytes. */
  readonly byteLength: number
  /** ISO timestamp of the upload. */
  readonly createdAt: string
}

/** Store one image in the Session's workspace. */
export interface PlazaMediaUploadRequest extends PlazaSessionRequest {
  /** Original file name, used only as a readability hint in diagnostics. */
  readonly name: string
  /** Complete file bytes, base64-encoded. */
  readonly data: string
}

/** The stored asset an upload produced. */
export interface PlazaMediaUploadValue {
  /** Identity and detected facts of the stored image. */
  readonly asset: PlazaMediaAsset
}

/** Read one stored workspace image. */
export interface PlazaMediaReadRequest extends PlazaSessionRequest {
  /** Asset to read. */
  readonly assetId: string
}

/** One stored image and its bytes. */
export interface PlazaMediaReadValue {
  /** Identity and detected facts of the image. */
  readonly asset: PlazaMediaAsset
  /** Base64-encoded file bytes. */
  readonly data: string
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
    /** No draft, skill, job, or media asset carries that identity in this workspace. */
    'skillPlaza/not-found': { readonly id: string }
    /** The caller's revision is behind the stored one. */
    'skillPlaza/conflict': { readonly expected: number; readonly actual: number }
    /** Another skill already uses that callable name. */
    'skillPlaza/name-conflict': { readonly slug: string }
    /** The caller's content failed validation. */
    'skillPlaza/invalid': { readonly reason: string }
    /** An upload is not a static image this plaza can store. */
    'skillPlaza/unsupported-media': { readonly reason: string }
    /** An upload or stored asset exceeds a size bound. */
    'skillPlaza/too-large': { readonly limit: number }
  }
}
