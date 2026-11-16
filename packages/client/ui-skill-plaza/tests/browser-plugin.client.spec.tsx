/**
 * ui-skill-plaza browser half: the registrations the plugin contributes and the
 * injected faces it hands to the sidebar entry, the page, the generate action,
 * and the composer picker, driven against a real slot registry and a fake
 * Remote.
 */
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { PlazaSkillEntry } from '@deepseek-ai/dsh-skill-plaza/types'
import { GenerateSkillButton, SkillPicker } from '../src/client/Actions.tsx'
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
}

const DRAFT = {
  draftId: 'draft-1',
  revision: 2,
  updatedAt: '2026-11-16T00:00:00.000Z',
  title: '发布记录指标对比',
  slug: 'release-metrics-compare',
  description: '比较两次发布记录的指标',
  inputs: [],
  steps: [],
  outputs: [],
  verification: '',
  failureHandling: '',
  toolDependencies: [],
}

interface PageFace {
  readonly load: () => Promise<{ drafts: { draftId: string }[]; skills: PlazaSkillEntry[] }>
}

interface MutationFace {
  readonly save: (draftId: string | undefined, content: unknown, revision: number | undefined) => Promise<{ ok: boolean; error?: string }>
  readonly publish: (draftId: string, revision: number, content: unknown) => Promise<{ ok: boolean; error?: string }>
}

interface ActionFace {
  readonly generate: (messageId: string) => Promise<{ ok: boolean; error?: string }>
  readonly openPlaza: () => void
}

interface PickerFace {
  readonly catalog: () => Promise<PlazaSkillEntry[]>
  readonly pick: (entry: PlazaSkillEntry) => void
}

interface Faces {
  readonly slots: SlotRegistry
  readonly dictionaries: { namespace: string }[]
  readonly input: { draft: string; notify: ReturnType<typeof vi.fn> }
  readonly selectPanel: ReturnType<typeof vi.fn>
}

