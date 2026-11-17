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
  PlazaDraftContent, PlazaDraftView, PlazaIssue, PlazaMediaAsset, PlazaPresentation, PlazaSkillEntry,
} from '@deepseek-ai/dsh-skill-plaza/types'
import { GenerateSkillButton, PlazaPanelIcon, SkillPicker, type PlazaActionResult } from './Actions.tsx'
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

export type { PlazaActionResult, GenerateActionFace, SkillPickerFace } from './Actions.tsx'
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

  const generate = async (sessionId: SessionId, messageId: string): Promise<PlazaActionResult> => {
    activeSessionId = sessionId
    const result = await plaza.generate({
      sessionId,
      turnId: messageId,
      idempotencyKey: `generate-${sessionId}-${messageId}`,
    })
    if (!result.ok) return { ok: false, error: failureText(result.error) }
    if (result.value.job.status !== 'succeeded') {
      return { ok: false, error: result.value.job.error ?? result.value.job.status }
    }
    // A succeeded attempt names its draft; the page opens exactly that one.
    pendingDraftId = result.value.job.draftId
    notifyLocally()
    return { ok: true }
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
    inject: (sessionId: SessionId) => ({
      generate: (messageId: string) => generate(sessionId, messageId),
      openPlaza: () => { ctx.layout.selectPanel(PANEL_ID) },
    }),
  }, GenerateSkillButton))

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
