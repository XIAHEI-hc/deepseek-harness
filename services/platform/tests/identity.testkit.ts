/**
 * Shared fixtures for the identity service tests.
 *
 * Every fixture owns a temporary data directory, a controllable clock, a copyable
 * cookie-jar browser harness, and an optional fake W3 provider built on a local
 * `node:http` server, so no test reaches the network. All created records and
 * servers are released from the `afterEach(cleanupIdentityTests)` hook each spec
 * file installs, in reverse creation order.
 *
 * @module @deepseek-ai/dsh-platform-services/tests/identity.testkit
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createPlatformConfig } from '../src/config.ts'
import type { IdentityConfig, W3Config } from '../src/config.ts'
import type {
  IdentityService,
  PlatformHttpRequest,
  PlatformHttpResult,
  SetCookie,
} from '../src/contracts.ts'
import { createIdentityService } from '../src/identity/index.ts'

/** Origin the cookie-jar browser presents in request URLs. */
export const TEST_ORIGIN = 'http://platform.test'

/** Release callbacks registered by fixtures, run in reverse order. */
const pendingCleanups: Array<() => Promise<void> | void> = []

/**
 * Register work released by {@link cleanupIdentityTests}.
 * @param cleanup - release callback, run in reverse registration order.
 */
export function registerCleanup(cleanup: () => Promise<void> | void): void {
  pendingCleanups.push(cleanup)
}

/** Close every service and fake provider and delete every temporary directory. */
export async function cleanupIdentityTests(): Promise<void> {
  while (pendingCleanups.length > 0) {
    const cleanup = pendingCleanups.pop()
    if (cleanup === undefined) continue
    await cleanup()
  }
}

/** Epoch-millisecond clock an identity service can be injected with. */
export class TestClock {
  /** Current epoch milliseconds. */
  private current: number

  /**
   * @param initial - starting epoch milliseconds; defaults to 2026-01-15T08:00:00Z.
   */
  constructor(initial: number = Date.UTC(2026, 0, 15, 8, 0, 0)) {
    this.current = initial
  }

  /**
   * @returns the current epoch milliseconds.
   */
  read(): number {
    return this.current
  }

  /**
   * Advance the clock.
   * @param milliseconds - amount to advance by.
   * @returns the new current epoch milliseconds.
   */
  advance(milliseconds: number): number {
    this.current += milliseconds
    return this.current
  }
}

/** One temporary identity deployment used by a test. */
export interface TestIdentityFixture {
  /** Temporary platform data directory. */
  readonly dataDir: string
  /** Identity configuration pointed at the temporary directory. */
  readonly config: IdentityConfig
  /** Delete the directory; registered for {@link cleanupIdentityTests}. */
  cleanup(): void
}

/**
 * Create a temporary identity configuration.
 * @param overrides - identity fields replacing the testing defaults.
 * @returns the fixture, whose directory is registered for cleanup.
 */
