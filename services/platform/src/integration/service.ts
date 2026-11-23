/**
 * HTTP surface of the optional system-fusion service.
 *
 * The gateway owns session authentication, CSRF, and origin checks. This module
 * owns authorization of every object: a request never names an owner, and every
 * workspace, snapshot, job, and artifact lookup is scoped to the validated
 * session's internal user id.
 *
 * @module @deepseek-ai/dsh-platform-services/integration/service
 */

import type {
  IntegrationService,
  PlatformAuditEvent,
  PlatformHttpRequest,
  PlatformHttpResult,
  PlatformUser,
  ValidatedSession,
} from '../contracts.ts'
import {
  RUNTIME_CAPABILITY_TTL_MS,
  mintRuntimeCapability,
  sessionFromCapability,
  verifyRuntimeCapability,
} from './capability.ts'
import type { IntegrationConfig } from './config.ts'
import type { PreflightResult } from './preflight.ts'
import type {
  HostAdapter,
  IntegrationActor,
  IntegrationIssue,
  IntegrationState,
  IntegrationStatus,
  IntegrationSystemView,
  JobLanguage,
  ResourceAction,
  ResourceLocator,
  ResourceType,
  ResourceView,
} from './types.ts'
import type { IntegrationSystemConfig, SystemRegistry } from './registry.ts'
import { createHostAdapter, SUPPORTED_RESOURCE_TYPES } from './adapters.ts'
import { IntegrationError, classifyIntegrationError } from './errors.ts'
import { IntegrationStore } from './store.ts'
import { SnapshotService } from './snapshots.ts'
import { WorkspaceService } from './workspaces.ts'
import { AnalysisJobRunner } from './runner.ts'
import { JobService } from './jobs.ts'

/** Public prefix owned by the fusion API. */
export const INTEGRATION_API_PREFIX = '/api/integration'

/** Audit sink matching the identity service's `recordAudit` method. */
export type IntegrationAuditSink = (event: PlatformAuditEvent) => void

/** One optional fetch injection used by HTTP connector tests. */
export interface IntegrationServiceOptions {
  readonly now?: (() => number) | undefined
  readonly audit?: IntegrationAuditSink | undefined
  readonly fetchImplementation?: ((input: string, init: RequestInit) => Promise<Response>) | undefined
  readonly dockerExecutor?: import('../runtime/backend.ts').DockerExecutor | undefined
  /** HMAC secret for runtime capability tokens; required when fusion is enabled. */
  readonly capabilitySecret?: string | undefined
  /** Runtime capability lifetime; defaults to fifteen minutes. */
  readonly capabilityTtlMs?: number | undefined
}

/**
 * Build one JSON response.
 * @param status - HTTP status.
 * @param value - JSON-safe value.
 * @returns the platform HTTP result.
 */
function json(status: number, value: unknown): PlatformHttpResult {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(value),
  }
}

/**
 * Build one stable error response.
 * @param status - HTTP status.
 * @param code - stable error code.
 * @returns the platform HTTP result.
 */
function errorJson(status: number, code: string): PlatformHttpResult {
  return json(status, { error: { code } })
}

/**
 * Build a blocked response carrying only safe issue codes.
 * @param issues - preflight issues.
 * @returns the platform HTTP result.
 */
function blockedJson(issues: readonly IntegrationIssue[]): PlatformHttpResult {
  return json(503, {
    error: { code: 'integration-blocked' },
    issues: issues.map(issue => ({ code: issue.code, message: issue.message })),
  })
}

/**
 * Report whether a value is a non-array object.
 * @param value - value to inspect.
 * @returns true for a plain record.
 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse one JSON request body.
 * @param request - platform request with optional text body.
 * @returns the parsed object.
 * @throws {IntegrationError} when the body is absent or not a JSON object.
 */
function parseBody(request: PlatformHttpRequest): Readonly<Record<string, unknown>> {
  if (request.body === undefined || request.body.trim() === '') {
    throw new IntegrationError('invalid-request', 'request body is required')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(request.body)
  } catch {
    throw new IntegrationError('invalid-request', 'request body is not valid JSON')
  }
  if (!isRecord(parsed)) throw new IntegrationError('invalid-request', 'request body must be a JSON object')
  return parsed
}

/**
 * Read one required string field from a request body.
 * @param body - parsed body.
 * @param field - field name.
 * @returns the field value.
 */
