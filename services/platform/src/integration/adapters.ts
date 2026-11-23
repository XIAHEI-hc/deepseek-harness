/**
 * Read-only host adapters.
 *
 * `MockHostAdapter` is a fully offline connector used by tests and local
 * evaluation. `HttpReadOnlyAdapter` fetches only administrator-registered GET
 * endpoints: the request URL is never assembled from user input, redirects are
 * refused, responses are size-capped, and every operation re-checks the actor's
 * configured ACL.
 *
 * @module @deepseek-ai/dsh-platform-services/integration/adapters
 */

import { randomUUID } from 'node:crypto'
import type {
  HostAdapter,
  IntegrationActor,
  ResourceAction,
  ResourceClassification,
  ResourceGrant,
  ResourceLocator,
  ResourcePage,
  ResourceType,
  ResourceView,
  SnapshotPayload,
} from './types.ts'
import { IntegrationError } from './errors.ts'
import type {
  HttpEndpointConfig,
  IntegrationSystemConfig,
  MockResourceConfig,
  ResourceAcl,
} from './registry.ts'

/** Grant lifetime for one read operation. */
const GRANT_TTL_MS = 5 * 60 * 1000

/** Bound on a Mock or HTTP page in one discover response. */
const PAGE_SIZE = 100

/** Metadata and link-local hosts no configured connector may target. */
const FORBIDDEN_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata',
])

/**
 * Check whether an ACL grants one action.
 * @param acl - per-user action map.
 * @param userId - internal user id.
 * @param action - requested action.
 * @returns true only when the user has that exact action.
 */
function allows(acl: ResourceAcl, actor: IntegrationActor, action: ResourceAction): boolean {
  const actions = acl[actor.userId] ?? acl[actor.subject] ?? acl[actor.uid]
  return actions !== undefined && actions.includes(action)
}

/**
 * Return the actions granted to one actor, regardless of which ACL key matched.
 * @param acl - per-user action map.
 * @param actor - validated session actor.
 * @returns the granted actions.
 */
function grantedActions(acl: ResourceAcl, actor: IntegrationActor): readonly ResourceAction[] {
  return acl[actor.userId] ?? acl[actor.subject] ?? acl[actor.uid] ?? []
}

/**
 * Re-check grant ownership, expiry, and the read action before a snapshot read.
 * @param grant - grant returned by `authorize`.
 * @param actor - validated session actor.
 * @param now - current epoch milliseconds.
 * @throws {IntegrationError} when the grant is not usable.
 */
function assertGrantUsable(grant: ResourceGrant, actor: IntegrationActor, now: () => number): void {
  if (grant.ownerUserId !== actor.userId || !grant.actions.includes('read')) {
    throw new IntegrationError('resource-forbidden', 'grant does not authorize this actor', 403)
  }
  if (Date.parse(grant.expiresAt) <= now()) {
    throw new IntegrationError('resource-forbidden', 'grant has expired', 403)
  }
}

/**
 * Build a short-lived grant after a successful ACL check.
 * @param actor - validated session actor.
 * @param systemId - connector id.
 * @param resourceId - resource id.
 * @param acl - ACL that admitted the operation.
 * @param now - current epoch milliseconds.
 * @returns the grant.
 */
function makeGrant(
  actor: IntegrationActor,
  systemId: string,
  resourceId: string,
  acl: ResourceAcl,
  now: () => number,
): ResourceGrant {
  return {
    grantId: randomUUID(),
    connectorId: systemId,
    resourceId,
    actions: grantedActions(acl, actor),
    expiresAt: new Date(now() + GRANT_TTL_MS).toISOString(),
    grantVersion: 1,
    ownerUserId: actor.userId,
    policyEpoch: actor.permissionVersion,
  }
}

/**
 * Encode a Mock resource as deterministic JSON bytes.
 * @param content - JSON value.
 * @returns UTF-8 bytes.
 */