export function createTestIdentity(overrides: Partial<IdentityConfig> = {}): TestIdentityFixture {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-identity-'))
  const platform = createPlatformConfig({ appEnv: 'testing', dataDir, identity: overrides })
  const fixture: TestIdentityFixture = {
    dataDir,
    config: { ...platform.identity, dataDir },
    cleanup: () => {
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
  registerCleanup(fixture.cleanup)
  return fixture
}

/** A started identity service and the clock it was given. */
export interface RunningIdentity {
  /** Started service. */
  readonly service: IdentityService
  /** Clock the service reads. */
  readonly clock: TestClock
}

/**
 * Start one identity service over a fixture's database.
 * @param fixture - temporary identity configuration.
 * @param options - clock and fetch overrides.
 * @returns the service and its clock; cleanup closes the service.
 */
export async function startIdentity(
  fixture: TestIdentityFixture,
  options: { clock?: TestClock | undefined; fetch?: typeof fetch | undefined } = {},
): Promise<RunningIdentity> {
  const clock = options.clock ?? new TestClock()
  const service = await createIdentityService(fixture.config, {
    now: () => clock.read(),
    fetch: options.fetch,
  })
  registerCleanup(async () => {
    await service.close()
  })
  return { service, clock }
}

/** One response plus a snapshot of the request that produced it. */
export interface BrowserExchange {
  /** Result returned by the identity service. */
  readonly result: PlatformHttpResult | undefined
  /** Raw request that was handed to the service. */
  readonly request: PlatformHttpRequest
}

/** Cookie-jar browser driving one identity service. */
export class TestBrowser {
  /** Cookies the browser currently holds. */
  private readonly cookies = new Map<string, SetCookie>()
  /** Service under test. */
  private readonly service: IdentityService
  /** Configuration naming the cookies the browser stores. */
  private readonly config: IdentityConfig

  /**
   * @param service - identity service under test.
   * @param config - identity configuration naming the cookies to keep.
   */
  constructor(service: IdentityService, config: IdentityConfig) {
    this.service = service
    this.config = config
  }

  /**
   * Send one request.
   * @param method - HTTP method.
   * @param path - path plus query string relative to {@link TEST_ORIGIN}.
   * @param options - extra headers and raw body.
   * @returns the identity response, or undefined outside the identity surface.
   */
  async request(
    method: string,
    path: string,
    options: { headers?: Record<string, string>; body?: string; clientAddress?: string } = {},
  ): Promise<PlatformHttpResult | undefined> {
    const url = new URL(path, TEST_ORIGIN)
    const request: PlatformHttpRequest = {
      method,
      url,
      headers: options.headers ?? {},
      cookies: this.collectCookies(url.pathname),
      body: options.body,
      clientAddress: options.clientAddress ?? '127.0.0.1',
    }
    const result = await this.service.handle(request)
    if (result !== undefined) this.storeCookies(result.cookies)
    return result
  }

  /**
   * Send a GET request.
   * @param path - path plus query string.
   * @param options - extra headers.
   * @returns the identity response, or undefined outside the identity surface.
   */
  get(path: string, options: { headers?: Record<string, string>; clientAddress?: string } = {}): Promise<PlatformHttpResult | undefined> {
    return this.request('GET', path, options)
  }

  /**
   * Send a POST request.
   * @param path - path plus query string.
   * @param options - extra headers and raw body.
   * @returns the identity response, or undefined outside the identity surface.
   */
  post(
    path: string,
    options: { headers?: Record<string, string>; body?: string; clientAddress?: string } = {},
  ): Promise<PlatformHttpResult | undefined> {
    return this.request('POST', path, options)
  }

  /**
   * Read the raw session cookie.
   * @returns the session token, or undefined when the browser has no session.
   */
  sessionToken(): string | undefined {
    return this.cookieValue(this.config.sessionCookieName)
  }

  /**
   * Read the raw CSRF cookie.
   * @returns the CSRF token, or undefined when the browser has no session.
   */
  csrfToken(): string | undefined {
    return this.cookieValue(this.config.csrfCookieName)
  }

  /**
   * Read one cookie value.
   * @param name - cookie name.
   * @returns the raw value, or undefined when the browser does not hold the cookie.
   */
  cookieValue(name: string): string | undefined {
    return this.cookies.get(name)?.value
  }

  /**
   * Synthesize a cookie, such as a nonce copied from another browser.
   * @param cookie - cookie to place in the jar.
   */
  setCookie(cookie: SetCookie): void {
    this.cookies.set(cookie.name, cookie)
  }

  /**
   * Collect the cookies a request path sends.
   * @param pathname - request path.
   * @returns cookie values keyed by name.
   */
  private collectCookies(pathname: string): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [name, cookie] of this.cookies) {
      if (cookiePathMatches(pathname, cookie.path ?? '/')) result[name] = cookie.value
    }
    return result
  }

  /**
   * Apply the cookies one response set.
   * @param cookies - cookies from the response, if any.
   */
  private storeCookies(cookies: readonly SetCookie[] | undefined): void {
    if (cookies === undefined) return
    for (const cookie of cookies) {
      if (cookie.maxAgeSeconds === 0) this.cookies.delete(cookie.name)
      else this.cookies.set(cookie.name, cookie)
    }
  }
}

/**
 * Test whether a request path carries a cookie for its path attribute.
 * @param pathname - request path.
 * @param cookiePath - cookie path attribute.
 * @returns true when the cookie applies to the request.
 */
function cookiePathMatches(pathname: string, cookiePath: string): boolean {
  if (pathname === cookiePath) return true
  if (!pathname.startsWith(cookiePath)) return false
  return cookiePath.endsWith('/') || pathname.charAt(cookiePath.length) === '/'
}

/**
 * Create a browser bound to one identity service.
 * @param fixture - fixture supplying the cookie names.
 * @param service - identity service under test.
 * @returns a fresh cookie-jar browser.
 */
export function newBrowser(fixture: TestIdentityFixture, service: IdentityService): TestBrowser {
  return new TestBrowser(service, fixture.config)
}

