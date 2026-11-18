/**
 * Skills plaza plugin, browser half: the sidebar entry and its pages, the
 * finalized-assistant "Generate skill" action, and the composer skill picker.
 *
 * Every Host read and write goes through the `skillPlaza` Remote; the picker
 * inserts the native `/slug` gesture, so loading still happens at the Host's
 * pre-step boundary and the published body is the one the plaza stored. A
 * detail page pins the version it displays before inserting anything, so the
 * task that follows runs that version even after a newer one is published.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {
  PlazaDraftContent, PlazaDraftView, PlazaIssue, PlazaJobView, PlazaMediaAsset, PlazaPresentation, PlazaSkillEntry,
} from '@deepseek-ai/dsh-skill-plaza/types'
import {
  GenerateSkillButton, GenerateSkillCard, PlazaPanelIcon, SkillPicker,
  type GenerateActionFace, type GenerateCardFace,
} from './Actions.tsx'
import { createGenerationStore } from './generation-store.ts'
import type { GenerationDraftSummary, GenerationTask } from './generation-store.ts'
import {
  PlazaPage, type PlazaDetailView, type PlazaMutation, type PlazaSnapshot, type PlazaUseResult,
} from './PlazaPage.tsx'
import { en, zh, ja, es, fr, de, ru, pt, NS, type SkillPlazaKey } from './locales.ts'
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Skills plaza copy. */
    skillPlaza: SkillPlazaKey
  }
}

export type {
  GenerateActionFace, GenerateActionProps, GenerateCardFace, GenerateCardProps, PlazaActionResult, SkillPickerFace,
} from './Actions.tsx'
export type {
  PlazaDetailView, PlazaMutation, PlazaPageFace, PlazaSnapshot, PlazaUseResult, PlazaWorkspaceProps,
} from './PlazaPage.tsx'
export type { SkillPlazaKey } from './locales.ts'

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'skill-plaza' as MainPanelId

/** Services the sidebar entry, the pages, and the conversation entries read. */
export const inject = [
  'conversation', 'layout', 'locale', 'remote', 'remote.skillPlaza', 'sessions', 'slots', 'uiWorkspace',
]

/** How long the plaza waits for a freshly created conversation's composer. */
const COMPOSER_WAIT_ATTEMPTS = 20
const COMPOSER_WAIT_MS = 150

/** How often a running attempt is read while its card shows it. */
const PROGRESS_POLL_MS = 700

