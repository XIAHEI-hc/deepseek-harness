/**
 * Pinned skill invocation and structured generation, driven through the real
 * `agent/pre-step` waterfall and the plaza's own storage domain.
 */
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SESSION_FORMAT_VERSION, Session, type SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, expect, it } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import SkillPlazaService, { renderSkillBody } from '../src/index.ts'
import type { PlazaDraftContent, PlazaSkillEntry } from '../src/types.ts'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'

const WORKSPACE = '/workspace/pre-step'

/** Prompt text each simulated model call received, in call order. */
const streamedPrompts: string[] = []

/** How long a spec waits for a started attempt to settle. */
const SETTLE_ATTEMPTS = 400
const SETTLE_INTERVAL_MS = 2

/**
 * Start one attempt and await the record it settles into.
 *
 * `generate` answers while the attempt is still running, so every assertion
 * about a generated draft reads the record through `job` instead.
 * @param plaza - the plaza service under test.
 * @param request - Session, turn, and idempotency key of the attempt.
 * @returns the settled attempt.
 */
async function generateSettled(
  plaza: SkillPlazaService,
  request: Parameters<SkillPlazaService['generate']>[0],
): Promise<{ job: Awaited<ReturnType<SkillPlazaService['job']>>['job'] }> {
  const started = await plaza.generate(request, new AbortController().signal)
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
    const { job } = await plaza.job({ jobId: started.job.jobId })
    if (job.status !== 'running' && job.status !== 'queued') return { job }
    await new Promise(resolve => setTimeout(resolve, SETTLE_INTERVAL_MS))
  }
  throw new Error(`attempt ${started.job.jobId} did not settle`)
}

const CONTENT: PlazaDraftContent = {
  title: 'Release metric comparison',
  slug: 'release-metrics-compare',
  description: 'Compare two release records.',
  inputs: ['changelog_path'],
  steps: ['read the changelog'],
  outputs: ['comparison table'],
  verification: 'values match the source line',
  failureHandling: 'report the discrepancy',
  toolDependencies: ['file read'],
}

/** Generated-draft payload the fake model returns. */
const GENERATED = {
  title: 'Generated method',
  slug: 'generated-method',
  description: 'A method distilled by the model.',
  inputs: ['input_a'],
  steps: ['step one', 'step two'],
  outputs: ['output_a'],
  verification: 'verify the output',
  failureHandling: 'report the failure',
  toolDependencies: ['file read'],
}

interface Bench {
  readonly ctx: Context
  readonly fiber: { readonly ctx: Context }
  readonly plaza: SkillPlazaService
  readonly agent: Agent
  readonly close: () => Promise<void>
}

/**
 * Build an Agent over a real Session carrying the claimed conversation.
 * @param messages - user texts the Session holds.
 * @param id - Session identity the pin map keys by.
 */