function requireStringField(body: Readonly<Record<string, unknown>>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new IntegrationError('invalid-request', `${field} must be a non-empty string`)
  }
  return value
}

/**
 * Read one optional string field.
 * @param body - parsed body.
 * @param field - field name.
 * @returns the field value, or undefined.
 */
function optionalStringField(body: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new IntegrationError('invalid-request', `${field} must be a non-empty string`)
  }
  return value
}

/**
 * Validate one requested resource type.
 * @param value - request value.
 * @returns the resource type.
 */
function parseResourceTypeField(value: unknown): ResourceType {
  if (typeof value !== 'string') throw new IntegrationError('invalid-request', 'resourceType must be a string')
  for (const type of SUPPORTED_RESOURCE_TYPES) {
    if (type === value) return type
  }
  throw new IntegrationError('invalid-request', 'resourceType is not supported')
}

/**
 * Validate one requested job language.
 * @param value - request value.
 * @returns the language.
 */
function parseJobLanguageField(value: unknown): JobLanguage {
  if (value === 'shell' || value === 'python') return value
  throw new IntegrationError('invalid-request', 'language must be shell or python')
}

/**
 * Decode one path segment.
 * @param value - raw segment.
 * @returns the decoded segment.
 */
function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new IntegrationError('invalid-request', 'path segment is not valid percent encoding')
  }
}

/** The composed fusion service. */
class PlatformIntegrationService implements IntegrationService {
  private readonly config: IntegrationConfig
  private readonly preflight: PreflightResult
  private readonly registry: SystemRegistry | undefined
  private readonly adapters: ReadonlyMap<string, HostAdapter>
  private readonly store: IntegrationStore
  private readonly snapshots: SnapshotService
  private readonly workspaces: WorkspaceService
  private readonly jobs: JobService
  private readonly audit: IntegrationAuditSink | undefined
  private readonly capabilitySecret: string
  private readonly capabilityTtlMs: number
  private readonly now: () => number
  private closed = false

  /**
   * @param parts - resolved configuration, preflight result, store, and services.
   */
  constructor(parts: {
    readonly config: IntegrationConfig
    readonly preflight: PreflightResult
    readonly registry: SystemRegistry | undefined
    readonly adapters: ReadonlyMap<string, HostAdapter>
    readonly store: IntegrationStore
    readonly snapshots: SnapshotService
    readonly workspaces: WorkspaceService
    readonly jobs: JobService
    readonly audit?: IntegrationAuditSink | undefined
    readonly capabilitySecret: string
    readonly capabilityTtlMs: number
    readonly now: () => number
  }) {
    this.config = parts.config
    this.preflight = parts.preflight
    this.registry = parts.registry
    this.adapters = parts.adapters
    this.store = parts.store
    this.snapshots = parts.snapshots
    this.workspaces = parts.workspaces
    this.jobs = parts.jobs
    this.audit = parts.audit
    this.capabilitySecret = parts.capabilitySecret
    this.capabilityTtlMs = parts.capabilityTtlMs
    this.now = parts.now
  }

  /** @inheritDoc */
  status(): IntegrationStatus {
    return {
      state: this.closed ? 'blocked' : this.preflight.state,
      enabled: this.config.enabled,
      issues: this.preflight.issues,
    }
  }

  /** @inheritDoc */
  mintRuntimeToken(user: PlatformUser, permissionVersion: number): string {
    if (this.closed) throw new IntegrationError('integration-blocked', 'integration service is closed', 503)
    if (this.capabilitySecret.length < 32) {
      throw new IntegrationError('integration-blocked', 'runtime capability secret is not configured', 503)
    }
    return mintRuntimeCapability(this.capabilitySecret, user, permissionVersion, this.now(), this.capabilityTtlMs)
  }

  /** @inheritDoc */
  authenticateRuntimeToken(token: string | undefined): ValidatedSession | undefined {
    if (token === undefined || token === '' || this.capabilitySecret.length < 32) return undefined
    const claims = verifyRuntimeCapability(this.capabilitySecret, token, this.now())
    return claims === undefined ? undefined : sessionFromCapability(claims)
  }

