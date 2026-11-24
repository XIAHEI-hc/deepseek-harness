/**
 * Small HTTP client for the platform's fusion API.
 *
 * Every call is authenticated by the runtime capability token the platform
 * injected into the runtime environment. The client never receives a browser
 * session, never constructs a host URL, and never calls a business system
 * directly: the platform's connector broker performs the authorized read.
 *
 * @module @deepseek-ai/dsh-tool-integration/client
 */

/** One authorized resource locator. */
export interface IntegrationResourceLocator {
  readonly systemId: string
  readonly resourceType: 'api' | 'source' | 'dataset' | 'log' | 'artifact'
  readonly resourceId: string
  readonly version?: string
}

/** One authorized resource returned by discovery. */
export interface IntegrationResource {
  readonly locator: IntegrationResourceLocator
  readonly name: string
  readonly classification: string
}

/** One visible system. */
export interface IntegrationSystem {
  readonly id: string
  readonly name: string
  readonly health: string
}

/** One immutable snapshot. */
export interface IntegrationSnapshot {
  readonly id: string
  readonly locator: IntegrationResourceLocator
  readonly sha256: string
  readonly sourceVersion: string
  readonly classification: string
  readonly size: number
}

/** One analysis workspace. */
export interface IntegrationWorkspace {
  readonly id: string
  readonly name: string
}

/** One analysis job. */
export interface IntegrationJob {
  readonly id: string
  readonly workspaceId: string
  readonly status: string
  readonly language: 'shell' | 'python'
  readonly inputSnapshotIds: readonly string[]
  readonly errorCode: string | null
}

/** One job artifact. */
export interface IntegrationArtifact {
  readonly id: string
  readonly jobId: string
  readonly relativePath: string
  readonly sha256: string
  readonly size: number
}

/** Client failure with a stable service code. */
export class IntegrationClientError extends Error {
  /** Stable service code or transport classification. */
  readonly code: string
  /** HTTP status, or 0 for a transport failure. */
  readonly status: number

  /**
   * @param code - stable failure code.
   * @param status - HTTP status or 0.
   */
  constructor(code: string, status: number) {
    super(`integration API failed: ${code}`)
    this.name = 'IntegrationClientError'
    this.code = code
    this.status = status
  }
}

/** Options for {@link IntegrationClient}. */
export interface IntegrationClientOptions {
  /** Base URL of the platform gateway, for example `http://platform:8080`. */
  readonly apiUrl: string
  /** Runtime capability token. */
  readonly capability: string
  /** Request timeout in milliseconds. */
  readonly timeoutMs: number
  /** Cap on text returned to the model. */
  readonly maxContentChars: number
  /** Fetch injection for tests. */
  readonly fetchImplementation?: ((input: string, init: RequestInit) => Promise<Response>) | undefined
}

/**
 * Report whether a value is a non-array object.
 * @param value - candidate.
 * @returns true for a plain record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one required string.
 * @param record - source record.
 * @param field - field name.
 * @returns the string value.
 */
function str(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string') throw new IntegrationClientError('malformed-response', 0)
  return value
}

/** HTTP client bound to one runtime capability. */
export class IntegrationClient {
  private readonly base: string
  private readonly capability: string
  private readonly timeoutMs: number
  private readonly maxContentChars: number
  private readonly fetchImplementation: (input: string, init: RequestInit) => Promise<Response>

  /**
   * @param options - gateway URL, capability, limits, and optional fetch injection.
   */
  constructor(options: IntegrationClientOptions) {
    this.base = options.apiUrl.replace(/\/+$/u, '')
    this.capability = options.capability
    this.timeoutMs = options.timeoutMs
    this.maxContentChars = options.maxContentChars
    this.fetchImplementation = options.fetchImplementation ?? ((input, init) => globalThis.fetch(input, init))
  }