function fakeAgent(messages: readonly string[], id = 'session-pinned'): Agent {
  const sessionId = brandString<SessionId>(id)
  const session = Session.create(sessionId, [], {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 0,
    cwd: WORKSPACE,
    isSeeded: false,
  })
  for (const text of messages) {
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  }
  return {
    ctx: new Context(),
    id: sessionId,
    options: {},
    session,
    model: unsupportedModel(),
    inbox: unsupportedInbox(),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('the plaza never injects into the inbox') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/**
 * Mount the plaza over fake agent/working-directory/llm faces and real storage.
 * @param options - messages the fake Session holds and the model reply to stream.
 */
async function mount(options: {
  messages?: readonly string[]
  reply?: string
  defaultSelection?: { provider: string; model: string } | undefined
  failure?: string
  finishError?: string
  replies?: readonly string[]
  /** Keep the model call open until the attempt is aborted, for cancellation specs. */
  stall?: boolean
} = {}): Promise<Bench> {
  const ctx = new Context()
  const agent = fakeAgent(options.messages ?? ['/release-metrics-compare compare two releases'])
  ctx.provide('agents', { get: (id: string) => id === agent.id ? agent : undefined } as never)
  ctx.provide('workingDirectory', { defaultDirectory: WORKSPACE, ensure: async () => WORKSPACE } as never)
  ctx.provide('sessionQuery', {
    observeSession: async (sessionId: string) => {
      if (sessionId.startsWith('cold-')) {
        throw new SessionQueryError('session query: missing', 'SESSION_QUERY_SESSION_NOT_FOUND')
      }
      if (sessionId.startsWith('broken-')) throw new Error('projection unavailable')
      return {
        header: { cwd: sessionId.startsWith('other-') ? '/workspace/other' : WORKSPACE },
        projections: undefined,
        [Symbol.dispose]() {},
      }
    },
  } as never)
  const replies = options.replies ?? [options.reply ?? JSON.stringify(GENERATED)]
  let replyIndex = 0
  const selection = 'defaultSelection' in options ? options.defaultSelection : { provider: 'mock', model: 'mock' }
  ctx.provide('agentDefaultModel', { currentSelection: () => selection } as never)
  ctx.provide('llm', {
    stream: async function* (request: {
      messages?: readonly { content?: readonly { type?: string; text?: string }[] }[]
      signal?: AbortSignal
    }) {
      streamedPrompts.push((request.messages ?? [])
        .flatMap(message => message.content ?? [])
        .map(block => block.text ?? '')
        .join('\n'))
      if (options.failure !== undefined) throw options.failure
      if (options.stall === true) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: '{"title":"half a dra' }
        await aborted(request.signal)
        throw new Error('the model call was aborted')
      }
      const reply = replies[Math.min(replyIndex, replies.length - 1)] ?? ''
      replyIndex += 1
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      if (options.finishError !== undefined) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: options.finishError } } }
        return
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    listProviders: () => [],
    listModels: async () => [],
  } as never)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
  const fiber = await ctx.plugin(SkillPlazaService)
  const bench: Bench = {
    ctx,
    fiber,
    plaza: ctx.skillPlaza,
    agent,
    close: async () => {
      await fiber.dispose()
      await facility.closeAll()
      await backend.close()
    },
  }
  mounted = bench
  return bench
}

let mounted: Bench | undefined

/** Resolve when the signal aborts, including when it already has. */
function aborted(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return new Promise(() => {})
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
}

afterEach(async () => {
  await mounted?.close()
  mounted = undefined
})

/** Save and publish the sample draft, returning its catalog entry. */
async function publishSample(bench: Bench): Promise<PlazaSkillEntry> {
  const saved = await bench.plaza.saveDraft({ content: CONTENT })
  const published = await bench.plaza.publish({
    draftId: saved.draft.draftId,
    expectedRevision: saved.draft.revision,
    idempotencyKey: 'publish-sample',
  })
  return published.skill
}

/** Build one claimed user message. */
function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** The injection the shipped `/slug` boundary would have produced. */
function activeInjection(slug: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: 'ACTIVE-VERSION-BODY' }],
    source: { kind: 'skill-invocation', name: slug, form: 'instructions' },
  })
}

/** Drive the pre-step waterfall with one claimed message and a simulated inner decision. */
async function step(bench: Bench, messages: UserMessage[], inner: UserMessage[]): Promise<PreStepDecision> {
  return await agentEvents(bench.ctx, bench.agent).waterfall(
    'agent/pre-step',
    {
      modelSelection: { provider: 'mock', model: 'mock' },
      messages,
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    },
    () => Promise.resolve({ kind: 'enter' as const, messages: inner }),
  )
}

/** Text of the injected skill body in one decision. */
function injectedText(decision: PreStepDecision): string {
  if (decision.kind !== 'enter') return ''
  return decision.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n')
}

it('replaces the active-version injection with the pinned version', async () => {
  const bench = await mount()
  const skill = await publishSample(bench)
  await bench.plaza.pin({ sessionId: 'session-pinned' as never, skillId: skill.skillId, version: skill.version, slug: skill.slug })

  const claimed = userMessage('/release-metrics-compare compare two releases')
  const decision = await step(bench, [claimed], [claimed, activeInjection(skill.slug)])

  expect(decision.kind).toBe('enter')
  const injections = decision.kind === 'enter'
    ? decision.messages.filter(message => message.source.kind === 'skill-invocation')
    : []
  expect(injections).toHaveLength(1)
  expect(injections[0]?.source).toMatchObject({
    kind: 'skill-invocation',
    name: skill.slug,
    version: skill.version,
    provider: 'skill-plaza',
  })
  expect(injectedText(decision)).toContain(renderSkillBody(CONTENT).split('\n')[0] ?? '')
  expect(injectedText(decision)).not.toContain('ACTIVE-VERSION-BODY')
})