/** Wait one turn of the event loop; used only while a created session mounts. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Contribute the plaza pages, the generate action, and the composer picker.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-skill-plaza: dictionaries')
  const t = ctx.locale.bind(NS)
  const plaza = ctx.remote.skillPlaza
  // One generation store per Session: the action starts a task and the card
  // below the reply paints it, so both entries must see the same instance.
  const generation = createGenerationStore()
  // The plaza page is a root panel, so it addresses the workspace of the
  // Session whose conversation surfaces are mounted. Conversation entry
  // registration runs per Session and records the active one here; without a
  // Session the Host falls back to its default working directory.
  let activeSessionId: SessionId | undefined
  /** Draft a finished generation produced, handed to the page once. */
  let pendingDraftId: string | undefined
  const localListeners = new Set<() => void>()
  const sessionRequest = (): { sessionId?: SessionId } => activeSessionId === undefined ? {} : { sessionId: activeSessionId }
  const workspaceKey = (): string => activeSessionId === undefined ? '' : String(activeSessionId)

  const failureText = (error: { code: string; message: string }): string => `${error.code}: ${error.message}`

  const loadDrafts = async (): Promise<readonly PlazaDraftView[]> => {
    const result = await plaza.drafts(sessionRequest())
    if (!result.ok) throw new Error(failureText(result.error))
    return result.value.drafts
  }

  const loadCatalog = async (): Promise<readonly PlazaSkillEntry[]> => {
    const result = await plaza.catalog(sessionRequest())
    if (!result.ok) throw new Error(failureText(result.error))
    return result.value.skills
  }

  const load = async (): Promise<PlazaSnapshot> => ({
    workspaceKey: workspaceKey(),
    drafts: await loadDrafts(),
    skills: await loadCatalog(),
    ...pendingDraftId === undefined ? {} : { pendingDraftId },
  })

  const detail = async (skillId: string, version: number): Promise<PlazaDetailView> => {
    const result = await plaza.detail({ ...sessionRequest(), skillId, version })
    if (!result.ok) throw new Error(failureText(result.error))
    const value = result.value
    return {
      skillId: value.skillId,
      slug: value.slug,
      title: value.title,
      version: value.version,
      publishedAt: value.publishedAt,
      content: value.content,
      body: value.body,
    }
  }

  const media = async (assetId: string): Promise<string> => {
    const result = await plaza.readMedia({ ...sessionRequest(), assetId })
    if (!result.ok) throw new Error(failureText(result.error))
    return `data:${result.value.asset.mimeType};base64,${result.value.data}`
  }

  const upload = async (name: string, data: string): Promise<PlazaMediaAsset> => {
    const result = await plaza.uploadMedia({ ...sessionRequest(), name, data })
    if (!result.ok) throw new Error(failureText(result.error))
    return result.value.asset
  }

  const check = async (content: PlazaDraftContent): Promise<readonly PlazaIssue[]> => {
    const result = await plaza.check({ ...sessionRequest(), content })
    if (!result.ok) throw new Error(failureText(result.error))
    return result.value.issues
  }

  const save = async (
    draftId: string | undefined,
    content: PlazaDraftContent,
    expectedRevision: number | undefined,
  ): Promise<PlazaMutation> => {
    const result = await plaza.saveDraft({
      ...sessionRequest(),
      ...draftId === undefined ? {} : { draftId },
      content,
      ...expectedRevision === undefined ? {} : { expectedRevision },
    })
    return result.ok
      ? { ok: true, draft: result.value.draft }
      : { ok: false, error: failureText(result.error), ...result.error.code === 'skillPlaza/conflict' ? { conflict: true } : {} }
  }

  const publish = async (
    draftId: string,
    expectedRevision: number,
    content: PlazaDraftContent,
  ): Promise<PlazaMutation> => {
    const saved = await save(draftId, content, expectedRevision)
    if (!saved.ok) return saved
    if (saved.draft === undefined) return { ok: false, error: 'skillPlaza/internal: the saved draft was not returned' }
    const revision = saved.draft.revision
    const result = await plaza.publish({
      ...sessionRequest(),
      draftId,
      expectedRevision: revision,
      idempotencyKey: `publish-${draftId}-${revision}`,
    })
    return result.ok
      ? { ok: true }
      : { ok: false, error: failureText(result.error), ...result.error.code === 'skillPlaza/conflict' ? { conflict: true } : {} }
  }

  /**
   * Attempt state the card paints, from one Host attempt record.
   * @param job - attempt as the Host reported it.
   * @param startedAt - browser clock reading taken when the task started.
   * @returns the task the store holds.
   */
  const taskOf = (job: PlazaJobView, startedAt: number): GenerationTask => ({
    status: job.status === 'queued' ? 'running' : job.status,
    attempt: job.attempt,
    jobId: job.jobId,
    startedAt,
    ...job.stage === undefined ? {} : { stage: job.stage },
    ...job.chars === undefined ? {} : { chars: job.chars },
    ...job.error === undefined ? {} : { error: job.error },
  })

  /**
   * Summarize one draft for the result card.
   * @param draft - the draft the attempt produced.
   * @returns the fields the card shows.
   */
  const summaryOf = (draft: PlazaDraftView): GenerationDraftSummary => ({
    draftId: draft.draftId,
    title: draft.title,
    description: draft.description,
    slug: draft.slug,
    revision: draft.revision,
    steps: draft.steps.length,
    tools: draft.toolDependencies.length,
    ...draft.presentation?.category === undefined ? {} : { category: draft.presentation.category },
  })

  /** Store actions the entries of one Session write through. */
  type GenerationActions = {
    setTask: (messageId: string, task: GenerationTask) => void
    clearTask: (messageId: string) => void
  }

  /** One attempt this client is following, so a second click joins it. */
  interface GenerationRun {
    jobId?: string
    readonly startedAt: number
    /** Whether the caller stopped following this attempt. */
    readonly stopped: () => boolean
    /** Stop following it; the caller settles the task itself. */
    readonly stop: () => void
  }

  const generationRuns = new Map<string, GenerationRun>()
  const runKey = (sessionId: SessionId, messageId: string): string => `${sessionId}\u0000${messageId}`

  /**
   * Follow one attempt to its outcome and mirror it into the store.
   * @param sessionId - Session whose turn is distilled.
   * @param messageId - the Turn's closing assistant message.
   * @param actions - the Session's generation store actions.
   * @param run - the client's record of this attempt.
   */
  const driveGeneration = async (
    sessionId: SessionId,
    messageId: string,
    actions: GenerationActions,
    run: GenerationRun,
  ): Promise<void> => {
    const started = await plaza.generate({
      sessionId,
      turnId: messageId,
      idempotencyKey: `generate-${sessionId}-${messageId}`,
    })
    if (run.stopped()) return
    if (!started.ok) {
      actions.setTask(messageId, {
        status: 'failed', attempt: 1, startedAt: run.startedAt, error: failureText(started.error),
      })
      return
    }
    run.jobId = started.value.job.jobId
    let job = started.value.job
    actions.setTask(messageId, taskOf(job, run.startedAt))
    // The card shows a running attempt by reading the durable record, so a
    // reloaded tab that starts the same request joins what this one follows.
    while (!run.stopped() && (job.status === 'running' || job.status === 'queued')) {
      await delay(PROGRESS_POLL_MS)
      if (run.stopped()) return
      const read = await plaza.job({ jobId: job.jobId })
      if (!read.ok) {
        actions.setTask(messageId, {
          status: 'failed', attempt: job.attempt, jobId: job.jobId,
          startedAt: run.startedAt, error: failureText(read.error),
        })
        return
      }
      job = read.value.job
      if (job.status === 'running' || job.status === 'queued') actions.setTask(messageId, taskOf(job, run.startedAt))
    }
    if (run.stopped()) return
    if (job.status !== 'succeeded') {
      actions.setTask(messageId, taskOf(job, run.startedAt))
      return
    }
    const drafts = await loadDrafts().catch(() => undefined)
    const draft = drafts?.find(row => row.draftId === job.draftId)
    actions.setTask(messageId, {
      ...taskOf(job, run.startedAt),
      ...draft === undefined ? {} : { draft: summaryOf(draft) },
    })
  }

  /**
   * Start the generation of one Turn, unless this client already follows it.
   * @param sessionId - Session whose turn is distilled.
   * @param messageId - the Turn's closing assistant message.
   * @param actions - the Session's generation store actions.
   */
  const startGeneration = (sessionId: SessionId, messageId: string, actions: GenerationActions): void => {
    const key = runKey(sessionId, messageId)
    if (generationRuns.has(key)) return
    activeSessionId = sessionId
    let stopped = false
    const run: GenerationRun = {
      startedAt: Date.now(),
      stopped: () => stopped,
      stop: () => { stopped = true },
    }
    generationRuns.set(key, run)
    // The card appears on the click, before the Host has answered.
    actions.setTask(messageId, {
      status: 'running', attempt: 1, startedAt: run.startedAt, stage: 'harvest', chars: 0,
    })
    void driveGeneration(sessionId, messageId, actions, run)
      .catch(() => undefined)
      .finally(() => { generationRuns.delete(key) })
  }

  /**
   * Stop one attempt this client follows, and record how it settled.
   * @param sessionId - Session whose turn is distilled.
   * @param messageId - the Turn's closing assistant message.
   * @param actions - the Session's generation store actions.
   */
  const cancelGeneration = async (
    sessionId: SessionId,
    messageId: string,
    actions: GenerationActions,
  ): Promise<void> => {
    const key = runKey(sessionId, messageId)
    const run = generationRuns.get(key)
    if (run === undefined) return
    run.stop()
    generationRuns.delete(key)
    if (run.jobId === undefined) {
      actions.clearTask(messageId)
      return
    }
    const cancelled = await plaza.cancel({ jobId: run.jobId })
    actions.setTask(messageId, cancelled.ok
      ? taskOf(cancelled.value.job, run.startedAt)
      : { status: 'failed', attempt: 1, startedAt: run.startedAt, error: failureText(cancelled.error) })
  }

  /**
   * Open the plaza on one draft.
   * @param sessionId - Session whose workspace holds the draft.
   * @param draftId - draft the editor route opens.
   */
  const openDraft = (sessionId: SessionId, draftId: string): void => {
    activeSessionId = sessionId
    pendingDraftId = draftId
    notifyLocally()
    ctx.layout.selectPanel(PANEL_ID)
  }

  /** Compose the invocation text: the user's own draft first, then the call, then any example. */
  const invocationText = (existing: string, slug: string, prompt: string | undefined): string => {
    const head = existing.trimEnd()
    const parts = [head === '' ? '' : `${head} `, `/${slug}`]
    if (prompt !== undefined && prompt.trim() !== '') parts.push(` ${prompt.trim()}`)
    return `${parts.join('')} `
  }

  const insertSkill = (sessionId: SessionId, slug: string, prompt?: string): boolean => {
    const scope = ctx.sessions.scope(sessionId)
    if (scope === undefined) return false
    const input = ctx.conversation.input.for(scope)
    const draft = input.state.getSnapshot().draft
    input.setDraft(invocationText(draft, slug, prompt))
    input.focus()
    return true
  }

  /** Wait for a created conversation's composer to mount. */
  const waitForComposer = async (sessionId: SessionId): Promise<boolean> => {
    for (let attempt = 0; attempt < COMPOSER_WAIT_ATTEMPTS; attempt += 1) {
      if (ctx.sessions.scope(sessionId) !== undefined) return true
      await delay(COMPOSER_WAIT_MS)
    }
    return ctx.sessions.scope(sessionId) !== undefined
  }

  const useInConversation = async (request: {
    skillId: string
    version: number
    slug: string
    examplePrompt?: string
  }): Promise<PlazaUseResult> => {
    let createdSession = false
    let sessionId = activeSessionId
    if (sessionId === undefined) {
      // With no conversation mounted the plaza shows the Host's default
      // workspace, so the platform's own new-conversation entry opens a Session
      // in that same workspace.
      const created = await ctx.sessions.create({})
      ctx.uiWorkspace.openSession(created)
      sessionId = created
      activeSessionId = created
      createdSession = true
    }
    const pinned = await plaza.pin({
      sessionId,
      skillId: request.skillId,
      version: request.version,
      slug: request.slug,
    })
    if (!pinned.ok) return { ok: false, error: failureText(pinned.error) }
    if (createdSession) await waitForComposer(sessionId)
    if (!insertSkill(sessionId, pinned.value.slug, request.examplePrompt)) {
      return { ok: false, error: t('insertFailed') }
    }
    return { ok: true, createdSession }
  }

  const consumePendingDraft = (): void => { pendingDraftId = undefined }
  const notifyLocally = (): void => {
    for (const listener of [...localListeners]) listener()
  }
  const subscribe = (listener: () => void): (() => void) => {
    localListeners.add(listener)
    const off = ctx.remote.$on('skill-plaza/changed', listener)
    return () => {
      localListeners.delete(listener)
      off()
    }
  }

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 6,
    label: () => t('panel'),
    locale: NS,
  }, PlazaPanelIcon))

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({
      load,
      detail,
      media,
      upload,
      check,
      save,
      publish,
      useInConversation,
      consumePendingDraft,
      subscribe,
    }),
  }, PlazaPage))

  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'skill-plaza-generate',
    order: 40,
    locale: NS,
    store: generation,
    inject: (sessionId: SessionId, actions): GenerateActionFace => ({
      start: (messageId) => { startGeneration(sessionId, messageId, actions) },
      openDraft: (draftId) => { openDraft(sessionId, draftId) },
    }),
  }, GenerateSkillButton))

  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    id: 'skill-plaza-generation',
    order: 40,
    locale: NS,
    store: generation,
    inject: (sessionId: SessionId, actions): GenerateCardFace => ({
      cancel: (messageId) => { void cancelGeneration(sessionId, messageId, actions) },
      retry: (messageId) => { startGeneration(sessionId, messageId, actions) },
      openDraft: (draftId) => { openDraft(sessionId, draftId) },
    }),
  }, GenerateSkillCard))

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'skill-plaza-picker',
    order: 40,
    locale: NS,
    inject: (sessionId: SessionId) => ({
      catalog: () => {
        activeSessionId = sessionId
        return loadCatalog()
      },
      pick: (entry: PlazaSkillEntry) => {
        activeSessionId = sessionId
        void pinAndInsert(sessionId, entry)
      },
    }),
  }, SkillPicker))

  /** Pin one catalog entry, then insert it — never the other order. */
  const pinAndInsert = async (sessionId: SessionId, entry: PlazaSkillEntry): Promise<void> => {
    const scope = ctx.sessions.scope(sessionId)
    const pinned = await plaza.pin({
      sessionId,
      skillId: entry.skillId,
      version: entry.version,
      slug: entry.slug,
    })
    if (!pinned.ok) {
      ctx.conversation.input.for(scope ?? ctx).notify('error', failureText(pinned.error))
      return
    }
    insertSkill(sessionId, pinned.value.slug)
  }
}

export type { PlazaPresentation }