  /**
   * List systems and every resource the user may read.
   * @param signal - caller cancellation.
   * @returns systems plus a flat resource list.
   */
  async listResources(signal?: AbortSignal): Promise<{ systems: IntegrationSystem[]; resources: IntegrationResource[] }> {
    const systemsValue = await this.request('/api/integration/systems', 'GET', undefined, signal)
    const systems: IntegrationSystem[] = []
    if (isRecord(systemsValue) && Array.isArray(systemsValue['systems'])) {
      for (const entry of systemsValue['systems']) {
        if (!isRecord(entry)) continue
        systems.push({ id: str(entry, 'id'), name: str(entry, 'name'), health: str(entry, 'health') })
      }
    }
    const resources: IntegrationResource[] = []
    for (const system of systems.slice(0, 50)) {
      const page = await this.request(`/api/integration/resources?systemId=${encodeURIComponent(system.id)}`, 'GET', undefined, signal)
      if (!isRecord(page) || !Array.isArray(page['items'])) continue
      for (const entry of page['items']) {
        if (!isRecord(entry) || !isRecord(entry['locator'])) continue
        const locator = entry['locator']
        const type = str(locator, 'resourceType')
        if (type !== 'api' && type !== 'source' && type !== 'dataset' && type !== 'log' && type !== 'artifact') continue
        resources.push({
          locator: {
            systemId: str(locator, 'systemId'),
            resourceType: type,
            resourceId: str(locator, 'resourceId'),
            ...(typeof locator['version'] === 'string' ? { version: locator['version'] } : {}),
          },
          name: str(entry, 'name'),
          classification: str(entry, 'classification'),
        })
      }
    }
    return { systems, resources }
  }

  /**
   * List the user's analysis workspaces.
   * @param signal - caller cancellation.
   * @returns the workspaces.
   */
  async listWorkspaces(signal?: AbortSignal): Promise<IntegrationWorkspace[]> {
    const value = await this.request('/api/integration/workspaces', 'GET', undefined, signal)
    if (!isRecord(value) || !Array.isArray(value['workspaces'])) throw new IntegrationClientError('malformed-response', 0)
    return value['workspaces'].flatMap((entry) => {
      if (!isRecord(entry)) return []
      return [{ id: str(entry, 'id'), name: str(entry, 'name') }]
    })
  }

  /**
   * Create an immutable snapshot without reading its content.
   * @param locator - authorized resource.
   * @param signal - caller cancellation.
   * @returns the snapshot metadata.
   */
  async createSnapshot(locator: IntegrationResourceLocator, signal?: AbortSignal): Promise<IntegrationSnapshot> {
    const value = await this.request('/api/integration/snapshots', 'POST', {
      systemId: locator.systemId,
      resourceId: locator.resourceId,
      resourceType: locator.resourceType,
      ...(locator.version === undefined ? {} : { version: locator.version }),
    }, signal)
    return this.parseSnapshot(value)
  }

  /**
   * Create a snapshot and return its text content, capped for the model.
   * @param locator - authorized resource.
   * @param signal - caller cancellation.
   * @returns the snapshot and bounded content.
   */
  async readResource(
    locator: IntegrationResourceLocator,
    signal?: AbortSignal,
  ): Promise<{ snapshot: IntegrationSnapshot; content: string; truncated: boolean }> {
    const snapshot = await this.createSnapshot(locator, signal)
    const value = await this.request(`/api/integration/snapshots/${encodeURIComponent(snapshot.id)}`, 'GET', undefined, signal)
    if (!isRecord(value)) throw new IntegrationClientError('malformed-response', 0)
    const content = str(value, 'content')
    const bounded = this.bound(content)
    return { snapshot, content: bounded.content, truncated: bounded.truncated }
  }

  /**
   * Start one isolated analysis job.
   * @param input - workspace, snapshots, language, and script.
   * @param signal - caller cancellation.
   * @returns the queued job.
   */
  async startJob(
    input: {
      readonly workspaceId: string
      readonly inputSnapshotIds: readonly string[]
      readonly language: 'shell' | 'python'
      readonly script: string
    },
    signal?: AbortSignal,
  ): Promise<IntegrationJob> {
    const value = await this.request('/api/integration/jobs', 'POST', input, signal)
    if (!isRecord(value) || !isRecord(value['job'])) throw new IntegrationClientError('malformed-response', 0)
    return this.parseJob(value['job'])
  }

  /**
   * Read one job and its artifacts.
   * @param jobId - job id.
   * @param signal - caller cancellation.
   * @returns the job view.
   */
  async jobStatus(jobId: string, signal?: AbortSignal): Promise<{ job: IntegrationJob; artifacts: IntegrationArtifact[] }> {
    const value = await this.request(`/api/integration/jobs/${encodeURIComponent(jobId)}`, 'GET', undefined, signal)
    if (!isRecord(value) || !isRecord(value['job'])) throw new IntegrationClientError('malformed-response', 0)
    const artifacts: IntegrationArtifact[] = []
    if (Array.isArray(value['artifacts'])) {
      for (const entry of value['artifacts']) {
        if (!isRecord(entry)) continue
        artifacts.push({
          id: str(entry, 'id'),
          jobId: str(entry, 'jobId'),
          relativePath: str(entry, 'relativePath'),
          sha256: str(entry, 'sha256'),
          size: typeof entry['size'] === 'number' ? entry['size'] : 0,
        })
      }
    }
    return { job: this.parseJob(value['job']), artifacts }
  }

