/**
 * Skills plaza Host service: durable drafts, immutable published versions, and
 * the workspace-scoped skill provider the agent reads them through.
 *
 * Drafts and versions live in the `skill_plaza` storage domain. Published
 * skills are served by a provider registered on the `ctx.skills` registry, so
 * the model catalog, the `/slug` user gesture, and the composer picker all read
 * the same published bodies. Nothing here resolves a name at load time: the
 * provider's `get` receives the version locator its `list` produced.
 *
 * @module @deepseek-ai/dsh-skill-plaza
 */

import { randomUUID } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-working-directory'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import type { SkillCandidate, SkillDefinition, SkillInvocationPolicy, SkillProvider } from '@deepseek-ai/dsh-skill'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { plazaContentSchema, skillPlazaDomain } from './storage.ts'
import type { PlazaContent, PlazaDraftRecord, PlazaJobRecord, PlazaSkillRecord, PlazaVersionRecord } from './storage.ts'
import type {
  PlazaCatalogValue, PlazaDraftContent, PlazaDraftView, PlazaDraftsValue,
  PlazaGenerateRequest, PlazaGenerateValue, PlazaJobRequest, PlazaJobValue, PlazaJobView,
  PlazaPinRequest, PlazaPinValue, PlazaPublishRequest, PlazaPublishValue, PlazaSaveDraftRequest, PlazaSaveDraftValue, PlazaSessionRequest,
  PlazaSkillEntry,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable skill drafts and published versions behind the Skills plaza. */
    skillPlaza: SkillPlazaService
  }
}

/** Provider name under which plaza skills enter the merged skill catalog. */
export const PLAZA_PROVIDER = 'skill-plaza'

/** Precedence rank: below runtime registrations, above bundled and local files. */
export const PLAZA_SKILL_RANK = 400

/** Invocation controls every published plaza skill carries. */
const PLAZA_INVOCATION: SkillInvocationPolicy = { modelInvocable: true, userInvocable: true }

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_HARVEST_CHARS = 8_000
const MAX_HARVEST_MESSAGES = 6

/** Wire-safe copy of a stored draft. */
function toDraftView(record: PlazaDraftRecord): PlazaDraftView {
  return {
    draftId: record.draftId,
    ...record.skillId === undefined ? {} : { skillId: record.skillId },
    revision: record.revision,
    updatedAt: record.updatedAt,
    title: record.title,
    slug: record.slug,
    description: record.description,
    inputs: [...record.inputs],
    steps: [...record.steps],
    outputs: [...record.outputs],
    verification: record.verification,
    failureHandling: record.failureHandling,
    toolDependencies: [...record.toolDependencies],
    ...record.source === undefined ? {} : { source: { ...record.source } },
  }
}

/** Wire-safe copy of a stored catalog row. */
function toSkillEntry(record: PlazaSkillRecord): PlazaSkillEntry {
  return {
    skillId: record.skillId,
    slug: record.slug,
    title: record.title,
    description: record.description,
    version: record.activeVersion,
    updatedAt: record.updatedAt,
  }
}

/** Wire-safe copy of a stored generation attempt. */
function toJobView(record: PlazaJobRecord): PlazaJobView {
  return {
    jobId: record.jobId,
    status: record.status,
    attempt: record.attempt,
    updatedAt: record.updatedAt,
    ...record.draftId === undefined ? {} : { draftId: record.draftId },
    ...record.error === undefined ? {} : { error: record.error },
  }
}

/** Normalize one workspace directory into the plaza's storage key. */
function workspaceKey(directory: string): string {
  return resolvePath(directory)
}

/**
 * Render a stored draft as the markdown body a skill provider serves.
 * @param content - validated draft content.
 * @returns the complete skill body, newest section last.
 */
export function renderSkillBody(content: PlazaDraftContent): string {
  const section = (heading: string, lines: readonly string[]): string[] => lines.length === 0
    ? []
    : [`## ${heading}`, ...lines, '']
  return [
    `# ${content.title}`,
    '',
    content.description,
    '',
    ...section('Inputs', content.inputs.map(input => `- ${input}`)),
    ...section('Steps', content.steps.map((step, index) => `${index + 1}. ${step}`)),
    ...section('Expected outputs', content.outputs.map(output => `- ${output}`)),
    ...section('Verification', content.verification === '' ? [] : [content.verification]),
    ...section('Failure handling', content.failureHandling === '' ? [] : [content.failureHandling]),
    ...section('Tool dependencies', content.toolDependencies.map(tool => `- \`${tool}\``)),
  ].join('\n').trimEnd() + '\n'
}

