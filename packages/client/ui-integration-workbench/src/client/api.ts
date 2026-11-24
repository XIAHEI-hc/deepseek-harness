/**
 * Same-origin calls to the platform gateway's optional fusion API.
 *
 * The browser never reads the HttpOnly session cookie; mutating requests echo
 * the non-HttpOnly `dsh_csrf` cookie in `x-csrf-token`. Every object id in a
 * request is logical; host paths and connector URLs never reach this layer.
 */

/** Non-HttpOnly CSRF cookie the platform sets for mutating requests. */
export const CSRF_COOKIE = 'dsh_csrf'

/** Fusion API prefix. */
const PREFIX = '/api/integration'

/** Anonymous service status returned by `/api/integration/status`. */
export interface FusionStatus {
  readonly state: 'disabled' | 'ready' | 'degraded' | 'blocked'
  readonly enabled: boolean
  readonly issues: readonly { readonly code: string; readonly message: string }[]
}

/** One connector visible to the signed-in user. */
export interface FusionSystem {
  readonly id: string
  readonly name: string
  readonly health: 'ready' | 'degraded'
}

/** One authorized host resource. */
export interface FusionResource {
  readonly locator: {
    readonly systemId: string
    readonly resourceType: 'api' | 'source' | 'dataset' | 'log' | 'artifact'
    readonly resourceId: string
    readonly version?: string
  }
  readonly name: string
  readonly classification: 'public' | 'internal' | 'confidential'
}

/** One analysis workspace. */
export interface FusionWorkspace {
  readonly id: string
  readonly name: string
  readonly createdAt: string
}

/** One analysis job status. */
export type FusionJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** One analysis job. */
export interface FusionJob {
  readonly id: string
  readonly workspaceId: string
  readonly status: FusionJobStatus
  readonly inputSnapshotIds: readonly string[]
  readonly language: 'shell' | 'python'
  readonly createdAt: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly errorCode: string | null
}

/** One job artifact. */
export interface FusionArtifact {
  readonly id: string
  readonly jobId: string
  readonly workspaceId: string
  readonly relativePath: string
  readonly sha256: string
  readonly mime: string
  readonly size: number
}

/** A job with its artifacts. */
export interface FusionJobView {
  readonly job: FusionJob
  readonly artifacts: readonly FusionArtifact[]
}

/** A captured immutable snapshot. */
export interface FusionSnapshot {
  readonly id: string
  readonly locator: FusionResource['locator']
  readonly sha256: string
  readonly sourceVersion: string
  readonly classification: string
  readonly size: number
}

/** Everything the workbench reads when it opens. */
export interface FusionOverview {
  readonly status: FusionStatus
  readonly systems: readonly FusionSystem[]
  readonly workspaces: readonly FusionWorkspace[]
  readonly jobs: readonly FusionJob[]
}

/** One page of authorized resources. */
export interface FusionResourcePage {
  readonly items: readonly FusionResource[]
  readonly nextCursor: string | null
}

/** A stable fusion API failure. */
export class FusionApiError extends Error {
  /** Stable code from the service, or a transport code. */
  readonly code: string
  /** HTTP status, or 0 for a transport failure. */
  readonly status: number

  /**
   * @param code - stable failure code.
   * @param status - HTTP status or 0.
   */
  constructor(code: string, status: number) {
    super(code)
    this.name = 'FusionApiError'
    this.code = code
    this.status = status
  }
}

/** Same-origin transport seam; tests supply their own. */
export interface FusionTransport {
  /**
   * Perform one same-origin request.
   * @param input - path.
   * @param init - fetch options.
   */
  fetch(input: string, init?: RequestInit): Promise<Response>
  /**
   * Read one cookie by name.
   * @param name - cookie name.
   */
  cookie(name: string): string | undefined
}

/**
 * Read one cookie from the page.
 * @param name - cookie name.
 * @returns the decoded value, or undefined.
 */
export function readBrowserCookie(name: string): string | undefined {
  const cookie = (globalThis as { document?: { cookie?: string } }).document?.cookie
  if (cookie === undefined) return undefined
  const prefix = `${name}=`
  for (const part of cookie.split(';')) {
    const entry = part.trim()
    if (entry.startsWith(prefix)) return decodeURIComponent(entry.slice(prefix.length))
  }
  return undefined
}