it('leaves the step alone when the claimed message names no pinned skill', async () => {
  const bench = await mount({ messages: ['compare two releases without a skill'] })
  const skill = await publishSample(bench)
  await bench.plaza.pin({ sessionId: 'session-pinned' as never, skillId: skill.skillId, version: skill.version, slug: skill.slug })

  const claimed = userMessage('compare two releases without a skill')
  const decision = await step(bench, [claimed], [claimed])

  expect(decision.kind).toBe('enter')
  expect(decision.kind === 'enter' ? decision.messages : []).toEqual([claimed])
})

it('leaves the step alone when nothing is pinned', async () => {
  const bench = await mount()
  await publishSample(bench)
  const claimed = userMessage('/release-metrics-compare compare')
  const decision = await step(bench, [claimed], [claimed])
  expect(decision.kind === 'enter' ? decision.messages : []).toEqual([claimed])
})

it('distills a draft from the claimed conversation when the model answers with JSON', async () => {
  const bench = await mount({ messages: ['read the release file and compare two entries'] })
  const generated = await generateSettled(bench.plaza, {
    sessionId: bench.agent.id,
    turnId: 'turn-1',
    idempotencyKey: 'generate-success',
  })

  expect(generated.job).toMatchObject({ status: 'succeeded', attempt: 1 })
  const draftId = generated.job.draftId ?? ''
  const drafts = (await bench.plaza.drafts({})).drafts
  const draft = drafts.find(row => row.draftId === draftId)
  expect(draft).toMatchObject({ title: GENERATED.title, slug: GENERATED.slug, revision: 1 })
  expect(draft?.source).toMatchObject({ sessionId: bench.agent.id })
})

it('joins a second identical request to the attempt already running', async () => {
  const bench = await mount()
  const request = {
    sessionId: bench.agent.id as never,
    turnId: 'turn-concurrent',
    idempotencyKey: 'generate-concurrent',
  }
  const [first, second] = await Promise.all([
    generateSettled(bench.plaza, request),
    generateSettled(bench.plaza, request),
  ])

  expect(first.job.jobId).toBe(second.job.jobId)
  expect(first.job.status).toBe('succeeded')
  const drafts = (await bench.plaza.drafts({})).drafts
  expect(drafts).toHaveLength(1)
})

it('bounds the distilled material at the reply the entry belongs to', async () => {
  const bench = await mount({ messages: ['EARLY-TURN material', 'LATER-TURN material'] })
  const early = bench.agent.session.deriveMessages()[0]
  const generated = await generateSettled(bench.plaza, {
    sessionId: bench.agent.id,
    turnId: early?.id ?? '',
    idempotencyKey: 'generate-bounded',
  })

  expect(generated.job.status).toBe('succeeded')
  expect(streamedPrompts.at(-1)).toContain('EARLY-TURN')
  expect(streamedPrompts.at(-1)).not.toContain('LATER-TURN')
})

it('retries a failed attempt on the next identical request', async () => {
  const bench = await mount({ reply: 'not a json object at all' })
  const request = {
    sessionId: bench.agent.id as never,
    turnId: 'turn-retry',
    idempotencyKey: 'generate-retry',
  }
  const first = await generateSettled(bench.plaza, request)
  expect(first.job).toMatchObject({ status: 'failed', attempt: 1 })
  await bench.close()
  mounted = undefined

  const retried = await mount({ replies: ['still not json', JSON.stringify(GENERATED)] })
  const second = await generateSettled(retried.plaza, {
    sessionId: retried.agent.id,
    turnId: 'turn-retry',
    idempotencyKey: 'generate-retry',
  })
  expect(second.job.status).toBe('succeeded')
  expect(second.job.attempt).toBe(1)
})

it('increments the attempt when the same job is retried', async () => {
  const bench = await mount({ reply: 'not a json object at all' })
  const request = {
    sessionId: bench.agent.id as never,
    turnId: 'turn-retry-same-store',
    idempotencyKey: 'generate-retry-same-store',
  }
  const first = await generateSettled(bench.plaza, request)
  expect(first.job).toMatchObject({ status: 'failed', attempt: 1 })
  const second = await generateSettled(bench.plaza, request)
  expect(second.job).toMatchObject({ jobId: first.job.jobId, status: 'failed', attempt: 2 })
})