/** Reject content the plaza cannot store or serve. */
function validateContent(content: PlazaDraftContent): void {
  if (!SLUG_PATTERN.test(content.slug)) {
    throw new RemoteError(
      'skillPlaza/invalid',
      `"${content.slug}" is not a valid kebab-case skill name`,
      { reason: 'slug' },
    )
  }
}

/** Fail with the plaza's not-found code. */
function notFound(id: string): never {
  throw new RemoteError('skillPlaza/not-found', `no plaza record "${id}"`, { id })
}

/**
 * Host owner of the Skills plaza: drafts, published versions, the catalog, and
 * the generation attempts that distill a completed turn into a draft.
 */
export class SkillPlazaService extends TypertRemoteService {
  static inject = ['agents', 'llm', 'skills', 'storageDomain', 'workingDirectory']

  private domainReady: Promise<Domain<typeof skillPlazaDomain>> | undefined
  private invalidateProvider: (() => void) | undefined
  /** Versions the composer pinned for a Session's next explicit invocation. */
  private readonly pins = new Map<string, { skillId: string; version: number; slug: string }>()
  /** Generation attempts in flight, keyed by workspace and idempotency key. */
  private readonly generating = new Map<string, Promise<PlazaJobRecord>>()

  /** @param ctx - Host context carrying storage, skills, sessions, and the model registry. */
  constructor(ctx: Context) {
    super(ctx, 'skillPlaza')
    ctx.effect(() => {
      const provider: SkillProvider = {
        name: PLAZA_PROVIDER,
        list: async options => await this.listCandidates(options.cwd),
        get: async (candidate, options) => await this.loadCandidate(candidate, options.signal),
      }
      const dispose = ctx.skills.registerProvider((control) => {
        this.invalidateProvider = control.invalidate
        return provider
      })
      return () => {
        this.invalidateProvider = undefined
        dispose()
      }
    }, 'skill-plaza: provider')
    ctx.effect(() => {
      const ready = this.domain()
      return async () => {
        this.domainReady = undefined
        this.pins.clear()
        await (await ready).close()
      }
    }, 'skill-plaza: storage')
    // A composer selection binds one published version to the next task that
    // names it. The pinned body replaces whatever the active version would
    // have supplied, and an unavailable pin fails the step instead of quietly
    // running a different version.
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const pin = this.pins.get(agent.id)
      if (pin === undefined) return decision
      const pattern = new RegExp(`(^|\\s)/${pin.slug}(?=\\s|$)`)
      const invoked = decision.messages.some(message => message.source.kind === 'user'
        && message.content.some(block => block.type === 'text' && pattern.test(block.text)))
      if (!invoked) return decision
      this.pins.delete(agent.id)
      signal.throwIfAborted()
      const record = (await this.domain()).table('versions').get(`${pin.skillId}@${pin.version}`)
      /* v8 ignore next -- published versions are immutable; nothing in this package removes one */
      if (record === undefined) return { kind: 'reject' }
      const remaining = decision.messages.filter(message => message.source.kind !== 'skill-invocation'
        || message.source.name !== pin.slug)
      const injection = createUserMessage({
        content: [{ type: 'text', text: renderSkillContent({ name: record.slug, provider: PLAZA_PROVIDER, content: record.body }) }],
        source: {
          kind: 'skill-invocation',
          name: record.slug,
          form: 'instructions',
          version: record.version,
          provider: PLAZA_PROVIDER,
        },
      })
      return { ...decision, messages: [...remaining, injection] }
    }, { prepend: true })
  }

  /**
   * Read the published skills callable in one Session's workspace.
   * @param request - Session whose working directory selects the workspace.
   * @param signal - caller cancellation for the workspace read.
   * @returns active published skills sorted by slug.
   */
  @Remote
  async catalog(request: PlazaSessionRequest, signal?: AbortSignal): Promise<PlazaCatalogValue> {
    const workspace = await this.workspaceOf(request.sessionId, signal)
    const domain = await this.domain()
    signal?.throwIfAborted()
    const skills = [...domain.table('skills').entries()]
      .map(([, record]) => record)
      .filter(record => record.workspace === workspace)
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map(toSkillEntry)
    return { skills }
  }

  /**
   * Read the drafts one Session's workspace holds.
   * @param request - Session whose working directory selects the workspace.
   * @returns drafts, most recently saved first.
   */
  @Remote
  async drafts(request: PlazaSessionRequest): Promise<PlazaDraftsValue> {
    const workspace = await this.workspaceOf(request.sessionId)
    return { drafts: this.draftsOf(await this.domain(), workspace) }
  }

  /**
   * Create a draft, or replace one whose revision still matches.
   * @param request - Session, optional draft identity, content, and expected revision.
   * @returns the stored draft at its new revision.
   * @throws RemoteError `skillPlaza/conflict` when the caller's revision is behind.
   */
  @Remote
  async saveDraft(request: PlazaSaveDraftRequest): Promise<PlazaSaveDraftValue> {
    validateContent(request.content)
    const workspace = await this.workspaceOf(request.sessionId)
    const domain = await this.domain()
    const now = new Date().toISOString()
    const drafts = domain.table('drafts')
    if (request.draftId === undefined) {
      const record: PlazaDraftRecord = {
        ...snapshotContent(request.content),
        draftId: `draft-${randomUUID()}`,
        workspace,
        revision: 1,
        updatedAt: now,
      }
      await drafts.put(record.draftId, record)
      this.notifyChanged()
      return { draft: toDraftView(record) }
    }
    const current = drafts.get(request.draftId) ?? notFound(request.draftId)
    if (current.workspace !== workspace) notFound(request.draftId)
    assertRevision(request.expectedRevision, current.revision)
    const record: PlazaDraftRecord = {
      ...current,
      ...snapshotContent(request.content),
      revision: current.revision + 1,
      updatedAt: now,
    }
    await drafts.put(record.draftId, record)
    this.notifyChanged()
    return { draft: toDraftView(record) }
  }

  /**
   * Publish one draft as an immutable version and make it the active one.
   * @param request - Session, draft identity, expected revision, and idempotency key.
   * @returns the active catalog entry after publication.
   * @throws RemoteError `skillPlaza/conflict` for a stale revision, `skillPlaza/name-conflict` for a taken slug.
   */
  @Remote
  async publish(request: PlazaPublishRequest): Promise<PlazaPublishValue> {
    void request.idempotencyKey
    const workspace = await this.workspaceOf(request.sessionId)
    const domain = await this.domain()
    const draft = domain.table('drafts').get(request.draftId) ?? notFound(request.draftId)
    if (draft.workspace !== workspace) notFound(request.draftId)
    const versions = domain.table('versions')
    // A repeated publish of the same revision returns the version it produced.
    const published = [...versions.entries()]
      .map(([, record]) => record)
      .find(record => record.draftId === draft.draftId
        && record.draftRevision === request.expectedRevision
        && record.workspace === workspace)
    if (published !== undefined) {
      /* v8 ignore next -- a published version's catalog row is written with it and never removed */
      const active = this.skillOf(domain, workspace, published.skillId) ?? notFound(published.skillId)
      return { skill: toSkillEntry(active) }
    }
    assertRevision(request.expectedRevision, draft.revision)
    validateContent(draft)
    const owner = draft.skillId === undefined
      ? this.claimSkillId(domain, workspace, draft.slug)
      : draft.skillId
    const active = this.skillOf(domain, workspace, owner)
    const version = (active?.activeVersion ?? 0) + 1
    const now = new Date().toISOString()
    const record: PlazaVersionRecord = {
      ...snapshotContent(draft),
      skillId: owner,
      version,
      workspace,
      publishedAt: now,
      draftId: draft.draftId,
      draftRevision: draft.revision,
      body: renderSkillBody(draft),
    }
    await versions.put(`${owner}@${version}`, record)
    const catalogRow: PlazaSkillRecord = {
      skillId: owner,
      workspace,
      slug: draft.slug,
      title: draft.title,
      description: draft.description,
      activeVersion: version,
      updatedAt: now,
    }
    await domain.table('skills').put(owner, catalogRow)
    if (draft.skillId === undefined) {
      await domain.table('drafts').put(draft.draftId, { ...draft, skillId: owner, updatedAt: now })
    }
    this.invalidateProvider?.()
    this.notifyChanged()
    return { skill: toSkillEntry(catalogRow) }
  }

  /**
   * Distill a draft from one completed turn of a live Session.
   * @param request - Session, completed turn, and idempotency key.
   * @param signal - caller cancellation for the model call.
   * @returns the attempt, carrying its draft when it succeeded and its reason when it failed.
   */
  @Remote
  async generate(request: PlazaGenerateRequest, signal: AbortSignal): Promise<PlazaGenerateValue> {
    const workspace = await this.workspaceOf(request.sessionId, signal)
    const domain = await this.domain()
    const jobs = domain.table('jobs')
    const existing = [...jobs.entries()]
      .map(([, record]) => record)
      .find(record => record.idempotencyKey === request.idempotencyKey
        && record.workspace === workspace
        && record.turnId === request.turnId)
    if (existing !== undefined) return { job: toJobView(existing) }
    // A repeated request while the first attempt is still running joins it
    // instead of starting a second model call.
    const inFlightKey = `${workspace}\u0000${request.idempotencyKey}`
    const inFlight = this.generating.get(inFlightKey)
    if (inFlight !== undefined) return { job: toJobView(await inFlight) }
    const attempt = this.runGeneration(request, workspace, signal)
    this.generating.set(inFlightKey, attempt)
    try {
      return { job: toJobView(await attempt) }
    } finally {
      this.generating.delete(inFlightKey)
    }
  }

  /**
   * Record and run one generation attempt.
   * @param request - Session, turn, and idempotency key of the attempt.
   * @param workspace - resolved workspace directory the attempt belongs to.
   * @param signal - caller cancellation for the model call.
   * @returns the stored attempt after it settled.
   */
  private async runGeneration(
    request: PlazaGenerateRequest,
    workspace: string,
    signal: AbortSignal,
  ): Promise<PlazaJobRecord> {
    const domain = await this.domain()
    const jobs = domain.table('jobs')
    const job: PlazaJobRecord = {
      jobId: `job-${randomUUID()}`,
      workspace,
      sessionId: request.sessionId,
      turnId: request.turnId,
      idempotencyKey: request.idempotencyKey,
      status: 'running',
      attempt: 1,
      updatedAt: new Date().toISOString(),
    }
    await jobs.put(job.jobId, job)
    const outcome = await this.distill(request.sessionId, workspace, request.turnId, signal)
      .then(draft => ({ ok: true as const, draft }))
      .catch((error: unknown) => ({ ok: false as const, error }))
    if (outcome.ok) {
      const settled: PlazaJobRecord = {
        ...job,
        status: 'succeeded',
        draftId: outcome.draft.draftId,
        updatedAt: new Date().toISOString(),
      }
      await jobs.put(job.jobId, settled)
      this.notifyChanged()
      return settled
    }
    const reason = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
    const settled: PlazaJobRecord = {
      ...job,
      status: 'failed',
      error: reason,
      updatedAt: new Date().toISOString(),
    }
    await jobs.put(job.jobId, settled)
    return settled
  }

  /**
   * Bind one published version to a Session's next explicit invocation.
   * @param request - Session, skill identity, exact version, and callable name.
   * @returns the binding the next step will inject.
   * @throws RemoteError when the skill or that version is not published in the Session's workspace.
   */
  @Remote
  async pin(request: PlazaPinRequest): Promise<PlazaPinValue> {
    const workspace = await this.workspaceOf(request.sessionId)
    const domain = await this.domain()
    const skill = domain.table('skills').get(request.skillId) ?? notFound(request.skillId)
    if (skill.workspace !== workspace) notFound(request.skillId)
    const version = domain.table('versions').get(`${request.skillId}@${request.version}`) ?? notFound(`${request.skillId}@${request.version}`)
    this.pins.set(request.sessionId, { skillId: skill.skillId, version: version.version, slug: skill.slug })
    return { skillId: skill.skillId, version: version.version, slug: skill.slug }
  }

  /**
   * Read one generation attempt.
   * @param request - job identity.
   * @returns the attempt as stored.
   */
  @Remote
  async job(request: PlazaJobRequest): Promise<PlazaJobValue> {
    const domain = await this.domain()
    return { job: toJobView(domain.table('jobs').get(request.jobId) ?? notFound(request.jobId)) }
  }

  /** Open (once) and return the plaza storage domain. */
  private domain(): Promise<Domain<typeof skillPlazaDomain>> {
    this.domainReady ??= this.ctx.storageDomain.open(skillPlazaDomain)
    return this.domainReady
  }

  /** Drafts stored for one workspace, newest first. */
  private draftsOf(domain: Domain<typeof skillPlazaDomain>, workspace: string): PlazaDraftView[] {
    return [...domain.table('drafts').entries()]
      .map(([, record]) => record)
      .filter(record => record.workspace === workspace)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(toDraftView)
  }

  /** One catalog row by skill identity. */
  private skillOf(
    domain: Domain<typeof skillPlazaDomain>,
    workspace: string,
    skillId: string,
  ): PlazaSkillRecord | undefined {
    const record = domain.table('skills').get(skillId)
    return record !== undefined && record.workspace === workspace ? record : undefined
  }

  /** Reserve a new skill identity, refusing a slug another skill already owns. */
  private claimSkillId(
    domain: Domain<typeof skillPlazaDomain>,
    workspace: string,
    slug: string,
  ): string {
    const taken = [...domain.table('skills').entries()]
      .some(([, record]) => record.workspace === workspace && record.slug === slug)
    if (taken) {
      throw new RemoteError(
        'skillPlaza/name-conflict',
        `another plaza skill already uses "${slug}"`,
        { slug },
      )
    }
    return `skill-${randomUUID()}`
  }

  /** Provider catalog for one workspace directory. */
  private async listCandidates(cwd: string | undefined): Promise<readonly SkillCandidate[]> {
    if (cwd === undefined) return []
    const workspace = workspaceKey(cwd)
    const domain = await this.domain()
    return [...domain.table('skills').entries()]
      .map(([, record]) => record)
      .filter(record => record.workspace === workspace)
      .map(record => ({
        name: record.slug,
        description: record.description,
        invocation: PLAZA_INVOCATION,
        source: 'custom' as const,
        provider: PLAZA_PROVIDER,
        rank: PLAZA_SKILL_RANK,
        locator: { skillId: record.skillId, version: record.activeVersion },
      }))
  }

  /** Load the exact published version a listed candidate names. */
  private async loadCandidate(
    candidate: SkillCandidate,
    signal: AbortSignal | undefined,
  ): Promise<SkillDefinition | undefined> {
    signal?.throwIfAborted()
    const locator = candidate.locator
    /* v8 ignore next -- this provider lists only version locators */
    if (!isVersionLocator(locator)) return undefined
    const domain = await this.domain()
    const record = domain.table('versions').get(`${locator.skillId}@${locator.version}`)
    /* v8 ignore next -- published versions are immutable; nothing in this package removes one */
    if (record === undefined) return undefined
    return {
      name: record.slug,
      description: record.description,
      invocation: PLAZA_INVOCATION,
      source: 'custom',
      provider: PLAZA_PROVIDER,
      content: record.body,
    }
  }

  /** Resolve one Session's workspace directory. */
  private async workspaceOf(sessionId: PlazaSessionRequest['sessionId'], signal?: AbortSignal): Promise<string> {
    if (sessionId === undefined) return workspaceKey(this.ctx.workingDirectory.defaultDirectory)
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) {
      return workspaceKey(await this.ctx.workingDirectory.ensure(live, signal))
    }
    const sessionQuery = this.ctx.get('sessionQuery')
    if (sessionQuery === undefined) {
      throw new RemoteError(
        'gateway/internal',
        `session "${sessionId}" cannot be inspected without the session-query service`,
        {},
      )
    }
    try {
      using observation = await sessionQuery.observeSession(sessionId)
      const directory = observation.projections?.values.workingDirectory
        ?? observation.header.cwd
        ?? this.ctx.workingDirectory.defaultDirectory
      return workspaceKey(directory)
    } catch (error: unknown) {
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('skillPlaza/not-found', `session "${sessionId}" not found`, { id: sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `session "${sessionId}" could not be inspected: ${String(error)}`,
        {},
      )
    }
  }

  /** Distill one draft from a live Session's completed turn. */
  private async distill(
    sessionId: NonNullable<PlazaSessionRequest['sessionId']>,
    workspace: string,
    turnId: string,
    signal: AbortSignal,
  ): Promise<PlazaDraftView> {
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined) {
      throw new Error('the source session is not live; start it and try again')
    }
    const material = harvestMaterial(agent.session.deriveMessages(), turnId)
    if (material === '') {
      throw new Error('the source turn holds no completed reply to distill')
    }
    signal.throwIfAborted()
    const route = await this.generationRoute()
    const assembler = new BlockAssembler()
    for await (const chunk of this.ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      system: GENERATION_SYSTEM_PROMPT,
      messages: [createUserMessage({ content: [{ type: 'text', text: material }], source: { kind: 'user' } })],
      signal,
    })) {
      assembler.push(chunk)
    }
    if (assembler.finish.kind === 'error') {
      throw new Error(`the model call failed: ${assembler.finish.failure.code}`)
    }
    const content = parseGeneratedContent(textOf(assembler.blocks()))
    validateContent(content)
    const record: PlazaDraftRecord = {
      ...content,
      draftId: `draft-${randomUUID()}`,
      workspace,
      revision: 1,
      updatedAt: new Date().toISOString(),
      source: { sessionId, turnId },
    }
    await (await this.domain()).table('drafts').put(record.draftId, record)
    return toDraftView(record)
  }

  /** Resolve the model route a structured generation call uses. */
  private async generationRoute(): Promise<{ provider: string; model: string }> {
    const fallback = this.ctx.get('agentDefaultModel')?.currentSelection()
    if (fallback !== undefined) return { provider: fallback.provider, model: fallback.model }
    for (const provider of this.ctx.llm.listProviders()) {
      const models = await this.ctx.llm.listModels(provider.id).catch(() => [])
      const first = models[0]
      if (first !== undefined) return { provider: provider.id, model: first.id }
    }
    throw new Error('no model route is available for skill generation')
  }

  /** Announce a plaza write after it committed. */
  private notifyChanged(): void {
    try {
      this.ctx.emit('skill-plaza/changed')
    } catch (error: unknown) {
      this.ctx.logger.warn(`skill-plaza: change listener failed: ${String(error)}`)
    }
  }
}