/**
 * Build the transport bound to the current page.
 * @returns the page-bound transport.
 */
export function browserTransport(): FusionTransport {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    cookie: readBrowserCookie,
  }
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
 * Read one required string field.
 * @param record - source record.
 * @param field - field name.
 * @returns the string.
 */
function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string') throw new FusionApiError('malformed-response', 0)
  return value
}

/**
 * Read one required number field.
 * @param record - source record.
 * @param field - field name.
 * @returns the number.
 */
function numberField(record: Record<string, unknown>, field: string): number {
  const value = record[field]
  if (typeof value !== 'number') throw new FusionApiError('malformed-response', 0)
  return value
}

/**
 * Parse one service status body.
 * @param value - decoded JSON.
 * @returns the status.
 */
function parseStatus(value: unknown): FusionStatus {
  if (!isRecord(value)) throw new FusionApiError('malformed-response', 0)
  const state = value['state']
  if (state !== 'disabled' && state !== 'ready' && state !== 'degraded' && state !== 'blocked') {
    throw new FusionApiError('malformed-response', 0)
  }
  const issuesValue = value['issues']
  const issues: { code: string; message: string }[] = []
  if (issuesValue !== undefined) {
    if (!Array.isArray(issuesValue)) throw new FusionApiError('malformed-response', 0)
    for (const entry of issuesValue) {
      if (!isRecord(entry)) throw new FusionApiError('malformed-response', 0)
      issues.push({ code: stringField(entry, 'code'), message: stringField(entry, 'message') })
    }
  }
  return { state, enabled: value['enabled'] === true, issues }
}

/**
 * Parse one system view.
 * @param value - decoded JSON.
 * @returns the system.
 */
function parseSystem(value: unknown): FusionSystem {
  if (!isRecord(value)) throw new FusionApiError('malformed-response', 0)
  const health = value['health'] === 'degraded' ? 'degraded' : 'ready'
  return { id: stringField(value, 'id'), name: stringField(value, 'name'), health }
}

/**
 * Parse one resource view.
 * @param value - decoded JSON.
 * @returns the resource.
 */
function parseResource(value: unknown): FusionResource {
  if (!isRecord(value)) throw new FusionApiError('malformed-response', 0)
  const locator = value['locator']
  if (!isRecord(locator)) throw new FusionApiError('malformed-response', 0)
  const resourceType = locator['resourceType']
  if (resourceType !== 'api' && resourceType !== 'source' && resourceType !== 'dataset' && resourceType !== 'log' && resourceType !== 'artifact') {
    throw new FusionApiError('malformed-response', 0)
  }
  const classification = value['classification']
  const normalizedClassification = classification === 'public' || classification === 'confidential' ? classification : 'internal'
  const version = locator['version']
  return {
    locator: {
      systemId: stringField(locator, 'systemId'),
      resourceType,
      resourceId: stringField(locator, 'resourceId'),
      ...(typeof version === 'string' ? { version } : {}),
    },
    name: stringField(value, 'name'),
    classification: normalizedClassification,
  }
}

/**
 * Parse one workspace.
 * @param value - decoded JSON.
 * @returns the workspace.
 */
function parseWorkspace(value: unknown): FusionWorkspace {
  if (!isRecord(value)) throw new FusionApiError('malformed-response', 0)
  return {
    id: stringField(value, 'id'),
    name: stringField(value, 'name'),
    createdAt: stringField(value, 'createdAt'),
  }
}

/**
 * Parse one job.
 * @param value - decoded JSON.
 * @returns the job.
 */
function parseJob(value: unknown): FusionJob {
  if (!isRecord(value)) throw new FusionApiError('malformed-response', 0)
  const status = value['status']
  if (status !== 'queued' && status !== 'running' && status !== 'succeeded' && status !== 'failed' && status !== 'cancelled') {
    throw new FusionApiError('malformed-response', 0)
  }
  const language = value['language'] === 'python' ? 'python' : 'shell'
  const startedAt = value['startedAt']
  const finishedAt = value['finishedAt']
  const errorCode = value['errorCode']
  const ids = value['inputSnapshotIds']
  const inputSnapshotIds: string[] = []
  if (Array.isArray(ids)) {
    for (const id of ids) if (typeof id === 'string') inputSnapshotIds.push(id)
  }
  return {
    id: stringField(value, 'id'),
    workspaceId: stringField(value, 'workspaceId'),
    status,
    inputSnapshotIds,
    language,
    createdAt: stringField(value, 'createdAt'),
    startedAt: typeof startedAt === 'string' ? startedAt : null,
    finishedAt: typeof finishedAt === 'string' ? finishedAt : null,
    errorCode: typeof errorCode === 'string' ? errorCode : null,
  }
}