/** Provide the presentation registries and the services the plugin injects. */
function provideFaces(ctx: Context, over: {
  pin?: () => Promise<unknown>
  generate?: () => Promise<unknown>
  drafts?: () => Promise<unknown>
  catalog?: () => Promise<unknown>
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
  const input = { draft: '', notify: vi.fn() }
  const facade = {
    state: { getSnapshot: () => ({ draft: input.draft }) },
    setDraft: (text: string) => { input.draft = text },
    focus: vi.fn(),
    notify: input.notify,
  }
  ctx.provide('conversation', { input: { for: () => facade } } as never)
  ctx.provide('sessions', { scope: over.scope ?? (() => ctx) } as never)
  const selectPanel = vi.fn()
  ctx.provide('layout', { selectPanel } as never)
  new TestRemote(ctx, {
    skillPlaza: {
      catalog: over.catalog ?? (() => Promise.resolve({ ok: true as const, value: { skills: [SKILL] } })),
      drafts: over.drafts ?? (() => Promise.resolve({ ok: true as const, value: { drafts: [DRAFT] } })),
      pin: over.pin ?? (() => Promise.resolve({
        ok: true as const,
        value: { skillId: SKILL.skillId, version: SKILL.version, slug: SKILL.slug },
      })),
      saveDraft: over.saveDraft ?? ((request: { draftId?: string }) => request.draftId === undefined
        ? Promise.resolve({ ok: false as const, error: { code: 'skillPlaza/not-found', message: 'no plaza record "draft-1"' } })
        : Promise.resolve({ ok: true as const, value: { draft: DRAFT } })),
      publish: over.publish ?? (() => Promise.resolve({ ok: true as const, value: { skill: SKILL } })),
      generate: over.generate ?? (() => Promise.resolve({
        ok: true as const,
        value: { job: { jobId: 'job-1', status: 'succeeded', attempt: 1, updatedAt: DRAFT.updatedAt, draftId: DRAFT.draftId } },
      })),
      job: () => Promise.resolve({ ok: true as const, value: { job: { jobId: 'job-1', status: 'succeeded', attempt: 1, updatedAt: DRAFT.updatedAt } } }),
    },
  })
  return { slots, dictionaries, input, selectPanel }
}

/** Mount the plugin over the provided faces. */
async function bench(over: Parameters<typeof provideFaces>[1] = {}) {
  const ctx = new Context()
  const faces = provideFaces(ctx, over)
  const fiber = await ctx.plugin({ inject: [...inject], apply }).await()
  onTestFinished(async () => { await fiber.dispose() })
  return { ctx, faces, fiber }
}

/** Read the single entry a slot holds. */
function entryOf(faces: Faces, slot: string): StoredEntry {
  const entries = faces.slots.entries(slot as never)
  expect(entries).toHaveLength(1)
  return entries[0] as StoredEntry
}

/** Read one injected face. */
function faceOf<T>(entry: StoredEntry, ...args: string[]): T {
  const injected = entry.inject?.(...args as never[])
  expect(injected).toBeDefined()
  return injected as T
}

describe('ui-skill-plaza apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['conversation', 'layout', 'locale', 'remote', 'remote.skillPlaza', 'sessions', 'slots'])
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
    const face = faceOf<PageFace>(entryOf(faces, 'main'))
    const snapshot = await face.load()
    expect(snapshot.drafts.map(draft => draft.draftId)).toEqual([DRAFT.draftId])
    expect(snapshot.skills.map(skill => skill.slug)).toEqual([SKILL.slug])
  })

  it('generates for the finalized reply and opens the plaza', async () => {
    const { faces } = await bench()
    const entry = entryOf(faces, 'conversation.chat.assistant-actions')
    expect(entry.component).toBe(GenerateSkillButton)
    const face = faceOf<ActionFace>(entry, 'session-1')
    await expect(face.generate('message-1')).resolves.toEqual({ ok: true })
    face.openPlaza()
    expect(faces.selectPanel).toHaveBeenCalledWith(PANEL_ID)
  })

  it('reports a failed generation through the action face', async () => {
    const { faces } = await bench({
      generate: () => Promise.resolve({
        ok: true as const,
        value: { job: { jobId: 'job-2', status: 'failed', attempt: 1, updatedAt: DRAFT.updatedAt, error: 'model unavailable' } },
      }),
    })
    const face = faceOf<ActionFace>(entryOf(faces, 'conversation.chat.assistant-actions'), 'session-1')
    await expect(face.generate('message-1')).resolves.toEqual({ ok: false, error: 'model unavailable' })
  })

  it('pins the displayed version and writes the invoke text into the draft', async () => {
    const { faces } = await bench()
    const entry = entryOf(faces, 'conversation.input.left')
    expect(entry.component).toBe(SkillPicker)
    const face = faceOf<PickerFace>(entry, 'session-1')
    await expect(face.catalog()).resolves.toEqual([SKILL])
    face.pick(SKILL)
    await vi.waitFor(() => { expect(faces.input.draft).toBe(`/${SKILL.slug} `) })
  })

  it('reports a refused pin and leaves the draft untouched', async () => {
    const { faces } = await bench({
      pin: () => Promise.resolve({ ok: false as const, error: { code: 'skillPlaza/not-found', message: 'gone' } }),
    })
    const face = faceOf<PickerFace>(entryOf(faces, 'conversation.input.left'), 'session-1')
    face.pick(SKILL)
    await vi.waitFor(() => { expect(faces.input.notify).toHaveBeenCalled() })
    expect(faces.input.draft).toBe('')
  })

  it('publishes through the page face by saving first', async () => {
    const { faces } = await bench()
    const page = faceOf<MutationFace & PageFace>(entryOf(faces, 'main'))
    const saved = await page.save(DRAFT.draftId, { title: 'x' }, DRAFT.revision)
    expect(saved).toEqual({ ok: true })
    const published = await page.publish(DRAFT.draftId, DRAFT.revision, { title: 'x' })
    expect(published).toEqual({ ok: true })
  })

  it('reports a refused save through the page face', async () => {
    const { faces } = await bench()
    const page = faceOf<MutationFace>(entryOf(faces, 'main'))
    const refused = await page.save(undefined, { title: 'x' }, undefined)
    expect(refused).toEqual({ ok: false, error: 'skillPlaza/not-found: no plaza record "draft-1"' })
  })

  it('reports a failed drafts read through the page face', async () => {
    const { faces } = await bench({
      drafts: () => Promise.resolve({ ok: false as const, error: { code: 'gateway/internal', message: 'offline' } }),
    })
    const page = faceOf<PageFace>(entryOf(faces, 'main'))
    await expect(page.load()).rejects.toThrow('gateway/internal: offline')
  })

  it('reports a failed catalog read through the picker face', async () => {
    const { faces } = await bench({
      catalog: () => Promise.resolve({ ok: false as const, error: { code: 'gateway/internal', message: 'offline' } }),
    })
    const face = faceOf<PickerFace>(entryOf(faces, 'conversation.input.left'), 'session-1')
    await expect(face.catalog()).rejects.toThrow('gateway/internal: offline')
  })

  it('reports a refused publish after the save succeeded', async () => {
    const { faces } = await bench({
      publish: () => Promise.resolve({ ok: false as const, error: { code: 'skillPlaza/conflict', message: 'moved' } }),
    })
    const page = faceOf<MutationFace>(entryOf(faces, 'main'))
    await expect(page.publish(DRAFT.draftId, DRAFT.revision, { title: 'x' }))
      .resolves.toEqual({ ok: false, error: 'skillPlaza/conflict: moved' })
  })

  it('reports a refused save inside publish without calling the publish endpoint', async () => {
    const { faces } = await bench({
      saveDraft: () => Promise.resolve({ ok: false as const, error: { code: 'skillPlaza/not-found', message: 'gone' } }),
    })
    const page = faceOf<MutationFace>(entryOf(faces, 'main'))
    await expect(page.publish(DRAFT.draftId, DRAFT.revision, { title: 'x' }))
      .resolves.toEqual({ ok: false, error: 'skillPlaza/not-found: gone' })
  })

  it('reports a failed generation call and a job that did not succeed', async () => {
    const failed = await bench({
      generate: () => Promise.resolve({ ok: false as const, error: { code: 'gateway/internal', message: 'offline' } }),
    })
    const failedFace = faceOf<ActionFace>(entryOf(failed.faces, 'conversation.chat.assistant-actions'), 'session-1')
    await expect(failedFace.generate('message-1')).resolves.toEqual({ ok: false, error: 'gateway/internal: offline' })
    await failed.fiber.dispose()

    const running = await bench({
      generate: () => Promise.resolve({
        ok: true as const,
        value: { job: { jobId: 'job-3', status: 'running', attempt: 1, updatedAt: DRAFT.updatedAt } },
      }),
    })
    const runningFace = faceOf<ActionFace>(entryOf(running.faces, 'conversation.chat.assistant-actions'), 'session-1')
    await expect(runningFace.generate('message-1')).resolves.toEqual({ ok: false, error: 'running' })
  })

  it('appends the invoke text to an existing draft', async () => {
    const { faces } = await bench()
    faces.input.draft = '已有内容'
    const face = faceOf<PickerFace>(entryOf(faces, 'conversation.input.left'), 'session-1')
    face.pick(SKILL)
    await vi.waitFor(() => { expect(faces.input.draft).toBe(`已有内容 /${SKILL.slug} `) })
  })

  it('skips the insert when the Session has no scope', async () => {
    const { faces } = await bench({ scope: () => undefined })
    const face = faceOf<PickerFace>(entryOf(faces, 'conversation.input.left'), 'session-1')
    face.pick(SKILL)
    await Promise.resolve()
    expect(faces.input.draft).toBe('')
  })

  it('notifies without a scope when the pin is refused', async () => {
    const { faces } = await bench({
      scope: () => undefined,
      pin: () => Promise.resolve({ ok: false as const, error: { code: 'skillPlaza/not-found', message: 'gone' } }),
    })
    const face = faceOf<PickerFace>(entryOf(faces, 'conversation.input.left'), 'session-1')
    face.pick(SKILL)
    await vi.waitFor(() => { expect(faces.input.notify).toHaveBeenCalled() })
  })

  it('subscribes to plaza changes and unsubscribes', async () => {
    const { faces } = await bench()
    const page = faceOf<PageFace & { subscribe: (listener: () => void) => () => void }>(entryOf(faces, 'main'))
    const listener = vi.fn()
    const unsubscribe = page.subscribe(listener)
    unsubscribe()
  })

  it('removes every contribution when the plugin fiber is disposed', async () => {
    const ctx = new Context()
    const faces = provideFaces(ctx)
    const fiber = await ctx.plugin({ inject: [...inject], apply }).await()
    expect(faces.slots.entries('sidebar.panellist' as never)).toHaveLength(1)
    await fiber.dispose()
    expect(faces.slots.entries('sidebar.panellist' as never)).toHaveLength(0)
    expect(faces.slots.entries('main' as never)).toHaveLength(0)
    expect(faces.slots.entries('conversation.chat.assistant-actions' as never)).toHaveLength(0)
    expect(faces.slots.entries('conversation.input.left' as never)).toHaveLength(0)
  })
})