/** Copy one content payload into stored-record fields. */
function snapshotContent(content: PlazaDraftContent): PlazaContent {
  return {
    title: content.title,
    slug: content.slug,
    description: content.description,
    inputs: [...content.inputs],
    steps: [...content.steps],
    outputs: [...content.outputs],
    verification: content.verification,
    failureHandling: content.failureHandling,
    toolDependencies: [...content.toolDependencies],
  }
}

/** Reject a stale caller revision. */
function assertRevision(expected: number | undefined, actual: number): void {
  if (expected === undefined || expected === actual) return
  throw new RemoteError(
    'skillPlaza/conflict',
    `the draft moved to revision ${actual}; reload before saving`,
    { expected, actual },
  )
}

/** Whether a provider locator names one published version. */
function isVersionLocator(value: unknown): value is { skillId: string; version: number } {
  /* v8 ignore next -- this provider lists only version locators */
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { skillId?: unknown; version?: unknown }
  return typeof candidate.skillId === 'string' && typeof candidate.version === 'number'
}

/** Concatenate the text blocks one model stream produced. */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Render the conversation material a generation call distills.
 * @param messages - the Session's derived messages.
 * @param turnId - identity of the reply the entry belongs to; material after it is excluded.
 * @returns the bounded material handed to the model.
 */