/**
 * Require a response for a request that belongs to the identity surface.
 * @param result - result returned by the browser.
 * @returns the non-undefined result.
 */
export function requireResult(result: PlatformHttpResult | undefined): PlatformHttpResult {
  if (result === undefined) throw new Error('identity service returned no result for an identity path')
  return result
}

/**
 * Read a JSON object response body.
 * @param result - identity response carrying a JSON object body.
 * @returns the decoded object.
 */
export function jsonObject(result: PlatformHttpResult): Record<string, unknown> {
  if (result.body === undefined) throw new Error('identity response had no body')
  const parsed: unknown = JSON.parse(result.body)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('identity response body was not a JSON object')
  }
  return parsed as Record<string, unknown>
}

/**
 * Read the stable code of a JSON error response body.
 * @param result - identity response carrying `{ error: { code } }`.
 * @returns the machine code.
 */
export function errorCodeOf(result: PlatformHttpResult): string {
  const error = jsonObject(result)['error']
  if (typeof error !== 'object' || error === null) throw new Error('identity error body had no error object')
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string') throw new Error('identity error body had no string code')
  return code
}

/** User facts as returned by `/auth/me` and `/internal/introspect`. */
export interface TestUserBody {
  /** Internal user id. */
  readonly id: string
  /** Stable W3 subject. */
  readonly subject: string
  /** W3 account identifier. */
  readonly uid: string
  /** Display name. */
  readonly displayName: string
  /** Email address, or null. */
  readonly email: string | null
}

/**
 * Read the `user` object of an identity response.
 * @param result - identity response carrying a JSON `user` object.
 * @returns the user facts.
 */
export function userOf(result: PlatformHttpResult): TestUserBody {
  const user = jsonObject(result)['user']
  if (typeof user !== 'object' || user === null) throw new Error('identity response had no user object')
  return user as TestUserBody
}

/**
 * Find one cookie by name in a response.
 * @param cookies - cookies set by a response, if any.
 * @param name - cookie name.
 * @returns the cookie, or undefined when the response did not set it.
 */
export function findCookie(
  cookies: readonly SetCookie[] | undefined,
  name: string,
): SetCookie | undefined {
  return cookies?.find(cookie => cookie.name === name)
}

/** One HTTP call a fake W3 provider recorded. */
export interface RecordedW3Call {
  /** HTTP method. */
  readonly method: string
  /** Request path, without the query string. */
  readonly path: string
  /** Raw `content-type` request header. */
  readonly contentType: string
  /** Raw UTF-8 request body. */
  readonly body: string
}

/** Local stand-in for the W3 token and user-info endpoints. */
export interface FakeW3Provider {
  /** Base URL the provider listens on. */
  readonly url: string
  /** Calls recorded by the provider, in arrival order. */
  readonly calls: RecordedW3Call[]
  /** Status the next token response uses. */
  tokenStatus: number
  /** Content type the next token response uses. */
  tokenContentType: string
  /** Body the next token response carries. */
  tokenBody: string
  /** Status the next user-info response uses. */
  userinfoStatus: number
  /** Content type the next user-info response uses. */
  userinfoContentType: string
  /** Body the next user-info response carries. */
  userinfoBody: string
  /** Stop the provider; idempotent. */
  close(): Promise<void>
}

/** Mutable response settings shared by a fake provider and its server. */
interface FakeW3State {
  tokenStatus: number
  tokenContentType: string
  tokenBody: string
  userinfoStatus: number
  userinfoContentType: string
  userinfoBody: string
}

/**
 * Start a fake W3 provider on a loopback port.
 * @returns the provider; cleanup stops it.
 */
