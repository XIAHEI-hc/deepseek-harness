/**
 * Real-composition specs for the Skills plaza Host service: the shipped storage
 * domain, skill registry, working directory, and agent registry, with the plaza
 * provider serving published bodies.
 */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, expect, it } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import SkillPlazaService, { PLAZA_PROVIDER, renderSkillBody } from '../src/index.ts'
import type { PlazaDraftContent } from '../src/types.ts'

const MISSING_WORKSPACE = '/workspace/missing'

/** Fake cold-Session observation backed by the mounted working directory. */
function sessionQueryStub(workspace: string) {
  return {
    observeSession: async (sessionId: string) => {
      if (sessionId.startsWith('cold-')) throw new Error(`session "${sessionId}" is not persisted`)
      return {
        // A session named "other-…" reports a different workspace.
        header: { cwd: sessionId.startsWith('other-') ? MISSING_WORKSPACE : workspace },
        projections: undefined,
        [Symbol.dispose]() {},
      }
    },
  }
}

const CONTENT: PlazaDraftContent = {
  title: 'Release metric comparison',
  slug: 'release-metrics-compare',
  description: 'Compare two release records and report deltas.',
  inputs: ['changelog_path'],
  steps: ['read the changelog', 'tabulate both rows', 'compute deltas'],
  outputs: ['comparison table'],
  verification: 'every value matches the source line',
  failureHandling: 'report the discrepancy and ask which entries to compare',
  toolDependencies: ['file read'],
}

interface Bench {
  readonly ctx: Context
  readonly plaza: SkillPlazaService
  readonly workspace: string
  readonly close: () => Promise<void>
}

let bench: Bench | undefined

/** Mount the plaza over real storage, skills, and working directory. */
async function mount(): Promise<Bench> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
  const workspace = ctx.workingDirectory.defaultDirectory
  ctx.provide('sessionQuery', sessionQueryStub(workspace) as never)
  const fiber = await ctx.plugin(SkillPlazaService)
  bench = {
    ctx,
    plaza: ctx.skillPlaza,
    workspace,
    close: async () => {
      await fiber.dispose()
      await facility.closeAll()
      await backend.close()
    },
  }
  return bench
}

afterEach(async () => {
  await bench?.close()
  bench = undefined
})

/** Save one draft and return its stored view. */
async function createDraft(current: Bench, content: PlazaDraftContent = CONTENT) {
  const saved = await current.plaza.saveDraft({ content })
  return saved.draft
}

it('creates a draft at revision one and lists it for the workspace', async () => {
  const current = await mount()
  const draft = await createDraft(current)

  expect(draft).toMatchObject({ revision: 1, slug: CONTENT.slug, title: CONTENT.title })
  expect(draft.source).toBeUndefined()
  expect((await current.plaza.drafts({})).drafts.map(row => row.draftId)).toEqual([draft.draftId])
})

it('refuses a save whose revision is behind and accepts the matching one', async () => {
  const current = await mount()
  const draft = await createDraft(current)

  const stale = await current.plaza.saveDraft({
    draftId: draft.draftId,
    content: { ...CONTENT, title: 'stale' },
    expectedRevision: 0,
  }).catch((error: unknown) => error)
  expect(remoteErrorOf(stale)).toMatchObject({ code: 'skillPlaza/conflict', details: { expected: 0, actual: 1 } })

  const saved = await current.plaza.saveDraft({
    draftId: draft.draftId,
    content: { ...CONTENT, title: 'fresh' },
    expectedRevision: 1,
  })
  expect(saved.draft).toMatchObject({ revision: 2, title: 'fresh' })
})

it('rejects content that cannot be served as a skill name', async () => {
  const current = await mount()
  const failure = await current.plaza
    .saveDraft({ content: { ...CONTENT, slug: 'Not A Name' } })
    .catch((error: unknown) => error)

  expect(remoteErrorOf(failure)).toMatchObject({ code: 'skillPlaza/invalid', details: { reason: 'slug' } })
})

it('publishes an immutable version and makes it the catalog entry', async () => {
  const current = await mount()
  const draft = await createDraft(current)

  const published = await current.plaza.publish({
    draftId: draft.draftId,
    expectedRevision: 1,
    idempotencyKey: 'publish-1',
  })
  expect(published.skill).toMatchObject({ slug: CONTENT.slug, version: 1 })

  const repeated = await current.plaza.publish({
    draftId: draft.draftId,
    expectedRevision: 1,
    idempotencyKey: 'publish-1-again',
  })
  expect(repeated.skill.version).toBe(1)
  expect((await current.plaza.catalog({})).skills).toEqual([published.skill])
})

