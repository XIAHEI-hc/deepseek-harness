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
import { skillPlazaDomain } from '../src/storage.ts'
import type { PlazaDraftContent, PlazaPresentation } from '../src/types.ts'

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
  /** The medium the plaza wrote to, for a second reader of the same data. */
  readonly backend: MemoryStorageBackend
  /** Stop the plaza service, releasing its hold on the storage unit. */
  readonly stopService: () => Promise<void>
  readonly close: () => Promise<void>
}

let bench: Bench | undefined

/**
 * Await the attempt one `generate` call started.
 *
 * `generate` answers while the attempt is still running, so a spec that asserts
 * how it settled reads the record until it stops running.
 * @param plaza - plaza service under test.
 * @param jobId - attempt started by the call.
 * @returns the settled attempt.
 */
async function waitForSettlement(plaza: SkillPlazaService, jobId: string) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { job } = await plaza.job({ jobId })
    if (job.status !== 'running' && job.status !== 'queued') return job
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(`attempt ${jobId} did not settle`)
}

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
    backend,
    stopService: async () => {
      await fiber.dispose()
    },
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

it('rejects structural presentation content it cannot store', async () => {
  const current = await mount()
  const failure = await current.plaza
    .saveDraft({
      content: {
        ...CONTENT,
        presentation: { schemaVersion: 1, examples: [{ assetId: '', title: 'x' } as never] },
      },
    })
    .catch((error: unknown) => error)

  expect(remoteErrorOf(failure)).toMatchObject({ code: 'skillPlaza/invalid', details: { reason: 'presentation' } })
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
  expect((await current.plaza.catalog({})).skills).toEqual([{
    ...published.skill,
    flow: { labels: ['read the cha…', 'tabulate bot…', 'compute delt…'], decisions: 0, nodes: 3 },
  }])
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
  const started = await current.plaza.generate({
    sessionId: 'missing-session' as never,
    turnId: 'turn-1',
    idempotencyKey: 'generate-1',
  }, new AbortController().signal)
  expect(started.job).toMatchObject({ status: 'running', attempt: 1 })

  const settled = await waitForSettlement(current.plaza, started.job.jobId)
  expect(settled).toMatchObject({ status: 'failed', attempt: 1 })
  expect(settled.error).toContain('not live')
  expect((await current.plaza.job({ jobId: settled.jobId })).job).toEqual(settled)
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

/** One 2x1 PNG with a valid IHDR header. */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00,
])

/** Presentation content over one stored image, two branches, and a subflow. */
function presentationOf(assetId: string): PlazaPresentation {
  return {
    schemaVersion: 1,
    category: 'data analysis',
    scenarios: ['locate anomalous dies in a batch'],
    examplePrompt: 'analyse this batch',
    coverAssetId: assetId,
    examples: [{ assetId, title: 'Wafer map', alt: 'a wafer map', caption: 'sample data' }],
    workflow: {
      rootLayerId: 'flow',
      layers: [
        {
          id: 'flow',
          entryNodeId: 'read',
          nodes: [
            { id: 'read', type: 'action', title: 'Read STDF' },
            {
              id: 'validate',
              type: 'decision',
              title: 'Validate file',
              inputs: ['STDF file'],
              checks: ['record format'],
              verification: 'the record parses',
              failureHandling: 'ask for a new upload',
              subflowLayerId: 'detail',
            },
            { id: 'apply', type: 'action', title: 'Apply rules', assetIds: [assetId] },
            { id: 'reupload', type: 'action', title: 'Ask for a new upload' },
          ],
          edges: [
            { from: 'read', to: 'validate' },
            { from: 'validate', to: 'apply', label: 'pass' },
            { from: 'validate', to: 'reupload', label: 'fail' },
          ],
        },
        {
          id: 'detail',
          entryNodeId: 'check-format',
          nodes: [{ id: 'check-format', type: 'action', title: 'Check record format' }],
          edges: [],
        },
      ],
    },
  }
}

/** Upload one PNG into the current workspace and return its asset identity. */
async function uploadPng(current: Bench): Promise<string> {
  const uploaded = await current.plaza.uploadMedia({
    name: 'wafer.png',
    data: PNG_BYTES.toString('base64'),
  })
  return uploaded.asset.assetId
}