  /** @inheritDoc */
  async handle(request: PlatformHttpRequest, session: ValidatedSession): Promise<PlatformHttpResult | undefined> {
    if (!request.url.pathname.startsWith(`${INTEGRATION_API_PREFIX}/`) && request.url.pathname !== INTEGRATION_API_PREFIX) {
      return undefined
    }
    const actor: IntegrationActor = {
      userId: session.user.id,
      subject: session.user.subject,
      uid: session.user.uid,
      sessionId: session.sessionId,
      permissionVersion: session.permissionVersion,
      ...(request.clientAddress === undefined ? {} : { clientAddress: request.clientAddress }),
    }
    try {
      if (this.closed) return blockedJson([{ code: 'service-closed', message: 'integration service is closed' }])
      const method = request.method.toUpperCase()
      const relative = request.url.pathname.slice(INTEGRATION_API_PREFIX.length)
      const segments = relative.split('/').filter(segment => segment !== '').map(decodeSegment)
      if (segments.length === 1 && segments[0] === 'status') {
        if (method !== 'GET') return errorJson(405, 'method-not-allowed')
        return json(200, this.status())
      }
      if (this.preflight.state !== 'ready') return blockedJson(this.preflight.issues)
      return await this.route(method, segments, request, actor)
    } catch (error) {
      const classified = classifyIntegrationError(error)
      this.recordAudit({
        action: 'FUSION_REQUEST',
        outcome: 'failure',
        userId: actor.userId,
        detail: { code: classified.code, path: request.url.pathname },
      })
      return errorJson(classified.status, classified.code)
    }
  }