it('serves the published body through the skill registry', async () => {
  const current = await mount()
  const draft = await createDraft(current)
  await current.plaza.publish({ draftId: draft.draftId, expectedRevision: 1, idempotencyKey: 'publish-registry' })

  const listed = await current.ctx.skills.list({ cwd: current.workspace })
  expect(listed.map(skill => ({ name: skill.name, provider: skill.provider }))).toEqual([{ name: CONTENT.slug, provider: PLAZA_PROVIDER }])

  const loaded = await current.ctx.skills.get(CONTENT.slug, { cwd: current.workspace })
  expect(loaded?.content).toBe(renderSkillBody(CONTENT))
  expect(await current.ctx.skills.get('missing-skill', { cwd: current.workspace })).toBeUndefined()
})

it('refuses a second draft that claims a taken callable name', async () => {
  const current = await mount()
  const first = await createDraft(current)
  await current.plaza.publish({ draftId: first.draftId, expectedRevision: 1, idempotencyKey: 'publish-first' })

  const second = await createDraft(current)
  const failure = await current.plaza
    .publish({ draftId: second.draftId, expectedRevision: 1, idempotencyKey: 'publish-second' })
    .catch((error: unknown) => error)
  expect(remoteErrorOf(failure)).toMatchObject({ code: 'skillPlaza/name-conflict', details: { slug: CONTENT.slug } })
})

it('pins one published version and refuses an unpublished one', async () => {
  const current = await mount()
  const draft = await createDraft(current)
  const published = await current.plaza.publish({ draftId: draft.draftId, expectedRevision: 1, idempotencyKey: 'publish-pin' })

  const pinned = await current.plaza.pin({
    sessionId: 'session-pinned' as never,
    skillId: published.skill.skillId,
    version: 1,
    slug: CONTENT.slug,
  })
  expect(pinned).toEqual({ skillId: published.skill.skillId, version: 1, slug: CONTENT.slug })

  const failure = await current.plaza.pin({
    sessionId: 'session-pinned' as never,
    skillId: published.skill.skillId,
    version: 99,
    slug: CONTENT.slug,
  }).catch((error: unknown) => error)
  expect(remoteErrorOf(failure)).toMatchObject({ code: 'skillPlaza/not-found' })
})

it('records a generation failure on the attempt instead of producing a draft', async () => {
  const current = await mount()
  const generated = await current.plaza.generate({
    sessionId: 'missing-session' as never,
    turnId: 'turn-1',
    idempotencyKey: 'generate-1',
  }, new AbortController().signal)

  expect(generated.job).toMatchObject({ status: 'failed', attempt: 1 })
  expect(generated.job.error).toContain('not live')
  expect((await current.plaza.job({ jobId: generated.job.jobId })).job).toEqual(generated.job)
})

it('reports an unknown Session when the session-query service is absent', async () => {
  const current = await mount()
  const failure = await current.plaza.drafts({ sessionId: 'cold-session' as never }).catch((error: unknown) => error)
  expect(remoteErrorOf(failure)).toMatchObject({ code: 'gateway/internal' })
})

it('lets a separately registered skill win the name while both stay loadable', async () => {
  const current = await mount()
  const draft = await createDraft(current)
  await current.plaza.publish({ draftId: draft.draftId, expectedRevision: 1, idempotencyKey: 'publish-shadow' })
  current.ctx.skills.register({ name: CONTENT.slug, description: 'runtime copy', source: 'runtime', content: 'RUNTIME-BODY' })

  const loaded = await current.ctx.skills.get(CONTENT.slug, { cwd: current.workspace })
  expect(loaded?.content).toBe('RUNTIME-BODY')
  // The plaza's own catalog entry is untouched and still published.
  expect((await current.plaza.catalog({})).skills.map(skill => skill.slug)).toEqual([CONTENT.slug])
})

it('keeps another workspace out of reads and writes', async () => {
  const current = await mount()
  const draft = await createDraft(current)
  await current.plaza.publish({ draftId: draft.draftId, expectedRevision: 1, idempotencyKey: 'publish-scope' })

  expect((await current.plaza.drafts({ sessionId: 'other-session' as never })).drafts).toEqual([])
  expect((await current.plaza.catalog({ sessionId: 'other-session' as never })).skills).toEqual([])
  // The same workspace still sees its own records.
  expect((await current.plaza.drafts({ sessionId: 'session-here' as never })).drafts).toHaveLength(1)

  const failure = await current.plaza
    .publish({ sessionId: 'other-session' as never, draftId: draft.draftId, expectedRevision: 2, idempotencyKey: 'publish-other' })
    .catch((error: unknown) => error)
  expect(remoteErrorOf(failure)).toMatchObject({ code: 'skillPlaza/not-found', details: { id: draft.draftId } })
})

it('renders every draft field into the published body', () => {
  const body = renderSkillBody(CONTENT)
  expect(body).toContain('# Release metric comparison')
  expect(body).toContain('1. read the changelog')
  expect(body).toContain('## Failure handling')
  expect(body.endsWith('\n')).toBe(true)
})