it('stores result media with its detected format and reads it back', async () => {
  const current = await mount()
  const uploaded = await current.plaza.uploadMedia({ name: 'wafer.png', data: PNG_BYTES.toString('base64') })
  expect(uploaded.asset).toMatchObject({ mimeType: 'image/png', width: 2, height: 1, byteLength: PNG_BYTES.byteLength })

  const read = await current.plaza.readMedia({ assetId: uploaded.asset.assetId })
  expect(read.data).toBe(PNG_BYTES.toString('base64'))
  expect(read.asset).toEqual(uploaded.asset)
})

it('refuses a non-image upload, a non-base64 body, and an oversized one', async () => {
  const current = await mount()
  const notImage = await current.plaza
    .uploadMedia({ name: 'notes.png', data: Buffer.from('plain text').toString('base64') })
    .catch((error: unknown) => error)
  expect(remoteErrorOf(notImage)).toMatchObject({ code: 'skillPlaza/unsupported-media' })

  const notBase64 = await current.plaza
    .uploadMedia({ name: 'x.png', data: 'not base64!' })
    .catch((error: unknown) => error)
  expect(remoteErrorOf(notBase64)).toMatchObject({ code: 'skillPlaza/unsupported-media', details: { reason: 'encoding' } })

  const oversized = Buffer.concat([PNG_BYTES, Buffer.alloc(10 * 1024 * 1024)])
  const tooLarge = await current.plaza
    .uploadMedia({ name: 'huge.png', data: oversized.toString('base64') })
    .catch((error: unknown) => error)
  expect(remoteErrorOf(tooLarge)).toMatchObject({ code: 'skillPlaza/too-large' })
})

it('keeps media inside the workspace that uploaded it', async () => {
  const current = await mount()
  const assetId = await uploadPng(current)
  const elsewhere = await current.plaza
    .readMedia({ sessionId: 'other-session' as never, assetId })
    .catch((error: unknown) => error)
  expect(remoteErrorOf(elsewhere)).toMatchObject({ code: 'skillPlaza/not-found', details: { id: assetId } })
})

it('round-trips presentation content through save, publish, and detail', async () => {
  const current = await mount()
  const assetId = await uploadPng(current)
  const draft = await createDraft(current, { ...CONTENT, presentation: presentationOf(assetId) })
  expect(draft.presentation?.category).toBe('data analysis')
  expect(draft.presentation?.workflow?.layers).toHaveLength(2)

  const published = await current.plaza.publish({ draftId: draft.draftId, expectedRevision: 1, idempotencyKey: 'publish-p' })
  expect(published.skill.category).toBe('data analysis')
  expect(published.skill.coverAssetId).toBe(assetId)

  const detail = await current.plaza.detail({ skillId: published.skill.skillId, version: 1 })
  expect(detail.content.presentation?.workflow?.rootLayerId).toBe('flow')
  expect(detail.content.presentation?.examples?.[0]?.assetId).toBe(assetId)
  expect(detail.title).toBe(CONTENT.title)
  expect(detail.body).toBe(renderSkillBody({ ...CONTENT, presentation: presentationOf(assetId) }))
})

it('reports the located problems that block publication', async () => {
  const current = await mount()
  const presentation = presentationOf('missing-asset')
  const broken: PlazaPresentation = {
    ...presentation,
    workflow: {
      rootLayerId: 'flow',
      layers: [
        {
          id: 'flow',
          entryNodeId: 'read',
          nodes: [
            { id: 'read', type: 'action', title: 'Read STDF' },
            { id: 'read', type: 'action', title: 'Duplicate identity' },
            { id: 'decide', type: 'decision', title: 'Decide' },
          ],
          edges: [{ from: 'read', to: 'nowhere' }, { from: 'decide', to: 'read' }],
        },
        { id: 'orphan', entryNodeId: 'ghost', nodes: [{ id: 'alone', type: 'action', title: 'Alone' }], edges: [] },
      ],
    },
  }
  const draft = await createDraft(current, { ...CONTENT, presentation: broken })
  const checked = await current.plaza.check({ content: { ...CONTENT, presentation: broken } })
  const codes = checked.issues.map(issue => issue.code)
  expect(codes).toEqual(expect.arrayContaining([
    'asset-missing',
    'workflow-entry-missing',
    'node-id-duplicate',
    'edge-dangling',
    'decision-unlabeled',
    'node-unreachable',
    'layer-unreachable',
  ]))
  expect(checked.issues.every(issue => issue.path !== '')).toBe(true)

  const failure = await current.plaza
    .publish({ draftId: draft.draftId, expectedRevision: 1, idempotencyKey: 'publish-broken' })
    .catch((error: unknown) => error)
  expect(remoteErrorOf(failure)).toMatchObject({ code: 'skillPlaza/invalid' })
  expect((await current.plaza.catalog({})).skills).toEqual([])
})

