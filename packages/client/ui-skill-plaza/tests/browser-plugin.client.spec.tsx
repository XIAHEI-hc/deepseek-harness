/**
 * ui-skill-plaza browser half: the registrations the plugin contributes and the
 * injected faces it hands to the sidebar entry, the pages, the generate action,
 * and the composer picker, driven against a real slot registry and a fake
 * Remote.
 */
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { PlazaDraftContent, PlazaMediaAsset, PlazaSkillEntry } from '@deepseek-ai/dsh-skill-plaza/types'
import { GenerateSkillButton, GenerateSkillCard, SkillPicker } from '../src/client/Actions.tsx'
import { PlazaPage } from '../src/client/PlazaPage.tsx'
import { apply, inject, PANEL_ID } from '../src/client/index.ts'
import { NS } from '../src/client/locales.ts'

const SKILL: PlazaSkillEntry = {
  skillId: 'skill-1',
  slug: 'release-metrics-compare',
  title: '发布记录指标对比',
  description: '比较两次发布记录的指标',
  version: 3,
  updatedAt: '2026-11-16T00:00:00.000Z',
  category: '数据分析',
  coverAssetId: 'asset-1',
}

const CONTENT: PlazaDraftContent = {
  title: '发布记录指标对比',
  slug: 'release-metrics-compare',
  description: '比较两次发布记录的指标',
  inputs: [],
  steps: [],
  outputs: [],
  verification: '',
  failureHandling: '',
  toolDependencies: [],
  presentation: { schemaVersion: 1, examplePrompt: '比较这两个版本' },
}

const DRAFT = {
  draftId: 'draft-1',
  revision: 2,
  updatedAt: '2026-11-16T00:00:00.000Z',
  ...CONTENT,
}

const ASSET: PlazaMediaAsset = {
  assetId: 'asset-1',
  mimeType: 'image/png',
  width: 64,
  height: 32,
  byteLength: 12,
  createdAt: '2026-11-16T00:00:00.000Z',
}

interface PageFace {
  readonly load: () => Promise<{
    workspaceKey: string
    drafts: { draftId: string }[]
    skills: PlazaSkillEntry[]
    pendingDraftId?: string
  }>
  readonly detail: (skillId: string, version: number) => Promise<unknown>
  readonly media: (assetId: string) => Promise<string>
  readonly upload: (name: string, data: string) => Promise<PlazaMediaAsset>
  readonly check: (content: PlazaDraftContent) => Promise<readonly unknown[]>
  readonly save: (
    draftId: string | undefined,
    content: PlazaDraftContent,
    revision: number | undefined,
  ) => Promise<{ ok: boolean; error?: string; conflict?: boolean }>
  readonly publish: (
    draftId: string,
    revision: number,
    content: PlazaDraftContent,
  ) => Promise<{ ok: boolean; error?: string; conflict?: boolean }>
  readonly useInConversation: (request: {
    skillId: string
    version: number
    slug: string
    examplePrompt?: string
  }) => Promise<{ ok: boolean; createdSession?: boolean; error?: string }>
  readonly consumePendingDraft: () => void
  readonly subscribe: (listener: () => void) => () => void
}

interface ActionFace {
  readonly start: (messageId: string) => void
  readonly openDraft: (draftId: string) => void
}

interface CardFace {
  readonly cancel: (messageId: string) => void
  readonly retry: (messageId: string) => void
  readonly openDraft: (draftId: string) => void
}

/** Store actions one entry's inject factory receives, recorded for assertions. */
interface RecordedTasks {
  readonly tasks: Map<string, { status: string; error?: string; draft?: { draftId: string } }>
  readonly actions: {
    setTask: (messageId: string, task: { status: string; error?: string; draft?: { draftId: string } }) => void
    clearTask: (messageId: string) => void
  }
}

