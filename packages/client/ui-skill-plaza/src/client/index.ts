/**
 * Skills plaza plugin, browser half: the sidebar entry and its page, the
 * finalized-assistant "Generate skill" action, and the composer skill picker.
 *
 * Every Host read and write goes through the `skillPlaza` Remote; the picker
 * inserts the native `/slug` gesture, so loading still happens at the Host's
 * pre-step boundary and the published body is the one the plaza stored.
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
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type { PlazaDraftContent, PlazaDraftView, PlazaSkillEntry } from '@deepseek-ai/dsh-skill-plaza/types'
import { GenerateSkillButton, PlazaPanelIcon, SkillPicker, type PlazaActionResult } from './Actions.tsx'
import { PlazaPage, type PlazaSnapshot } from './PlazaPage.tsx'
import { en, zh, ja, es, fr, de, ru, pt, NS, type SkillPlazaKey } from './locales.ts'
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Skills plaza copy. */
    skillPlaza: SkillPlazaKey
  }
}

export type { PlazaActionResult, GenerateActionFace, SkillPickerFace } from './Actions.tsx'
export type { PlazaMutation, PlazaPageFace, PlazaSnapshot } from './PlazaPage.tsx'
export type { SkillPlazaKey } from './locales.ts'


/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'skill-plaza' as MainPanelId

/** Services the sidebar entry, the page, and the conversation entries read. */
export const inject = ['conversation', 'layout', 'locale', 'remote', 'remote.skillPlaza', 'sessions', 'slots']

/**
 * Contribute the plaza page, the generate action, and the composer picker.
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
  const sessionRequest = (): { sessionId?: SessionId } => activeSessionId === undefined ? {} : { sessionId: activeSessionId }

  const loadDrafts = async (): Promise<readonly PlazaDraftView[]> => {
    const result = await plaza.drafts(sessionRequest())
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value.drafts
  }

  const loadCatalog = async (): Promise<readonly PlazaSkillEntry[]> => {
    const result = await plaza.catalog(sessionRequest())
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value.skills
  }

  const load = async (): Promise<PlazaSnapshot> => ({
    drafts: await loadDrafts(),
    skills: await loadCatalog(),
  })

  const save = async (
    draftId: string | undefined,
    content: PlazaDraftContent,
    expectedRevision: number | undefined,
  ): Promise<PlazaActionResult> => {
    const result = await plaza.saveDraft({
      ...sessionRequest(),
      ...draftId === undefined ? {} : { draftId },
      content,
      ...expectedRevision === undefined ? {} : { expectedRevision },
    })
    return result.ok
      ? { ok: true }
      : { ok: false, error: `${result.error.code}: ${result.error.message}` }
  }

  const publish = async (
    draftId: string,
    expectedRevision: number,
    content: PlazaDraftContent,
  ): Promise<PlazaActionResult> => {
    const saved = await plaza.saveDraft({ ...sessionRequest(), draftId, content, expectedRevision })
    if (!saved.ok) return { ok: false, error: `${saved.error.code}: ${saved.error.message}` }
    const revision = saved.value.draft.revision
    const result = await plaza.publish({
      ...sessionRequest(),
      draftId,
      expectedRevision: revision,
      idempotencyKey: `publish-${draftId}-${revision}`,
    })
    return result.ok
      ? { ok: true }
      : { ok: false, error: `${result.error.code}: ${result.error.message}` }
  }

  const generate = async (sessionId: SessionId, messageId: string): Promise<PlazaActionResult> => {
    const result = await plaza.generate({
      sessionId,
      turnId: messageId,
      idempotencyKey: `generate-${sessionId}-${messageId}`,
    })
    if (!result.ok) return { ok: false, error: `${result.error.code}: ${result.error.message}` }
    return result.value.job.status === 'succeeded'
      ? { ok: true }
      : { ok: false, error: result.value.job.error ?? result.value.job.status }
  }

  const insertSkill = (sessionId: SessionId, slug: string): void => {
    const scope = ctx.sessions.scope(sessionId)
    if (scope === undefined) return
    const input = ctx.conversation.input.for(scope)
    const draft = input.state.getSnapshot().draft
    input.setDraft(draft.trimEnd() === '' ? `/${slug} ` : `${draft.trimEnd()} /${slug} `)
    input.focus()
  }

  const pinAndInsert = async (sessionId: SessionId, entry: PlazaSkillEntry): Promise<void> => {
    const scope = ctx.sessions.scope(sessionId)
    const pinned = await plaza.pin({
      sessionId,
      skillId: entry.skillId,
      version: entry.version,
      slug: entry.slug,
    })
    if (!pinned.ok) {
      ctx.conversation.input.for(scope ?? ctx).notify('error', `${pinned.error.code}: ${pinned.error.message}`)
      return
    }
    insertSkill(sessionId, pinned.value.slug)
  }

  const subscribe = (listener: () => void): (() => void) => ctx.remote.$on('skill-plaza/changed', listener)

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
    inject: () => ({ load, save, publish, subscribe }),
  }, PlazaPage))

  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'skill-plaza-generate',
    order: 40,
    locale: NS,
    inject: (sessionId: SessionId) => ({
      generate: (messageId: string) => {
        activeSessionId = sessionId
        return generate(sessionId, messageId)
      },
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
}