it('repairs one non-JSON reply instead of failing the attempt', async () => {
  const bench = await mount({ replies: ['Sure! Here is the method you asked about.', JSON.stringify(GENERATED)] })
  const generated = await generateSettled(bench.plaza, {
    sessionId: bench.agent.id,
    turnId: 'turn-repair',
    idempotencyKey: 'generate-repair',
  })
  expect(generated.job.status).toBe('succeeded')
  const drafts = (await bench.plaza.drafts({})).drafts
  expect(drafts[0]).toMatchObject({ slug: GENERATED.slug })
})

it('records a model reply that is not a draft payload as a failure', async () => {
  const bench = await mount({ reply: 'I cannot produce JSON right now.' })
  const generated = await generateSettled(bench.plaza, {
    sessionId: bench.agent.id,
    turnId: 'turn-2',
    idempotencyKey: 'generate-invalid',
  })

  expect(generated.job.status).toBe('failed')
  expect(generated.job.error).toContain('without a JSON object')
})

it('reports a model route that does not exist', async () => {
  const bench = await mount({ defaultSelection: undefined })
  const generated = await generateSettled(bench.plaza, {
    sessionId: bench.agent.id,
    turnId: 'turn-3',
    idempotencyKey: 'generate-no-route',
  })
  expect(generated.job.status).toBe('failed')
  expect(generated.job.error).toContain('no model route')
})

it('renders a body without the optional sections', async () => {
  const body = renderSkillBody({
    ...CONTENT,
    inputs: [],
    steps: [],
    outputs: [],
    verification: '',
    failureHandling: '',
    toolDependencies: [],
  })
  expect(body).toBe(`# ${CONTENT.title}\n\n${CONTENT.description}\n`)
})

it('sorts the catalog and the draft list', async () => {
  const bench = await mount()
  const first = await bench.plaza.saveDraft({ content: CONTENT })
  await bench.plaza.publish({ draftId: first.draft.draftId, expectedRevision: 1, idempotencyKey: 'publish-a' })
  const second = await bench.plaza.saveDraft({ content: { ...CONTENT, slug: 'aaa-first', title: 'AAA' } })
  await bench.plaza.publish({ draftId: second.draft.draftId, expectedRevision: 1, idempotencyKey: 'publish-b' })

  const catalog = (await bench.plaza.catalog({})).skills.map(skill => skill.slug)
  expect(catalog).toEqual(['aaa-first', 'release-metrics-compare'])
  expect((await bench.plaza.drafts({})).drafts).toHaveLength(2)
})

it('reports unknown draft identities on save, publish, and job reads', async () => {
  const bench = await mount()
  const save = await bench.plaza.saveDraft({
    draftId: 'draft-missing',
    content: CONTENT,
    expectedRevision: 1,
  }).catch((error: unknown) => error)
  expect(remoteErrorOf(save)).toMatchObject({ code: 'skillPlaza/not-found' })

  const publish = await bench.plaza.publish({
    draftId: 'draft-missing',
    expectedRevision: 1,
    idempotencyKey: 'publish-missing',
  }).catch((error: unknown) => error)
  expect(remoteErrorOf(publish)).toMatchObject({ code: 'skillPlaza/not-found' })

  const job = await bench.plaza.job({ jobId: 'job-missing' }).catch((error: unknown) => error)
  expect(remoteErrorOf(job)).toMatchObject({ code: 'skillPlaza/not-found' })
})

it('refuses a save and a publish from another workspace', async () => {
  const bench = await mount()
  const draft = await bench.plaza.saveDraft({ content: CONTENT })
  const save = await bench.plaza.saveDraft({
    sessionId: 'other-session' as never,
    draftId: draft.draft.draftId,
    content: CONTENT,
    expectedRevision: 1,
  }).catch((error: unknown) => error)
  expect(remoteErrorOf(save)).toMatchObject({ code: 'skillPlaza/not-found' })

  const publish = await bench.plaza.publish({
    sessionId: 'other-session' as never,
    draftId: draft.draft.draftId,
    expectedRevision: 1,
    idempotencyKey: 'publish-other-workspace',
  }).catch((error: unknown) => error)
  expect(remoteErrorOf(publish)).toMatchObject({ code: 'skillPlaza/not-found' })
})

it('publishes a second version without re-claiming the skill identity', async () => {
  const bench = await mount()
  const skill = await publishSample(bench)
  const existingDraftId = (await bench.plaza.drafts({})).drafts[0]?.draftId ?? ''
  const saved = await bench.plaza.saveDraft({
    draftId: existingDraftId,
    content: { ...CONTENT, title: 'Second title' },
    expectedRevision: 1,
  })
  const republished = await bench.plaza.publish({
    draftId: saved.draft.draftId,
    expectedRevision: saved.draft.revision,
    idempotencyKey: 'publish-second-version',
  })
  expect(republished.skill).toMatchObject({ skillId: skill.skillId, version: 2 })
})