  /** @inheritDoc */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.jobs.close().catch(() => undefined)
    this.store.close()
  }

  /**
   * Route one ready-state fusion request.
   * @param method - upper-case method.
   * @param segments - decoded path segments below the prefix.
   * @param request - full platform request.
   * @param actor - validated actor.
   * @returns the response.
   */
  private async route(
    method: string,
    segments: readonly string[],
    request: PlatformHttpRequest,
    actor: IntegrationActor,
  ): Promise<PlatformHttpResult | undefined> {
    const [first, second, third] = segments
    if (first === 'systems' && segments.length === 1) {
      if (method !== 'GET') return errorJson(405, 'method-not-allowed')
      const systems = await this.visibleSystems(actor)
      return json(200, { systems })
    }
    if (first === 'resources' && segments.length === 1) {
      if (method !== 'GET') return errorJson(405, 'method-not-allowed')
      const systemId = request.url.searchParams.get('systemId')
      if (systemId === null || systemId === '') return errorJson(400, 'invalid-request')
      const adapter = this.adapters.get(systemId)
      if (adapter === undefined) return errorJson(404, 'resource-not-found')
      const page = await adapter.discover(actor, request.url.searchParams.get('cursor'))
      return json(200, page)
    }
    if (first === 'snapshots' && segments.length === 1) {
      if (method !== 'POST') return errorJson(405, 'method-not-allowed')
      const body = parseBody(request)
      const systemId = requireStringField(body, 'systemId')
      const resourceId = requireStringField(body, 'resourceId')
      const resourceType = parseResourceTypeField(body['resourceType'])
      const version = optionalStringField(body, 'version')
      const adapter = this.adapters.get(systemId)
      if (adapter === undefined) return errorJson(404, 'resource-not-found')
      const locator: ResourceLocator = {
        systemId,
        resourceType,
        resourceId,
        ...(version === undefined ? {} : { version }),
      }
      const captured = await this.snapshots.capture(actor, adapter, locator)
      this.recordAudit({
        action: 'SNAPSHOT_CREATE',
        outcome: 'success',
        userId: actor.userId,
        detail: { systemId, resourceId, snapshotId: captured.record.id, sha256: captured.record.sha256 },
      })
      return json(201, { snapshot: captured.record })
    }
    if (first === 'snapshots' && segments.length === 2 && second !== undefined) {
      if (method !== 'GET') return errorJson(405, 'method-not-allowed')
      const snapshot = this.store.findSnapshot(second, actor.userId)
      if (snapshot === undefined) return errorJson(404, 'resource-not-found')
      const bytes = this.snapshots.read(snapshot)
      return json(200, {
        snapshot,
        encoding: 'utf-8',
        content: new TextDecoder().decode(bytes),
      })
    }
    if (first === 'workspaces' && segments.length === 1) {
      if (method === 'GET') return json(200, { workspaces: this.workspaces.list(actor) })
      if (method !== 'POST') return errorJson(405, 'method-not-allowed')
      const body = parseBody(request)
      const workspace = this.workspaces.create(actor, requireStringField(body, 'name'))
      return json(201, { workspace })
    }
    if (first === 'jobs') {
      if (segments.length === 1) {
        if (method === 'GET') return json(200, { jobs: this.jobs.list(actor) })
        if (method !== 'POST') return errorJson(405, 'method-not-allowed')
        const body = parseBody(request)
        const workspaceId = requireStringField(body, 'workspaceId')
        const inputSnapshotIdsValue = body['inputSnapshotIds']
        if (!Array.isArray(inputSnapshotIdsValue)) {
          throw new IntegrationError('invalid-request', 'inputSnapshotIds must be an array')
        }
        const inputSnapshotIds: string[] = []
        for (const entry of inputSnapshotIdsValue) {
          if (typeof entry !== 'string') throw new IntegrationError('invalid-request', 'inputSnapshotIds must contain strings')
          inputSnapshotIds.push(entry)
        }
        const language = parseJobLanguageField(body['language'])
        const script = requireStringField(body, 'script')
        const job = await this.jobs.start(actor, { workspaceId, inputSnapshotIds, language, script })
        return json(202, { job })
      }
      if (segments.length === 2 && second !== undefined) {
        if (method !== 'GET') return errorJson(405, 'method-not-allowed')
        const view = this.jobs.get(actor, second)
        return json(200, view)
      }
      if (segments.length === 3 && second !== undefined && third === 'cancel') {
        if (method !== 'POST') return errorJson(405, 'method-not-allowed')
        const job = await this.jobs.cancel(actor, second)
        return json(200, { job })
      }
    }
    if (first === 'artifacts' && segments.length === 3 && second !== undefined && third === 'download') {
      if (method !== 'GET') return errorJson(405, 'method-not-allowed')
      const { artifact, bytes } = this.jobs.artifact(actor, second)
      this.recordAudit({
        action: 'ARTIFACT_DOWNLOAD',
        outcome: 'success',
        userId: actor.userId,
        detail: { artifactId: artifact.id, jobId: artifact.jobId, sha256: artifact.sha256 },
      })
      const filename = artifact.relativePath.split('/').pop() ?? 'artifact'
      return {
        status: 200,
        headers: {
          'content-type': artifact.mime,
          'content-length': String(bytes.byteLength),
          'content-disposition': `attachment; filename="${filename.replaceAll(/[^A-Za-z0-9._-]/gu, '_')}"`,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        },
        bodyBytes: bytes,
      }
    }
    if (first === 'audit' && segments.length === 1) {
      if (method !== 'GET') return errorJson(405, 'method-not-allowed')
      const jobId = request.url.searchParams.get('jobId')
      if (jobId === null || jobId === '') return errorJson(400, 'invalid-request')
      const view = this.jobs.get(actor, jobId)
      const inputs = this.store.findSnapshots(view.job.inputSnapshotIds, actor.userId)
      return json(200, { ...view, inputs })
    }
    return errorJson(404, 'integration-not-found')
  }

  /**
   * List systems for which the actor can discover at least one resource.
   * @param actor - validated session actor.
   * @returns visible systems with connector health.
   */
  private async visibleSystems(actor: IntegrationActor): Promise<IntegrationSystemView[]> {
    if (this.registry === undefined) return []
    const views: IntegrationSystemView[] = []
    for (const system of this.registry.systems) {
      const adapter = this.adapters.get(system.id)
      if (adapter === undefined) continue
      const page = await adapter.discover(actor, null).catch(() => undefined)
      if (page === undefined || page.items.length === 0) continue
      const health = await adapter.health().catch(() => 'degraded' as const)
      views.push({ id: system.id, name: system.name, health })
    }
    return views
  }

  /**
   * Record one fusion audit event without failing the request.
   * @param event - audit facts.
   */
  private recordAudit(event: PlatformAuditEvent): void {
    if (this.audit === undefined) return
    try {
      this.audit(event)
    } catch (error) {
      void error
      // Audit delivery is best effort and must not change request outcomes.
    }
  }
}

/** A service that cannot open its metadata store still reports a precise disabled or blocked state. */
class StaticIntegrationService implements IntegrationService {
  private readonly config: IntegrationConfig
  private readonly state: IntegrationState
  private readonly issues: readonly IntegrationIssue[]