  /**
   * Read one artifact as bounded text.
   * @param artifactId - artifact id.
   * @param signal - caller cancellation.
   * @returns content type, bounded text, and truncation.
   */
  async readArtifact(
    artifactId: string,
    signal?: AbortSignal,
  ): Promise<{ artifactId: string; contentType: string; content: string; truncated: boolean }> {
    const controller = AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal === undefined ? [] : [signal])])
    let response: Response
    try {
      response = await this.fetchImplementation(
        `${this.base}/api/integration/artifacts/${encodeURIComponent(artifactId)}/download`,
        { headers: this.headers(), signal: controller },
      )
    } catch {
      throw new IntegrationClientError('unavailable', 0)
    }
    if (!response.ok) throw await this.error(response)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    const bounded = this.bound(text)
    return {
      artifactId,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      content: bounded.content,
      truncated: bounded.truncated,
    }
  }

  /**
   * Perform one API request.
   * @param path - path below the gateway origin.
   * @param method - HTTP method.
   * @param body - optional JSON body.
   * @param signal - caller cancellation.
   * @returns the decoded JSON value.
   */
  private async request(path: string, method: 'GET' | 'POST', body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const controller = AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal === undefined ? [] : [signal])])
    const headers = this.headers()
    if (body !== undefined) headers['content-type'] = 'application/json'
    let response: Response
    try {
      response = await this.fetchImplementation(`${this.base}${path}`, {
        method,
        headers,
        signal: controller,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      throw new IntegrationClientError('unavailable', 0)
    }
    if (!response.ok) throw await this.error(response)
    try {
      return await response.json()
    } catch {
      throw new IntegrationClientError('malformed-response', response.status)
    }
  }

  /** Request headers carrying the runtime capability. */
  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.capability}`,
      accept: 'application/json',
    }
  }

  /**
   * Build a stable error from a failed response.
   * @param response - failed response.
   * @returns the client error.
   */
  private async error(response: Response): Promise<IntegrationClientError> {
    const body: unknown = await response.json().catch(() => undefined)
    if (isRecord(body) && isRecord(body['error']) && typeof body['error']['code'] === 'string') {
      return new IntegrationClientError(body['error']['code'], response.status)
    }
    return new IntegrationClientError(`http-${String(response.status)}`, response.status)
  }

  /**
   * Parse one snapshot response envelope.
   * @param value - decoded response.
   * @returns the snapshot.
   */
  private parseSnapshot(value: unknown): IntegrationSnapshot {
    if (!isRecord(value) || !isRecord(value['snapshot'])) throw new IntegrationClientError('malformed-response', 0)
    const snapshot = value['snapshot']
    const locator = snapshot['locator']
    if (!isRecord(locator)) throw new IntegrationClientError('malformed-response', 0)
    const type = str(locator, 'resourceType')
    if (type !== 'api' && type !== 'source' && type !== 'dataset' && type !== 'log' && type !== 'artifact') {
      throw new IntegrationClientError('malformed-response', 0)
    }
    return {
      id: str(snapshot, 'id'),
      locator: {
        systemId: str(locator, 'systemId'),
        resourceType: type,
        resourceId: str(locator, 'resourceId'),
        ...(typeof locator['version'] === 'string' ? { version: locator['version'] } : {}),
      },
      sha256: str(snapshot, 'sha256'),
      sourceVersion: str(snapshot, 'sourceVersion'),
      classification: str(snapshot, 'classification'),
      size: typeof snapshot['size'] === 'number' ? snapshot['size'] : 0,
    }
  }

  /**
   * Parse one job object.
   * @param job - decoded job.
   * @returns the job.
   */
  private parseJob(job: Record<string, unknown>): IntegrationJob {
    const language = job['language'] === 'python' ? 'python' : 'shell'
    const ids = Array.isArray(job['inputSnapshotIds'])
      ? job['inputSnapshotIds'].filter((id): id is string => typeof id === 'string')
      : []
    return {
      id: str(job, 'id'),
      workspaceId: str(job, 'workspaceId'),
      status: str(job, 'status'),
      language,
      inputSnapshotIds: ids,
      errorCode: typeof job['errorCode'] === 'string' ? job['errorCode'] : null,
    }
  }

  /**
   * Cap text at the configured model-visible limit.
   * @param value - full text.
   * @returns bounded text and whether it was cut.
   */
  private bound(value: string): { content: string; truncated: boolean } {
    if (value.length <= this.maxContentChars) return { content: value, truncated: false }
    return { content: `${value.slice(0, this.maxContentChars)}\n[truncated]`, truncated: true }
  }
}