it('returns the stored attempt for a sequential repeat request', async () => {
  const bench = await mount()
  const request = {
    sessionId: bench.agent.id as never,
    turnId: 'turn-repeat',
    idempotencyKey: 'generate-repeat',
  }
  const first = await generateSettled(bench.plaza, request)
  const second = await generateSettled(bench.plaza, request)
  expect(second.job.jobId).toBe(first.job.jobId)
  expect((await bench.plaza.drafts({})).drafts).toHaveLength(1)
})

it('lists nothing for a lookup without a workspace', async () => {
  const bench = await mount()
  await publishSample(bench)
  expect(await bench.ctx.skills.list({})).toEqual([])
})

it('maps a missing stored Session to the not-found code', async () => {
  const bench = await mount()
  const failure = await bench.plaza.drafts({ sessionId: 'cold-session' as never }).catch((error: unknown) => error)
  expect(remoteErrorOf(failure)).toMatchObject({ code: 'skillPlaza/not-found' })
})

it('reports a Session inspection failure as an internal error', async () => {
  const bench = await mount()
  const failure = await bench.plaza.drafts({ sessionId: 'broken-session' as never }).catch((error: unknown) => error)
  expect(remoteErrorOf(failure)).toMatchObject({ code: 'gateway/internal' })
})

it('reports that a Session cannot be inspected without the query service', async () => {
  const ctx = new Context()
  const agent = fakeAgent(['nothing claimed'])
  ctx.provide('agents', { get: () => undefined } as never)
  ctx.provide('workingDirectory', { defaultDirectory: WORKSPACE, ensure: async () => WORKSPACE } as never)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) } as never)
  ctx.provide('llm', { stream: async function* () {}, listProviders: () => [], listModels: async () => [] } as never)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(SkillPlazaService)
  const failure = await ctx.skillPlaza.drafts({ sessionId: agent.id }).catch((error: unknown) => error)
  expect(remoteErrorOf(failure)).toMatchObject({ code: 'gateway/internal' })
  await fiber.dispose()
  await facility.closeAll()
  await backend.close()
})

it('passes a rejecting inner decision through untouched', async () => {
  const bench = await mount()
  const decision = await agentEvents(bench.ctx, bench.agent).waterfall(
    'agent/pre-step',
    {
      modelSelection: { provider: 'mock', model: 'mock' },
      messages: [],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    },
    () => Promise.resolve({ kind: 'reject' as const }),
  )
  expect(decision).toEqual({ kind: 'reject' })
})

it('reports a failed model call as a failed attempt', async () => {
  const bench = await mount({ finishError: 'PROVIDER_UNAVAILABLE' })
  const generated = await generateSettled(bench.plaza, {
    sessionId: bench.agent.id,
    turnId: 'turn-finish-error',
    idempotencyKey: 'generate-finish-error',
  })
  expect(generated.job.status).toBe('failed')
  expect(generated.job.error).toContain('the model call failed')
})

it('reports a non-Error model failure as text', async () => {
  const bench = await mount({ failure: 'stream exploded' })
  const generated = await generateSettled(bench.plaza, {
    sessionId: bench.agent.id,
    turnId: 'turn-throw',
    idempotencyKey: 'generate-throw',
  })
  expect(generated.job.status).toBe('failed')
  expect(generated.job.error).toContain('stream exploded')
})

it('reports invalid JSON and an incomplete payload separately', async () => {
  const invalid = await mount({ reply: '{not json}' })
  const first = await generateSettled(invalid.plaza, {
    sessionId: invalid.agent.id,
    turnId: 'turn-invalid-json',
    idempotencyKey: 'generate-invalid-json',
  })
  expect(first.job.error).toContain('invalid JSON')
  await invalid.close()
  mounted = undefined

  const incomplete = await mount({ reply: '{"title":"only a title"}' })
  const second = await generateSettled(incomplete.plaza, {
    sessionId: incomplete.agent.id,
    turnId: 'turn-incomplete',
    idempotencyKey: 'generate-incomplete',
  })
  expect(second.job.error).toContain('incomplete')
})