/** Collect the tasks one Session's entries write. */
function recorded(): RecordedTasks {
  const tasks = new Map<string, { status: string; error?: string; draft?: { draftId: string } }>()
  return {
    tasks,
    actions: {
      setTask: (messageId, task) => { tasks.set(messageId, task) },
      clearTask: (messageId) => { tasks.delete(messageId) },
    },
  }
}

interface PickerFace {
  readonly catalog: () => Promise<PlazaSkillEntry[]>
  readonly pick: (entry: PlazaSkillEntry) => void
}

interface Faces {
  readonly slots: SlotRegistry
  readonly dictionaries: { namespace: string }[]
  readonly input: { draft: string; focus: unknown; notify: ReturnType<typeof vi.fn> }
  readonly selectPanel: ReturnType<typeof vi.fn>
  readonly createSession: ReturnType<typeof vi.fn>
  readonly openSession: ReturnType<typeof vi.fn>
  readonly plaza: Record<string, ReturnType<typeof vi.fn>>
}

/** Provide the presentation registries and the services the plugin injects. */
function provideFaces(ctx: Context, over: {
  pin?: () => Promise<unknown>
  generate?: () => Promise<unknown>
  job?: () => Promise<unknown>
  drafts?: () => Promise<unknown>
  catalog?: () => Promise<unknown>
  detail?: () => Promise<unknown>
  readMedia?: () => Promise<unknown>
  uploadMedia?: () => Promise<unknown>
  check?: () => Promise<unknown>
  saveDraft?: () => Promise<unknown>
  publish?: () => Promise<unknown>
  scope?: () => unknown
} = {}): Faces {
  const slots = new SlotRegistry(ctx)
  slots.register({
    name: 'root',
    children: {
      'sidebar.panellist': { kind: 'list', scope: 'root' },
      main: { kind: 'keyed', scope: 'root' },
      'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' },
      'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
      'conversation.input.left': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
  const dictionaries: { namespace: string }[] = []
  ctx.provide('locale', {
    register(namespace: string) {
      dictionaries.push({ namespace })
      return () => {}
    },
    bind: () => (key: string) => key,
  })
  const input = { draft: '', focus: vi.fn(), notify: vi.fn() }
  const facade = {
    state: { getSnapshot: () => ({ draft: input.draft }) },
    setDraft: (text: string) => {
      input.draft = text
    },
    focus: input.focus,
    notify: input.notify,
  }
  ctx.provide('conversation', { input: { for: () => facade } } as never)
  const createSession = vi.fn((async () => 'session-new') as never)
  ctx.provide('sessions', {
    scope: over.scope ?? (() => ctx),
    create: createSession,
  } as never)
  const selectPanel = vi.fn()
  ctx.provide('layout', { selectPanel } as never)
  const openSession = vi.fn()
  ctx.provide('uiWorkspace', { openSession } as never)
  const plaza = {
    catalog: vi.fn(over.catalog ?? (() => Promise.resolve({ ok: true as const, value: { skills: [SKILL] } }))),
    drafts: vi.fn(over.drafts ?? (() => Promise.resolve({ ok: true as const, value: { drafts: [DRAFT] } }))),
    detail: vi.fn(over.detail ?? (() => Promise.resolve({
      ok: true as const,
      value: {
        skillId: SKILL.skillId,
        slug: SKILL.slug,
        title: SKILL.title,
        version: SKILL.version,
        publishedAt: '2026-11-16T00:00:00.000Z',
        content: CONTENT,
      },
    }))),
    readMedia: vi.fn(over.readMedia ?? (() => Promise.resolve({
      ok: true as const,
      value: { asset: ASSET, data: 'AAAA' },
    }))),
    uploadMedia: vi.fn(over.uploadMedia ?? (() => Promise.resolve({ ok: true as const, value: { asset: ASSET } }))),
    check: vi.fn(over.check ?? (() => Promise.resolve({ ok: true as const, value: { issues: [] } }))),
    pin: vi.fn(over.pin ?? (() => Promise.resolve({
      ok: true as const,
      value: { skillId: SKILL.skillId, version: SKILL.version, slug: SKILL.slug },
    }))),
    saveDraft: vi.fn(over.saveDraft ?? ((request: { draftId?: string }) => request.draftId === undefined
      ? Promise.resolve({ ok: false as const, error: { code: 'skillPlaza/not-found', message: 'no plaza record "draft-1"' } })
      : Promise.resolve({ ok: true as const, value: { draft: { ...DRAFT, revision: 3 } } }))),
    publish: vi.fn(over.publish ?? (() => Promise.resolve({ ok: true as const, value: { skill: SKILL } }))),
    generate: vi.fn(over.generate ?? (() => Promise.resolve({
      ok: true as const,
      value: {
        job: {
          jobId: 'job-1',
          status: 'succeeded',
          attempt: 1,
          updatedAt: DRAFT.updatedAt,
          draftId: DRAFT.draftId,
        },
      },
    }))),
    job: vi.fn(() => Promise.resolve({
      ok: true as const,
      value: { job: { jobId: 'job-1', status: 'succeeded', attempt: 1, updatedAt: DRAFT.updatedAt } },
    })),
    cancel: vi.fn((request: { jobId: string }) => Promise.resolve({
      ok: true as const,
      value: {
        job: {
          jobId: request.jobId, status: 'cancelled', attempt: 1, updatedAt: DRAFT.updatedAt,
        },
      },
    })),
  }
  new TestRemote(ctx, { skillPlaza: plaza })
  return { slots, dictionaries, input, selectPanel, createSession, openSession, plaza }
}

/** Mount the plugin over the provided faces. */
async function bench(over: Parameters<typeof provideFaces>[1] = {}) {
  const ctx = new Context()
  const faces = provideFaces(ctx, over)
  const fiber = await ctx.plugin({ inject: [...inject], apply }).await()
  onTestFinished(async () => {
    await fiber.dispose()
  })
  return { ctx, faces, fiber }
}

/** Read the single entry a slot holds. */
function entryOf(faces: Faces, slot: string): StoredEntry {
  const entries = faces.slots.entries(slot as never)
  expect(entries).toHaveLength(1)
  return entries[0] as StoredEntry
}

/**
 * Read one injected face.
 * @param entry - slot entry whose inject factory to call.
 * @param take - identity of the face contract the call site expects.
 * @param args - owner arguments the slot passes to the factory.
 * @returns the injected face.
 */
function faceOf<T>(entry: StoredEntry, take: (face: T) => T, ...args: unknown[]): T {
  const injected = entry.inject?.(...args as never[])
  expect(injected).toBeDefined()
  return take(injected as T)
}

/** The page face of a mounted plugin. */
function pageOf(faces: Faces): PageFace {
  return faceOf<PageFace>(entryOf(faces, 'main'), face => face)
}

/** Set the active Session through the composer picker, as a real conversation does. */
async function mountConversation(faces: Faces, sessionId = 'session-1'): Promise<PickerFace> {
  const picker = faceOf<PickerFace>(entryOf(faces, 'conversation.input.left'), face => face, sessionId)
  await picker.catalog()
  return picker
}

describe('ui-skill-plaza apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual([
      'conversation', 'layout', 'locale', 'remote', 'remote.skillPlaza', 'sessions', 'slots', 'uiWorkspace',
    ])
  })

  it('registers the plaza page under one panel id and publishes its dictionaries', async () => {
    const { faces } = await bench()
    expect(faces.dictionaries).toEqual([{ namespace: NS }])
    const sidebar = entryOf(faces, 'sidebar.panellist')
    expect(sidebar.options).toMatchObject({ id: PANEL_ID, order: 6 })
    expect(sidebar.locale).toBe(NS)
    const label = sidebar.options.label
    expect(typeof label === 'function' ? label() : label).toBe('panel')

    const main = entryOf(faces, 'main')
    expect(main.component).toBe(PlazaPage)
    expect(main.options.key).toBe(PANEL_ID)
  })

  it('loads drafts and the published catalog through the page face', async () => {
    const { faces } = await bench()
    const snapshot = await pageOf(faces).load()
    expect(snapshot.drafts.map(draft => draft.draftId)).toEqual([DRAFT.draftId])
    expect(snapshot.skills.map(skill => skill.slug)).toEqual([SKILL.slug])
    expect(snapshot.pendingDraftId).toBeUndefined()
  })

  it('reads one exact published version through the page face', async () => {
    const { faces } = await bench()
    const detail = await pageOf(faces).detail(SKILL.skillId, 3)
    expect(faces.plaza.detail).toHaveBeenCalledWith({ skillId: SKILL.skillId, version: 3 })
    expect(detail).toMatchObject({ version: 3, slug: SKILL.slug, content: CONTENT })
  })

  it('reports the workspace of the Session the plaza is mounted beside', async () => {
    const { faces } = await bench()
    expect((await pageOf(faces).load()).workspaceKey).toBe('')
    await mountConversation(faces, 'session-9')
    expect((await pageOf(faces).load()).workspaceKey).toBe('session-9')
  })

  it('follows the attempt to its draft and opens that draft on request', async () => {
    const { faces } = await bench()
    const store = recorded()
    const action = faceOf<ActionFace>(
      entryOf(faces, 'conversation.chat.assistant-actions'), face => face, 'session-1', store.actions,
    )
    action.start('message-1')
    await vi.waitFor(() => { expect(store.tasks.get('message-1')?.status).toBe('succeeded') })
    expect(store.tasks.get('message-1')?.draft?.draftId).toBe(DRAFT.draftId)

    action.openDraft(DRAFT.draftId)
    expect((await pageOf(faces).load()).pendingDraftId).toBe(DRAFT.draftId)
    expect(faces.selectPanel).toHaveBeenCalledWith(PANEL_ID)
    pageOf(faces).consumePendingDraft()
    expect((await pageOf(faces).load()).pendingDraftId).toBeUndefined()
  })

  it('reports a failed attempt on the task instead of a draft', async () => {
    const { faces } = await bench({
      generate: () => Promise.resolve({
        ok: true as const,
        value: {
          job: { jobId: 'job-2', status: 'failed', attempt: 1, updatedAt: DRAFT.updatedAt, error: 'model unavailable' },
        },
      }),
    })
    const store = recorded()
    const action = faceOf<ActionFace>(
      entryOf(faces, 'conversation.chat.assistant-actions'), face => face, 'session-1', store.actions,
    )
    action.start('message-1')
    await vi.waitFor(() => {
      expect(store.tasks.get('message-1')).toMatchObject({ status: 'failed', error: 'model unavailable' })
    })
    expect((await pageOf(faces).load()).pendingDraftId).toBeUndefined()
  })

  it('registers the task card under the turn tail and stops the attempt through it', async () => {
    const running = {
      jobId: 'job-3', status: 'running' as const, attempt: 1, stage: 'distill' as const, chars: 12,
      updatedAt: DRAFT.updatedAt,
    }
    const { faces } = await bench({
      generate: () => Promise.resolve({ ok: true as const, value: { job: running } }),
      job: () => Promise.resolve({ ok: true as const, value: { job: { ...running, chars: 40 } } }),
    })
    const entry = entryOf(faces, 'conversation.chat.turnTail')
    expect(entry.component).toBe(GenerateSkillCard)

    const store = recorded()
    const card = faceOf<CardFace>(entry, face => face, 'session-1', store.actions)
    const action = faceOf<ActionFace>(
      entryOf(faces, 'conversation.chat.assistant-actions'), face => face, 'session-1', store.actions,
    )
    action.start('message-1')
    await vi.waitFor(() => {
      expect(store.tasks.get('message-1')).toMatchObject({ status: 'running', stage: 'distill' })
    })
    card.cancel('message-1')
    await vi.waitFor(() => { expect(store.tasks.get('message-1')?.status).toBe('cancelled') })
    expect(faces.plaza.cancel).toHaveBeenCalledWith({ jobId: 'job-3' })
  })

  it('pins the displayed version and writes the invoke text into the draft', async () => {
    const { faces } = await bench()
    const entry = entryOf(faces, 'conversation.input.left')
    expect(entry.component).toBe(SkillPicker)
    const face = faceOf<PickerFace>(entry, face => face, 'session-1')
    await expect(face.catalog()).resolves.toEqual([SKILL])
    face.pick(SKILL)
    await vi.waitFor(() => {
      expect(faces.input.draft).toBe(`/${SKILL.slug} `)
    })
    expect(faces.plaza.pin).toHaveBeenCalledWith({
      sessionId: 'session-1',
      skillId: SKILL.skillId,
      version: SKILL.version,
      slug: SKILL.slug,
    })
  })

  it('reports a refused pin and leaves the draft untouched', async () => {
    const { faces } = await bench({
      pin: () => Promise.resolve({ ok: false as const, error: { code: 'skillPlaza/not-found', message: 'gone' } }),
    })
    const face = faceOf<PickerFace>(entryOf(faces, 'conversation.input.left'), face => face, 'session-1')
    face.pick(SKILL)
    await vi.waitFor(() => {
      expect(faces.input.notify).toHaveBeenCalled()
    })
    expect(faces.input.draft).toBe('')
  })

  it('inserts the version on display after the pin succeeds, without sending', async () => {
    const { faces } = await bench()
    await mountConversation(faces)
    faces.input.draft = '先保留这句'
    await expect(pageOf(faces).useInConversation({
      skillId: SKILL.skillId,
      version: 3,
      slug: SKILL.slug,
    })).resolves.toEqual({ ok: true, createdSession: false })
    expect(faces.input.draft).toBe(`先保留这句 /${SKILL.slug} `)
    expect(faces.createSession).not.toHaveBeenCalled()
  })

  it('adds the example prompt after the invocation and still leaves sending to the user', async () => {
    const { faces } = await bench()
    await mountConversation(faces)
    await pageOf(faces).useInConversation({
      skillId: SKILL.skillId,
      version: 3,
      slug: SKILL.slug,
      examplePrompt: '比较这两个版本',
    })
    expect(faces.input.draft).toBe(`/${SKILL.slug} 比较这两个版本 `)
    expect(faces.input.focus).toHaveBeenCalled()
  })

  it('creates a conversation through the platform entry when none is mounted', async () => {
    const { faces } = await bench()
    await expect(pageOf(faces).useInConversation({
      skillId: SKILL.skillId,
      version: 3,
      slug: SKILL.slug,
    })).resolves.toEqual({ ok: true, createdSession: true })
    expect(faces.createSession).toHaveBeenCalledWith({})
    expect(faces.openSession).toHaveBeenCalledWith('session-new')
    expect(faces.plaza.pin).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-new', version: 3 }))
    expect(faces.input.draft).toBe(`/${SKILL.slug} `)
  })

  it('inserts nothing when the pin is refused', async () => {
    const { faces } = await bench({
      pin: () => Promise.resolve({ ok: false as const, error: { code: 'skillPlaza/not-found', message: 'gone' } }),
    })
    await mountConversation(faces)
    await expect(pageOf(faces).useInConversation({
      skillId: SKILL.skillId,
      version: 3,
      slug: SKILL.slug,
    })).resolves.toEqual({ ok: false, error: 'skillPlaza/not-found: gone' })
    expect(faces.input.draft).toBe('')
  })

  it('reads stored images as data URLs and reports refused ones', async () => {
    const { faces } = await bench()
    await expect(pageOf(faces).media('asset-1')).resolves.toBe('data:image/png;base64,AAAA')
    const refused = await bench({
      readMedia: () => Promise.resolve({ ok: false as const, error: { code: 'skillPlaza/not-found', message: 'gone' } }),
    })
    await expect(pageOf(refused.faces).media('asset-9')).rejects.toThrow('skillPlaza/not-found: gone')
  })

  it('uploads an image through the page face', async () => {
    const { faces } = await bench()
    await expect(pageOf(faces).upload('wafer.png', 'AAAA')).resolves.toEqual(ASSET)
    expect(faces.plaza.uploadMedia).toHaveBeenCalledWith({ name: 'wafer.png', data: 'AAAA' })
  })

  it('returns the located problems the Host found', async () => {
    const issue = { code: 'asset-missing', path: 'presentation.examples[0].assetId', detail: 'gone' }
    const { faces } = await bench({
      check: () => Promise.resolve({ ok: true as const, value: { issues: [issue] } }),
    })
    await expect(pageOf(faces).check(CONTENT)).resolves.toEqual([issue])
  })

  it('saves and returns the stored draft at its new revision', async () => {
    const { faces } = await bench()
    const saved = await pageOf(faces).save(DRAFT.draftId, CONTENT, DRAFT.revision)
    expect(saved.ok).toBe(true)
    expect((saved as { draft?: { revision: number } }).draft?.revision).toBe(3)
  })

  it('marks a stale revision as a conflict', async () => {
    const { faces } = await bench({
      saveDraft: () => Promise.resolve({
        ok: false as const,
        error: { code: 'skillPlaza/conflict', message: 'the draft moved to revision 5' },
      }),
    })
    await expect(pageOf(faces).save(DRAFT.draftId, CONTENT, 2)).resolves.toEqual({
      ok: false,
      error: 'skillPlaza/conflict: the draft moved to revision 5',
      conflict: true,
    })
  })

  it('publishes through the page face by saving first', async () => {
    const { faces } = await bench()
    await expect(pageOf(faces).publish(DRAFT.draftId, DRAFT.revision, CONTENT)).resolves.toEqual({ ok: true })
    expect(faces.plaza.publish).toHaveBeenCalledWith(expect.objectContaining({
      draftId: DRAFT.draftId,
      expectedRevision: 3,
      idempotencyKey: `publish-${DRAFT.draftId}-3`,
    }))
  })

  it('reports a refused save through the page face', async () => {
    const { faces } = await bench()
    const refused = await pageOf(faces).save(undefined, CONTENT, undefined)
    expect(refused).toEqual({ ok: false, error: 'skillPlaza/not-found: no plaza record "draft-1"' })
  })

  it('reports a failed drafts read through the page face', async () => {
    const { faces } = await bench({
      drafts: () => Promise.resolve({ ok: false as const, error: { code: 'gateway/internal', message: 'offline' } }),
    })
    await expect(pageOf(faces).load()).rejects.toThrow('gateway/internal: offline')
  })

  it('reports a failed catalog read through the picker face', async () => {
    const { faces } = await bench({
      catalog: () => Promise.resolve({ ok: false as const, error: { code: 'gateway/internal', message: 'offline' } }),
    })
    const face = faceOf<PickerFace>(entryOf(faces, 'conversation.input.left'), face => face, 'session-1')
    await expect(face.catalog()).rejects.toThrow('gateway/internal: offline')
  })

  it('notifies subscribers when a finished draft is opened, until they unsubscribe', async () => {
    const { faces } = await bench()
    const listener = vi.fn()
    const off = pageOf(faces).subscribe(listener)
    const store = recorded()
    const action = faceOf<ActionFace>(
      entryOf(faces, 'conversation.chat.assistant-actions'), face => face, 'session-1', store.actions,
    )
    action.openDraft(DRAFT.draftId)
    expect(listener).toHaveBeenCalled()
    off()
    expect((await pageOf(faces).load()).pendingDraftId).toBe(DRAFT.draftId)
  })

  it('registers the generate action before the picker in their slots', async () => {
    const { faces } = await bench()
    expect(entryOf(faces, 'conversation.chat.assistant-actions').component).toBe(GenerateSkillButton)
    expect(entryOf(faces, 'conversation.input.left').component).toBe(SkillPicker)
  })
})