it('accepts a complete presentation built only from workspace media', async () => {
  const current = await mount()
  const assetId = await uploadPng(current)
  const content = { ...CONTENT, presentation: presentationOf(assetId) }
  await expect(current.plaza.check({ content })).resolves.toEqual({ issues: [] })
  const draft = await createDraft(current, content)
  await expect(current.plaza.publish({
    draftId: draft.draftId,
    expectedRevision: 1,
    idempotencyKey: 'publish-complete',
  })).resolves.toMatchObject({ skill: { version: 1 } })
})

it('keeps an older published version intact after a newer one publishes', async () => {
  const current = await mount()
  const first = await createDraft(current)
  const v1 = await current.plaza.publish({ draftId: first.draftId, expectedRevision: 1, idempotencyKey: 'publish-v1' })
  const saved = await current.plaza.saveDraft({
    draftId: first.draftId,
    content: { ...CONTENT, title: 'Release comparison v2' },
    expectedRevision: 1,
  })
  const v2 = await current.plaza.publish({
    draftId: first.draftId,
    expectedRevision: saved.draft.revision,
    idempotencyKey: 'publish-v2',
  })
  expect(v2.skill.version).toBe(2)

  const old = await current.plaza.detail({ skillId: v1.skill.skillId, version: 1 })
  expect(old.title).toBe(CONTENT.title)
  expect(old.version).toBe(1)
  const fresh = await current.plaza.detail({ skillId: v1.skill.skillId, version: 2 })
  expect(fresh.title).toBe('Release comparison v2')
  const missing = await current.plaza
    .detail({ skillId: v1.skill.skillId, version: 9 })
    .catch((error: unknown) => error)
  expect(remoteErrorOf(missing)).toMatchObject({ code: 'skillPlaza/not-found' })
})

it('keeps another workspace out of a detail read', async () => {
  const current = await mount()
  const draft = await createDraft(current)
  const published = await current.plaza.publish({ draftId: draft.draftId, expectedRevision: 1, idempotencyKey: 'publish-iso' })
  const failure = await current.plaza
    .detail({ sessionId: 'other-session' as never, skillId: published.skill.skillId, version: 1 })
    .catch((error: unknown) => error)
  expect(remoteErrorOf(failure)).toMatchObject({ code: 'skillPlaza/not-found' })
})

it('writes the pinned version where a restarted Host still finds it', async () => {
  const current = await mount()
  const draft = await createDraft(current)
  const published = await current.plaza.publish({ draftId: draft.draftId, expectedRevision: 1, idempotencyKey: 'publish-pin' })
  await current.plaza.pin({
    sessionId: 'session-pinned' as never,
    skillId: published.skill.skillId,
    version: 1,
    slug: CONTENT.slug,
  })

  await current.stopService()
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.effect(() => ctx.storage.backend.register('reread', current.backend))
  const facility = new DomainFacility(ctx, { backend: 'reread' })
  try {
    const domain = await facility.open(skillPlazaDomain)
    const rows = [...domain.table('pins').entries()].map(([, record]) => record)
    expect(rows).toEqual([expect.objectContaining({
      sessionId: 'session-pinned',
      skillId: published.skill.skillId,
      version: 1,
      workspace: current.workspace,
    })])
  } finally {
    await facility.closeAll()
  }
})