/**
 * Parse one artifact.
 * @param value - decoded JSON.
 * @returns the artifact.
 */
function parseArtifact(value: unknown): FusionArtifact {
  if (!isRecord(value)) throw new FusionApiError('malformed-response', 0)
  return {
    id: stringField(value, 'id'),
    jobId: stringField(value, 'jobId'),
    workspaceId: stringField(value, 'workspaceId'),
    relativePath: stringField(value, 'relativePath'),
    sha256: stringField(value, 'sha256'),
    mime: stringField(value, 'mime'),
    size: numberField(value, 'size'),
  }
}

/**
 * Decode one successful JSON response.
 * @param response - fetch response.
 * @returns the parsed JSON value.
 */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new FusionApiError('malformed-response', response.status)
  }
}

/**
 * Build one error from a non-success response.
 * @param response - fetch response.
 * @returns the API error.
 */
async function readError(response: Response): Promise<FusionApiError> {
  const body: unknown = await response.json().catch(() => undefined)
  if (isRecord(body) && isRecord(body['error']) && typeof body['error']['code'] === 'string') {
    return new FusionApiError(body['error']['code'], response.status)
  }
  return new FusionApiError(`http-${String(response.status)}`, response.status)
}

/**
 * Perform one same-origin fusion request.
 * @param transport - transport seam.
 * @param path - path below the fusion prefix.
 * @param method - HTTP method.
 * @param body - JSON body for mutations.
 * @returns the decoded JSON value, or undefined for 204.
 */