export async function startFakeW3(): Promise<FakeW3Provider> {
  const state: FakeW3State = {
    tokenStatus: 200,
    tokenContentType: 'application/json',
    tokenBody: JSON.stringify({ access_token: 'test-access-token', token_type: 'Bearer' }),
    userinfoStatus: 200,
    userinfoContentType: 'application/json',
    userinfoBody: JSON.stringify({
      uuid: 'w3-uuid-001',
      uid: 'worker-001',
      displayName: 'W3 测试用户',
      email: 'worker@example.com',
    }),
  }
  const calls: RecordedW3Call[] = []
  const server = createServer((request, response) => {
    handleW3Request(request, response, calls, state)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    await closeServer(server)
    throw new Error('fake W3 provider did not bind a TCP port')
  }
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await closeServer(server)
  }
  const provider: FakeW3Provider = {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    get tokenStatus() {
      return state.tokenStatus
    },
    set tokenStatus(value: number) {
      state.tokenStatus = value
    },
    get tokenContentType() {
      return state.tokenContentType
    },
    set tokenContentType(value: string) {
      state.tokenContentType = value
    },
    get tokenBody() {
      return state.tokenBody
    },
    set tokenBody(value: string) {
      state.tokenBody = value
    },
    get userinfoStatus() {
      return state.userinfoStatus
    },
    set userinfoStatus(value: number) {
      state.userinfoStatus = value
    },
    get userinfoContentType() {
      return state.userinfoContentType
    },
    set userinfoContentType(value: string) {
      state.userinfoContentType = value
    },
    get userinfoBody() {
      return state.userinfoBody
    },
    set userinfoBody(value: string) {
      state.userinfoBody = value
    },
    close,
  }
  registerCleanup(close)
  return provider
}

/**
 * Record one fake W3 request and answer it from the current state.
 * @param request - incoming request.
 * @param response - outgoing response.
 * @param calls - call log to append to.
 * @param state - current response settings.
 */
function handleW3Request(
  request: IncomingMessage,
  response: ServerResponse,
  calls: RecordedW3Call[],
  state: FakeW3State,
): void {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
  })
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    const path = (request.url ?? '/').split('?')[0] ?? '/'
    const contentType = request.headers['content-type'] ?? ''
    calls.push({ method: request.method ?? 'GET', path, contentType, body })
    if (path === '/token') {
      sendResponse(response, state.tokenStatus, state.tokenContentType, state.tokenBody)
      return
    }
    if (path === '/userinfo') {
      sendResponse(response, state.userinfoStatus, state.userinfoContentType, state.userinfoBody)
      return
    }
    sendResponse(response, 404, 'text/plain', 'not found')
  })
}

/**
 * Write one fake W3 response.
 * @param response - outgoing response.
 * @param status - HTTP status.
 * @param contentType - content-type header.
 * @param body - response body.
 */
function sendResponse(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  response.statusCode = status
  response.setHeader('content-type', contentType)
  response.end(body)
}

/**
 * Close one HTTP server.
 * @param server - server to close.
 */
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error !== undefined) reject(error)
      else resolve()
    })
  })
}

/**
 * Filter the fake provider's call log by request path.
 * @param provider - fake W3 provider.
 * @param path - request path, such as `/token`.
 * @returns the recorded calls to that path.
 */
export function w3CallsTo(provider: FakeW3Provider, path: string): readonly RecordedW3Call[] {
  return provider.calls.filter(call => call.path === path)
}

/**
 * Build W3 configuration pointed at a fake provider.
 * @param provider - fake W3 provider.
 * @param overrides - W3 fields replacing the contract defaults.
 * @returns W3 provider configuration for a testing identity service.
 */
export function w3Config(provider: FakeW3Provider, overrides: Partial<W3Config> = {}): W3Config {
  const defaults: W3Config = {
    clientId: 'dsh-client-id',
    clientSecret: 'dsh-client-secret',
    authorizeUrl: `${provider.url}/authorize?tenant=acme&response_type=token`,
    tokenUrl: `${provider.url}/token`,
    userinfoUrl: `${provider.url}/userinfo`,
    logoutUrl: 'https://w3.test/logout',
    redirectUri: `${TEST_ORIGIN}/auth/callback`,
    scope: 'base.profile',
    tokenRequestFormat: 'json',
  }
  return { ...defaults, ...overrides }
}

/**
 * Open a second connection to a fixture's identity database for assertions.
 * @param dataDir - platform data directory.
 * @returns the open database; the caller closes it (or registers cleanup).
 */
export function openIdentityDatabase(dataDir: string): DatabaseSync {
  return new DatabaseSync(join(dataDir, 'identity.sqlite'))
}

/** Tables a test may count. */
export type IdentityTable =
  | 'dsh_users'
  | 'dsh_sessions'
  | 'dsh_oauth_states'
  | 'dsh_audit_events'
  | 'schema_migrations'

/**
 * Count the rows of one identity table.
 * @param database - open identity database.
 * @param table - table to count.
 * @returns the row count.
 */
export function countRows(database: DatabaseSync, table: IdentityTable): number {
  const row = database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()
  const total = row?.['total']
  if (typeof total !== 'number') {
    throw new Error(`identity test database returned no count for ${table}`)
  }
  return total
}