function encodeJson(content: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(content, null, 2)}\n`)
}

/** Offline connector backed by declarative resources in the registry file. */
export class MockHostAdapter implements HostAdapter {
  readonly systemId: string
  private readonly resources: readonly MockResourceConfig[]
  private readonly now: () => number
  private readonly maxBytes: number

  /**
   * @param system - registered Mock system.
   * @param options - clock and snapshot size bound.
   */
  constructor(system: IntegrationSystemConfig, options: { readonly now?: (() => number) | undefined; readonly maxBytes: number }) {
    if (system.adapter !== 'mock' || system.mockResources === undefined) {
      throw new IntegrationError('integration-blocked', 'MockHostAdapter requires a mock system', 503)
    }
    this.systemId = system.id
    this.resources = system.mockResources
    this.now = options.now ?? Date.now
    this.maxBytes = options.maxBytes
  }

  /** @inheritDoc */
  async discover(actor: IntegrationActor, cursor: string | null): Promise<ResourcePage> {
    const offset = cursor === null ? 0 : Number.parseInt(cursor, 10)
    if (!Number.isInteger(offset) || offset < 0) {
      throw new IntegrationError('invalid-request', 'invalid resource cursor')
    }
    const visible = this.resources.filter(resource => allows(resource.acl, actor, 'read') || allows(resource.acl, actor, 'list'))
    const items = visible.slice(offset, offset + PAGE_SIZE).map(resource => this.view(resource))
    const next = offset + PAGE_SIZE < visible.length ? String(offset + PAGE_SIZE) : null
    return { items, nextCursor: next }
  }

  /** @inheritDoc */
  async authorize(actor: IntegrationActor, locator: ResourceLocator, action: ResourceAction): Promise<ResourceGrant> {
    const resource = this.resourceFor(locator)
    if (!allows(resource.acl, actor, action)) {
      throw new IntegrationError('resource-forbidden', 'the actor has no grant for this resource', 403)
    }
    if (locator.version !== undefined && locator.version !== resource.version) {
      throw new IntegrationError('resource-not-found', 'the requested version is not available', 404)
    }
    return makeGrant(actor, this.systemId, resource.id, resource.acl, this.now)
  }

  /** @inheritDoc */
  async snapshot(actor: IntegrationActor, locator: ResourceLocator, grant: ResourceGrant): Promise<SnapshotPayload> {
    assertGrantUsable(grant, actor, this.now)
    const resource = this.resourceFor(locator)
    if (!allows(resource.acl, actor, 'read')) {
      throw new IntegrationError('resource-forbidden', 'read permission was revoked', 403)
    }
    const content = encodeJson(resource.content)
    if (content.byteLength > this.maxBytes) {
      throw new IntegrationError('snapshot-too-large', 'resource exceeds the snapshot size limit', 413)
    }
    return {
      content,
      contentType: 'application/json; charset=utf-8',
      sourceVersion: resource.version,
      classification: resource.classification,
    }
  }

  /** @inheritDoc */
  async health(): Promise<'ready' | 'degraded'> {
    return 'ready'
  }

  /**
   * Resolve one locator against this connector.
   * @param locator - requested locator.
   * @returns the matching resource.
   */
  private resourceFor(locator: ResourceLocator): MockResourceConfig {
    if (locator.systemId !== this.systemId) {
      throw new IntegrationError('resource-not-found', 'resource does not belong to this connector', 404)
    }
    const resource = this.resources.find(entry => entry.id === locator.resourceId)
    if (resource === undefined || resource.resourceType !== locator.resourceType) {
      throw new IntegrationError('resource-not-found', 'unknown resource', 404)
    }
    return resource
  }

  /**
   * Project one resource for discovery.
   * @param resource - stored Mock resource.
   * @returns the browser-safe view.
   */
  private view(resource: MockResourceConfig): ResourceView {
    return {
      locator: {
        systemId: this.systemId,
        resourceType: resource.resourceType,
        resourceId: resource.id,
        version: resource.version,
      },
      name: resource.name,
      classification: resource.classification,
    }
  }
}

/** Injectable fetch surface, narrowed to the request the adapter makes. */
export type FetchImplementation = (input: string, init: RequestInit) => Promise<Response>

/** Options for {@link HttpReadOnlyAdapter}. */
export interface HttpAdapterOptions {
  readonly timeoutMs: number
  readonly maxBytes: number
  readonly now?: (() => number) | undefined
  readonly fetchImplementation?: FetchImplementation | undefined
}

/**
 * Reject a configured origin that would address cloud metadata or a loopback control plane.
 * @param origin - administrator-configured origin.
 * @throws {IntegrationError} when the host is a known metadata endpoint.
 */
function assertNoMetadataHost(origin: string): void {
  const host = new URL(origin).hostname.toLowerCase()
  if (FORBIDDEN_HOSTS.has(host)) {
    throw new IntegrationError('integration-blocked', 'connector origin addresses a metadata endpoint', 503)
  }
}

/**
 * Read a response body with a hard byte cap.
 * @param response - fetch response.
 * @param limit - maximum accepted bytes.
 * @returns the body bytes.
 * @throws {IntegrationError} when the body exceeds the limit.
 */
async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) {
    await response.body?.cancel()
    throw new IntegrationError('snapshot-too-large', 'connector response exceeds the snapshot size limit', 413)
  }
  if (response.body === null) return new Uint8Array(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    const chunk = result.value
    total += chunk.byteLength
    if (total > limit) {
      await reader.cancel()
      throw new IntegrationError('snapshot-too-large', 'connector response exceeds the snapshot size limit', 413)
    }
    chunks.push(chunk)
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/** Allowlisted GET-only connector for an existing business system. */
export class HttpReadOnlyAdapter implements HostAdapter {
  readonly systemId: string
  private readonly baseUrl: string
  private readonly endpoints: readonly HttpEndpointConfig[]
  private readonly timeoutMs: number
  private readonly maxBytes: number
  private readonly now: () => number
  private readonly fetchImplementation: FetchImplementation

  /**
   * @param system - registered HTTP system.
   * @param options - timeout, size bound, clock, and optional fetch injection.
   */
  constructor(system: IntegrationSystemConfig, options: HttpAdapterOptions) {
    if (system.adapter !== 'http' || system.baseUrl === undefined || system.endpoints === undefined) {
      throw new IntegrationError('integration-blocked', 'HttpReadOnlyAdapter requires an http system', 503)
    }
    assertNoMetadataHost(system.baseUrl)
    this.systemId = system.id
    this.baseUrl = system.baseUrl
    this.endpoints = system.endpoints
    this.timeoutMs = options.timeoutMs
    this.maxBytes = options.maxBytes
    this.now = options.now ?? Date.now
    this.fetchImplementation = options.fetchImplementation ?? ((input, init) => fetch(input, init))
  }

  /** @inheritDoc */
  async discover(actor: IntegrationActor, cursor: string | null): Promise<ResourcePage> {
    const offset = cursor === null ? 0 : Number.parseInt(cursor, 10)
    if (!Number.isInteger(offset) || offset < 0) {
      throw new IntegrationError('invalid-request', 'invalid resource cursor')
    }
    const visible = this.endpoints.filter(endpoint => allows(endpoint.acl, actor, 'read') || allows(endpoint.acl, actor, 'list'))
    const items = visible.slice(offset, offset + PAGE_SIZE).map(endpoint => this.view(endpoint))
    const next = offset + PAGE_SIZE < visible.length ? String(offset + PAGE_SIZE) : null
    return { items, nextCursor: next }
  }

  /** @inheritDoc */
  async authorize(actor: IntegrationActor, locator: ResourceLocator, action: ResourceAction): Promise<ResourceGrant> {
    const endpoint = this.endpointFor(locator)
    if (!allows(endpoint.acl, actor, action)) {
      throw new IntegrationError('resource-forbidden', 'the actor has no grant for this resource', 403)
    }
    if (locator.version !== undefined && locator.version !== endpoint.version) {
      throw new IntegrationError('resource-not-found', 'the requested version is not available', 404)
    }
    return makeGrant(actor, this.systemId, endpoint.id, endpoint.acl, this.now)
  }

  /** @inheritDoc */
  async snapshot(actor: IntegrationActor, locator: ResourceLocator, grant: ResourceGrant): Promise<SnapshotPayload> {
    assertGrantUsable(grant, actor, this.now)
    const endpoint = this.endpointFor(locator)
    if (!allows(endpoint.acl, actor, 'read')) {
      throw new IntegrationError('resource-forbidden', 'read permission was revoked', 403)
    }
    const url = new URL(endpoint.path, this.baseUrl)
    if (url.origin !== this.baseUrl) {
      throw new IntegrationError('integration-blocked', 'connector endpoint escaped its configured origin', 503)
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort()
    }, this.timeoutMs)
    try {
      const response = await this.fetchImplementation(url.toString(), {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
        headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.1' },
      })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        throw new IntegrationError('snapshot-failed', 'connector redirects are refused', 502)
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new IntegrationError('snapshot-failed', `connector answered ${String(response.status)}`, 502)
      }
      const content = await readBoundedBody(response, this.maxBytes)
      const contentType = response.headers.get('content-type') ?? 'application/octet-stream'
      const etag = response.headers.get('etag')
      return {
        content,
        contentType,
        sourceVersion: etag !== null && etag !== '' ? etag : endpoint.version,
        classification: endpoint.classification,
      }
    } catch (error) {
      if (error instanceof IntegrationError) throw error
      throw new IntegrationError('snapshot-failed', 'connector request failed', 502)
    } finally {
      clearTimeout(timeout)
    }
  }

  /** @inheritDoc */
  async health(): Promise<'ready' | 'degraded'> {
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort()
    }, this.timeoutMs)
    try {
      await this.fetchImplementation(this.baseUrl, {
        method: 'HEAD',
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
      })
      return 'ready'
    } catch {
      // A transport failure is the only health signal exposed; upstream response
      // text stays out of the browser and the log.
      return 'degraded'
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * Resolve one locator against this connector.
   * @param locator - requested locator.
   * @returns the matching endpoint.
   */
  private endpointFor(locator: ResourceLocator): HttpEndpointConfig {
    if (locator.systemId !== this.systemId) {
      throw new IntegrationError('resource-not-found', 'resource does not belong to this connector', 404)
    }
    const endpoint = this.endpoints.find(entry => entry.id === locator.resourceId)
    if (endpoint === undefined || endpoint.resourceType !== locator.resourceType) {
      throw new IntegrationError('resource-not-found', 'unknown resource', 404)
    }
    return endpoint
  }

  /**
   * Project one endpoint for discovery.
   * @param endpoint - registered endpoint.
   * @returns the browser-safe view.
   */
  private view(endpoint: HttpEndpointConfig): ResourceView {
    const locator: ResourceLocator = {
      systemId: this.systemId,
      resourceType: endpoint.resourceType,
      resourceId: endpoint.id,
      version: endpoint.version,
    }
    return { locator, name: endpoint.name, classification: endpoint.classification }
  }
}

/**
 * Build one adapter from a registered system.
 * @param system - registered system.
 * @param options - size bounds loaded from configuration.
 * @returns the adapter.
 */
export function createHostAdapter(
  system: IntegrationSystemConfig,
  options: {
    readonly maxSnapshotBytes: number
    readonly httpTimeoutMs: number
    readonly httpMaxBytes: number
    readonly now?: (() => number) | undefined
    readonly fetchImplementation?: FetchImplementation | undefined
  },
): HostAdapter {
  if (system.adapter === 'mock') {
    return new MockHostAdapter(system, { maxBytes: options.maxSnapshotBytes, now: options.now })
  }
  return new HttpReadOnlyAdapter(system, {
    timeoutMs: options.httpTimeoutMs,
    maxBytes: options.httpMaxBytes,
    now: options.now,
    ...(options.fetchImplementation === undefined ? {} : { fetchImplementation: options.fetchImplementation }),
  })
}

/** Resource types supported by adapters, exported for request validation. */
export const SUPPORTED_RESOURCE_TYPES: readonly ResourceType[] = ['api', 'source', 'dataset', 'log', 'artifact']
/** Classifications supported by adapters, exported for request validation. */
export const SUPPORTED_CLASSIFICATIONS: readonly ResourceClassification[] = ['public', 'internal', 'confidential']