it('refuses to generate from a Session holding no material', async () => {
  const bench = await mount({ messages: [] })
  const generated = await generateSettled(bench.plaza, {
    sessionId: bench.agent.id,
    turnId: 'turn-empty',
    idempotencyKey: 'generate-empty',
  })
  expect(generated.job).toMatchObject({ status: 'failed' })
  expect(generated.job.error).toContain('no completed reply')
})

it('falls back to the first advertised model route', async () => {
  const ctx = new Context()
  const agent = fakeAgent(['material to distill'])
  ctx.provide('agents', { get: () => agent } as never)
  ctx.provide('workingDirectory', { defaultDirectory: WORKSPACE, ensure: async () => WORKSPACE } as never)
  ctx.provide('sessionQuery', {
    observeSession: async () => ({ header: { cwd: WORKSPACE }, projections: undefined, [Symbol.dispose]() {} }),
  } as never)
  ctx.provide('agentDefaultModel', { currentSelection: () => undefined } as never)
  ctx.provide('llm', {
    stream: async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: JSON.stringify(GENERATED) }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(GENERATED) } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    listProviders: () => [{ id: 'route-one', name: 'Route one' }, { id: 'route-two', name: 'Route two' }],
    listModels: async (provider: string) => provider === 'route-one' ? [] : [{ id: 'model-two', name: 'Model two' }],
  } as never)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(SkillPlazaService)
  const generated = await generateSettled(ctx.skillPlaza, {
    sessionId: agent.id,
    turnId: 'turn-fallback',
    idempotencyKey: 'generate-fallback',
  })
  expect(generated.job.status).toBe('succeeded')
  await fiber.dispose()
  await facility.closeAll()
  await backend.close()
})

it('reads the working directory from the projection when the header has none', async () => {
  const ctx = new Context()
  const agent = fakeAgent(['material'])
  ctx.provide('agents', { get: () => undefined } as never)
  ctx.provide('workingDirectory', { defaultDirectory: '/fallback/dir', ensure: async () => WORKSPACE } as never)
  ctx.provide('sessionQuery', {
    observeSession: async () => ({
      header: {},
      projections: { values: { workingDirectory: WORKSPACE } },
      [Symbol.dispose]() {},
    }),
  } as never)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) } as never)
  ctx.provide('llm', { stream: async function* () {}, listProviders: () => [], listModels: async () => [] } as never)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(SkillPlazaService)
  const saved = await ctx.skillPlaza.saveDraft({ sessionId: agent.id, content: CONTENT })
  expect(saved.draft.slug).toBe(CONTENT.slug)
  await fiber.dispose()
  await facility.closeAll()
  await backend.close()
})

it('falls back to the host default directory when the Session reports none', async () => {
  const ctx = new Context()
  const agent = fakeAgent(['material'])
  ctx.provide('agents', { get: () => undefined } as never)
  ctx.provide('workingDirectory', { defaultDirectory: '/fallback/dir', ensure: async () => WORKSPACE } as never)
  ctx.provide('sessionQuery', {
    observeSession: async () => ({ header: {}, projections: undefined, [Symbol.dispose]() {} }),
  } as never)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) } as never)
  ctx.provide('llm', { stream: async function* () {}, listProviders: () => [], listModels: async () => [] } as never)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(SkillPlazaService)
  await ctx.skillPlaza.saveDraft({ sessionId: agent.id, content: CONTENT })
  expect((await ctx.skillPlaza.drafts({})).drafts).toHaveLength(1)
  await fiber.dispose()
  await facility.closeAll()
  await backend.close()
})

it('skips a provider whose model listing fails', async () => {
  const ctx = new Context()
  const agent = fakeAgent(['material to distill'])
  ctx.provide('agents', { get: () => agent } as never)
  ctx.provide('workingDirectory', { defaultDirectory: WORKSPACE, ensure: async () => WORKSPACE } as never)
  ctx.provide('sessionQuery', {
    observeSession: async () => ({ header: { cwd: WORKSPACE }, projections: undefined, [Symbol.dispose]() {} }),
  } as never)
  ctx.provide('agentDefaultModel', { currentSelection: () => undefined } as never)
  ctx.provide('llm', {
    stream: async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: JSON.stringify(GENERATED) }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(GENERATED) } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    listProviders: () => [{ id: 'broken-route', name: 'Broken route' }, { id: 'good-route', name: 'Good route' }],
    listModels: async (provider: string) => {
      if (provider === 'broken-route') throw new Error('listing failed')
      return [{ id: 'model-good', name: 'Model good' }]
    },
  } as never)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(SkillPlazaService)
  const generated = await generateSettled(ctx.skillPlaza, {
    sessionId: agent.id,
    turnId: 'turn-skip-provider',
    idempotencyKey: 'generate-skip-provider',
  })
  expect(generated.job.status).toBe('succeeded')
  await fiber.dispose()
  await facility.closeAll()
  await backend.close()
})