function harvestMaterial(
  messages: readonly { readonly id?: string; readonly content: readonly ContentBlock[] }[],
  turnId: string,
): string {
  // The clicked reply bounds the material: a later turn in the same branch is
  // not part of the method being distilled.
  const bound = messages.findIndex(message => message.id === turnId)
  const scoped = bound < 0 ? messages : messages.slice(0, bound + 1)
  const tail = scoped.slice(-MAX_HARVEST_MESSAGES)
  const text = tail
    .map(message => message.content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim())
    .filter(part => part !== '')
    .join('\n\n---\n\n')
  return text.slice(-MAX_HARVEST_CHARS)
}

/** System prompt for structured draft generation. */
const GENERATION_SYSTEM_PROMPT = [
  'You distill one completed agent conversation into a reusable skill.',
  'Reply with a single JSON object and no prose, matching:',
  '{"title": string, "slug": string, "description": string, "inputs": string[],',
  ' "steps": string[], "outputs": string[], "verification": string,',
  ' "failureHandling": string, "toolDependencies": string[]}',
  'The slug is kebab-case ASCII. Replace concrete identifiers, paths, credentials,',
  'and sample values with named parameters. Keep only the method that generalizes:',
  'preconditions, ordered steps, expected outputs, how to verify the result, and',
  'what to do when the preconditions do not hold.',
].join('\n')

/** Parse and validate one generated draft payload. */
function parseGeneratedContent(raw: string): PlazaContent {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new Error('the model replied without a JSON object')
  }
  let value: unknown
  try {
    value = JSON.parse(raw.slice(start, end + 1))
  } catch (error: unknown) {
    throw new Error(`the model replied with invalid JSON: ${String(error)}`)
  }
  const parsed = plazaContentSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`the generated draft is incomplete: ${parsed.error.issues.map(issue => issue.path.join('.')).join(', ')}`)
  }
  return parsed.data
}

export default SkillPlazaService