  /**
   * @param config - resolved fusion configuration.
   * @param state - disabled or blocked state to report.
   * @param issues - reasons the service cannot start.
   */
  constructor(config: IntegrationConfig, state: IntegrationState, issues: readonly IntegrationIssue[]) {
    this.config = config
    this.state = state
    this.issues = issues
  }

  /** @inheritDoc */
  status(): IntegrationStatus {
    return { state: this.state, enabled: this.config.enabled, issues: this.issues }
  }

  /** @inheritDoc */
  mintRuntimeToken(): string {
    throw new IntegrationError('integration-disabled', 'fusion is not enabled', 503)
  }

  /** @inheritDoc */
  authenticateRuntimeToken(): ValidatedSession | undefined {
    return undefined
  }

  /** @inheritDoc */
  async handle(request: PlatformHttpRequest, session: ValidatedSession): Promise<PlatformHttpResult | undefined> {
    void session
    if (!request.url.pathname.startsWith(`${INTEGRATION_API_PREFIX}/`) && request.url.pathname !== INTEGRATION_API_PREFIX) {
      return undefined
    }
    if (request.url.pathname === `${INTEGRATION_API_PREFIX}/status`) return json(200, this.status())
    return blockedJson(this.issues)
  }

  /** @inheritDoc */
  async close(): Promise<void> {
    // No store, runner, or adapter was created.
  }
}

/**
 * Build the optional fusion service.
 *
 * The returned service is blocked when preflight found any hard prerequisite
 * missing; callers still receive a service so `/status` can report the exact
 * issues while every data route refuses.
 * @param config - resolved fusion configuration.
 * @param preflight - startup preflight result.
 * @param options - clock, audit sink, and connector/fetch injections.
 * @returns the service.
 */
export function createIntegrationService(
  config: IntegrationConfig,
  preflight: PreflightResult,
  options: IntegrationServiceOptions = {},
): IntegrationService {
  if (!config.enabled) return new StaticIntegrationService(config, 'disabled', [])
  let store: IntegrationStore
  try {
    store = IntegrationStore.open(config.databaseFile)
  } catch {
    return new StaticIntegrationService(config, 'blocked', [
      ...preflight.issues,
      { code: 'storage-failed', message: 'integration metadata database could not be opened' },
    ])
  }
  const adapters = new Map<string, HostAdapter>()
  const registry = preflight.registry
  if (registry !== undefined) {
    for (const system of registry.systems) {
      adapters.set(system.id, createHostAdapter(system, {
        maxSnapshotBytes: config.maxSnapshotBytes,
        httpTimeoutMs: config.httpTimeoutMs,
        httpMaxBytes: config.httpMaxBytes,
        now: options.now,
        ...(options.fetchImplementation === undefined ? {} : { fetchImplementation: options.fetchImplementation }),
      }))
    }
  }
  const now = options.now ?? Date.now
  const snapshots = new SnapshotService(store, config.snapshotsRoot, now)
  const workspaces = new WorkspaceService(store, config.workspacesRoot, now)
  const runner = new AnalysisJobRunner(config, {
    ...(options.dockerExecutor === undefined ? {} : { executor: options.dockerExecutor }),
  })
  const jobs = new JobService({
    config,
    store,
    snapshots,
    workspaces,
    runner,
    adapters,
    now,
    ...(options.audit === undefined ? {} : { audit: event => {
      options.audit?.({
        action: event.action,
        outcome: event.outcome,
        userId: event.userId,
        detail: { jobId: event.jobId, errorCode: event.errorCode },
      })
    } }),
  })
  return new PlatformIntegrationService({
    config,
    preflight,
    registry,
    adapters,
    store,
    snapshots,
    workspaces,
    jobs,
    capabilitySecret: options.capabilitySecret ?? '',
    capabilityTtlMs: options.capabilityTtlMs ?? RUNTIME_CAPABILITY_TTL_MS,
    now,
    ...(options.audit === undefined ? {} : { audit: options.audit }),
  })
}

/** Systems visible to a test without constructing a service. */
export function systemConfigs(registry: SystemRegistry): readonly IntegrationSystemConfig[] {
  return registry.systems
}

/** Resource actions accepted by the API; exported for request parsing tests. */
export const READ_ACTIONS: readonly ResourceAction[] = ['list', 'read', 'export']

/** Resource view projection shared with tests. */
export type { ResourceView }