it('contains a throwing change listener', async () => {
  const bench = await mount()
  const onEvent = bench.fiber.ctx.on as (event: string, listener: () => void) => unknown
  onEvent('skill-plaza/changed', () => { throw new Error('listener boom') })
  await bench.plaza.saveDraft({ content: CONTENT })
  expect((await bench.plaza.drafts({})).drafts).toHaveLength(1)
})
it('throws the not-found code when pinning an unknown skill', async () => {
  const bench = await mount()
  const failure = await bench.plaza.pin({
    sessionId: 'session-pinned' as never,
    skillId: 'skill-missing',
    version: 1,
    slug: 'missing',
  }).catch((error: unknown) => error)
  expect(remoteErrorOf(failure)).toMatchObject({ code: 'skillPlaza/not-found' })
})

it('reports a workspace mismatch as not-found instead of leaking a record', async () => {
  const bench = await mount()
  const skill = await publishSample(bench)
  const failure = await bench.plaza.pin({
    sessionId: 'other-session' as never,
    skillId: skill.skillId,
    version: skill.version,
    slug: skill.slug,
  }).catch((error: unknown) => error)
  expect(remoteErrorOf(failure)).toMatchObject({ code: 'skillPlaza/not-found' })
})

it('cancels a running attempt and records it as cancelled', async () => {
  const bench = await mount({ stall: true })
  const started = await bench.plaza.generate({
    sessionId: bench.agent.id,
    turnId: 'turn-4',
    idempotencyKey: 'generate-aborted',
  }, new AbortController().signal)
  expect(started.job.status).toBe('running')

  const cancelled = await bench.plaza.cancel({ jobId: started.job.jobId })
  expect(cancelled.job).toMatchObject({ status: 'cancelled', attempt: 1 })
  expect(cancelled.job.stage).toBeUndefined()
  expect((await bench.plaza.drafts({})).drafts).toEqual([])
})

it('reports the stage and characters of a running attempt', async () => {
  const bench = await mount({ stall: true })
  const started = await bench.plaza.generate({
    sessionId: bench.agent.id,
    turnId: 'turn-progress',
    idempotencyKey: 'generate-progress',
  }, new AbortController().signal)

  let running = started.job
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS && (running.chars ?? 0) === 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, SETTLE_INTERVAL_MS))
    running = (await bench.plaza.job({ jobId: started.job.jobId })).job
  }
  expect(running).toMatchObject({ status: 'running', stage: 'distill' })
  expect(running.chars).toBeGreaterThan(0)
  await bench.plaza.cancel({ jobId: started.job.jobId })
})

it('leaves a settled attempt untouched when a cancellation arrives late', async () => {
  const bench = await mount()
  const generated = await generateSettled(bench.plaza, {
    sessionId: bench.agent.id,
    turnId: 'turn-late-cancel',
    idempotencyKey: 'generate-late-cancel',
  })
  const late = await bench.plaza.cancel({ jobId: generated.job.jobId })
  expect(late.job.status).toBe('succeeded')
})

it('reports an unknown attempt identity when cancelling', async () => {
  const bench = await mount()
  const failure = await bench.plaza.cancel({ jobId: 'job-missing' }).catch((error: unknown) => error)
  expect(remoteErrorOf(failure)).toMatchObject({ code: 'skillPlaza/not-found' })
})

it('refuses a second draft that reuses the callable name after publication', async () => {
  const bench = await mount()
  await publishSample(bench)
  const second = await bench.plaza.saveDraft({ content: { ...CONTENT, title: 'Second' } })
  const failure = await bench.plaza.publish({
    draftId: second.draft.draftId,
    expectedRevision: second.draft.revision,
    idempotencyKey: 'publish-second',
  }).catch((error: unknown) => error)
  expect(remoteErrorOf(failure)).toMatchObject({ code: 'skillPlaza/name-conflict' })
})