async function request(
  transport: FusionTransport,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (method === 'POST') {
    const csrf = transport.cookie(CSRF_COOKIE)
    if (csrf !== undefined) headers['x-csrf-token'] = csrf
  }
  let response: Response
  try {
    response = await transport.fetch(`${PREFIX}${path}`, {
      method,
      credentials: 'same-origin',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch {
    throw new FusionApiError('unavailable', 0)
  }
  if (!response.ok) throw await readError(response)
  if (response.status === 204) return undefined
  return await readJson(response)
}

/**
 * Read the fusion status; `undefined` means this deployment has no fusion API.
 * @param transport - transport seam.
 * @returns the status, or undefined when disabled at the deployment level.
 */
export async function loadFusionStatus(transport: FusionTransport): Promise<FusionStatus | undefined> {
  let response: Response
  try {
    response = await transport.fetch(`${PREFIX}/status`, { credentials: 'same-origin' })
  } catch {
    return undefined
  }
  if (response.status === 404) return undefined
  if (!response.ok) throw await readError(response)
  return parseStatus(await readJson(response))
}

/**
 * Read the systems, workspaces, and jobs shown when the workbench opens.
 * @param transport - transport seam.
 * @returns the overview.
 */
export async function loadOverview(transport: FusionTransport): Promise<FusionOverview> {
  const status = await loadFusionStatus(transport)
  if (status === undefined) throw new FusionApiError('unavailable', 404)
  if (status.state !== 'ready') {
    return { status, systems: [], workspaces: [], jobs: [] }
  }
  const [systemsValue, workspacesValue, jobsValue] = await Promise.all([
    request(transport, '/systems', 'GET'),
    request(transport, '/workspaces', 'GET'),
    request(transport, '/jobs', 'GET'),
  ])
  const systems: FusionSystem[] = []
  if (isRecord(systemsValue) && Array.isArray(systemsValue['systems'])) {
    for (const entry of systemsValue['systems']) systems.push(parseSystem(entry))
  }
  const workspaces: FusionWorkspace[] = []
  if (isRecord(workspacesValue) && Array.isArray(workspacesValue['workspaces'])) {
    for (const entry of workspacesValue['workspaces']) workspaces.push(parseWorkspace(entry))
  }
  const jobs: FusionJob[] = []
  if (isRecord(jobsValue) && Array.isArray(jobsValue['jobs'])) {
    for (const entry of jobsValue['jobs']) jobs.push(parseJob(entry))
  }
  return { status, systems, workspaces, jobs }
}

/**
 * List the actor's authorized resources for one system.
 * @param transport - transport seam.
 * @param systemId - registered system id.
 * @returns the resource page.
 */
export async function loadResources(transport: FusionTransport, systemId: string): Promise<FusionResourcePage> {
  const value = await request(transport, `/resources?systemId=${encodeURIComponent(systemId)}`, 'GET')
  if (!isRecord(value) || !Array.isArray(value['items'])) throw new FusionApiError('malformed-response', 0)
  const items = value['items'].map(entry => parseResource(entry))
  const nextCursor = value['nextCursor']
  return { items, nextCursor: typeof nextCursor === 'string' ? nextCursor : null }
}

/**
 * Capture one immutable resource snapshot.
 * @param transport - transport seam.
 * @param resource - authorized resource.
 * @returns the snapshot.
 */
export async function captureSnapshot(transport: FusionTransport, resource: FusionResource): Promise<FusionSnapshot> {
  const value = await request(transport, '/snapshots', 'POST', {
    systemId: resource.locator.systemId,
    resourceId: resource.locator.resourceId,
    resourceType: resource.locator.resourceType,
    ...(resource.locator.version === undefined ? {} : { version: resource.locator.version }),
  })
  if (!isRecord(value) || !isRecord(value['snapshot'])) throw new FusionApiError('malformed-response', 0)
  const snapshot = value['snapshot']
  const locator = snapshot['locator']
  if (!isRecord(locator)) throw new FusionApiError('malformed-response', 0)
  return {
    id: stringField(snapshot, 'id'),
    locator: resource.locator,
    sha256: stringField(snapshot, 'sha256'),
    sourceVersion: stringField(snapshot, 'sourceVersion'),
    classification: stringField(snapshot, 'classification'),
    size: numberField(snapshot, 'size'),
  }
}

/**
 * Create one analysis workspace.
 * @param transport - transport seam.
 * @param name - display name.
 * @returns the workspace.
 */
export async function createWorkspace(transport: FusionTransport, name: string): Promise<FusionWorkspace> {
  const value = await request(transport, '/workspaces', 'POST', { name })
  if (!isRecord(value) || !isRecord(value['workspace'])) throw new FusionApiError('malformed-response', 0)
  return parseWorkspace(value['workspace'])
}

/**
 * Start one analysis job.
 * @param transport - transport seam.
 * @param input - workspace, snapshots, language, and script.
 * @returns the queued job.
 */
export async function startJob(
  transport: FusionTransport,
  input: {
    readonly workspaceId: string
    readonly inputSnapshotIds: readonly string[]
    readonly language: 'shell' | 'python'
    readonly script: string
  },
): Promise<FusionJob> {
  const value = await request(transport, '/jobs', 'POST', input)
  if (!isRecord(value) || !isRecord(value['job'])) throw new FusionApiError('malformed-response', 0)
  return parseJob(value['job'])
}

/**
 * Read one job and its artifacts.
 * @param transport - transport seam.
 * @param jobId - job id.
 * @returns the job view.
 */
export async function loadJob(transport: FusionTransport, jobId: string): Promise<FusionJobView> {
  const value = await request(transport, `/jobs/${encodeURIComponent(jobId)}`, 'GET')
  if (!isRecord(value) || !isRecord(value['job'])) throw new FusionApiError('malformed-response', 0)
  const artifacts: FusionArtifact[] = []
  if (Array.isArray(value['artifacts'])) {
    for (const entry of value['artifacts']) artifacts.push(parseArtifact(entry))
  }
  return { job: parseJob(value['job']), artifacts }
}

/**
 * Cancel one queued or running job.
 * @param transport - transport seam.
 * @param jobId - job id.
 * @returns the updated job.
 */
export async function cancelJob(transport: FusionTransport, jobId: string): Promise<FusionJob> {
  const value = await request(transport, `/jobs/${encodeURIComponent(jobId)}/cancel`, 'POST', {})
  if (!isRecord(value) || !isRecord(value['job'])) throw new FusionApiError('malformed-response', 0)
  return parseJob(value['job'])
}

/**
 * Build one download URL.
 * @param artifactId - artifact id.
 * @returns the same-origin path.
 */
export function artifactDownloadPath(artifactId: string): string {
  return `${PREFIX}/artifacts/${encodeURIComponent(artifactId)}/download`
}
