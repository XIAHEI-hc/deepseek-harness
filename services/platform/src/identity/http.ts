/**
 * HTTP surface of the identity service.
 *
 * `handle` owns `/auth/*` and `/internal/*` and returns undefined for every other
 * path so the gateway keeps routing it to the native DSH runtime. The W3 callback
 * follows the reference implementation: an unusable login transaction answers
 * 400 `login-state-invalid`, a provider denial or failed exchange redirects to
 * `/login?error=w3_denied`, and only a complete login sets the session cookies.
 *
 * @module @deepseek-ai/dsh-platform-services/identity/http
 */

import type {
  IdentityFailureCode,
  IdentityService,
  PlatformHeaders,
  PlatformHttpRequest,
  PlatformHttpResult,
  PlatformUser,
  SessionLookup,
  SetCookie,
  ValidatedSession,
} from '../contracts.ts'
import type { IdentityConfig } from '../config.ts'
import { IdentityError } from './errors.ts'
import { syncMockUser } from './mock.ts'
import {
  clearedLoginNonceCookie,
  clearedSessionCookies,
  constantTimeEquals,
  consumeLoginState,
  createLoginState,
  createSession,
  digest,
  loginNonceCookie,
  parseIso,
  safeReturnTo,
  sessionCookies,
  SESSION_REFRESH_INTERVAL_MS,
  syncUser,
  toIso,
  toPlatformUser,
  W3_DENIED_LOCATION,
} from './security.ts'
import { IdentityStore, type AuditEventInput } from './store.ts'
import { openIdentityDatabase } from '../storage/open.ts'
import { LoginRateLimiter } from './ratelimit.ts'
import { authorizeUrl, exchangeW3Profile } from './w3.ts'

/** Methods the identity surface accepts per path. */
const ROUTE_METHODS: Readonly<Record<string, string>> = {
  '/auth/health': 'GET',
  '/auth/login': 'GET',
  '/auth/callback': 'GET',
  '/auth/me': 'GET',
  '/auth/logout': 'POST',
  '/auth/logout-all': 'POST',
  '/internal/introspect': 'POST',
}

/** Request header that confirms a deliberate all-device logout. */
const LOGOUT_ALL_CONFIRMATION = 'logout-all'

/** JSON response headers shared by every JSON result. */
const JSON_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json; charset=utf-8',
}

/** Creation options for {@link createIdentityService}. */
export interface CreateIdentityServiceOptions {
  /** Fetch implementation for W3 requests; defaults to the global fetch. */
  readonly fetch?: typeof fetch | undefined
  /** Clock returning epoch milliseconds; tests inject a controllable one. */
  readonly now?: (() => number) | undefined
}

/**
 * Resolve one request header case-insensitively.
 * @param headers - request header map.
 * @param name - header name to look up.
 * @returns the first header value, or undefined when absent.
 */
function headerValue(headers: PlatformHeaders, name: string): string | undefined {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue
    if (Array.isArray(value)) {
      const first: unknown = value[0]
      return typeof first === 'string' ? first : undefined
    }
    if (typeof value === 'string') return value
    return undefined
  }
  return undefined
}

/**
 * Test whether an optional query parameter carries a value.
 * @param value - decoded query parameter.
 * @returns true when the parameter is present and non-empty.
 */
function isPresent(value: string | null): value is string {
  return value !== null && value !== ''
}

/**
 * Decode a small JSON object request body.
 * @param body - buffered body text from the transport.
 * @returns the decoded object, or undefined when absent or malformed.
 */
function readJsonObject(body: string | undefined): Record<string, unknown> | undefined {
  if (body === undefined || body === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    // A malformed internal body cannot name a session; the caller reports an invalid session.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}

/**
 * Build one JSON result.
 * @param status - HTTP status.
 * @param payload - JSON-serializable payload.
 * @returns the HTTP result.
 */
function jsonResult(status: number, payload: unknown): PlatformHttpResult {
  return { status, headers: JSON_HEADERS, body: JSON.stringify(payload) }
}

/**
 * Build one JSON error result with a stable machine code.
 * @param status - HTTP status.
 * @param code - stable identity failure code.
 * @returns the HTTP result.
 */
function errorResult(status: number, code: IdentityFailureCode): PlatformHttpResult {
  return jsonResult(status, { error: { code } })
}

/**
 * Build one redirect result.
 * @param location - absolute or same-site Location header value.
 * @param cookies - cookies to set alongside the redirect.
 * @returns the HTTP result.
 */
function redirectResult(
  location: string,
  cookies: readonly SetCookie[],
): PlatformHttpResult {
  return { status: 302, headers: { location }, cookies }
}

/**
 * Project a validated user onto its JSON response form.
 * @param user - validated platform user.
 * @returns the JSON user object.
 */
function userJson(user: PlatformUser): Readonly<Record<string, string | null>> {
  return {
    id: user.id,
    subject: user.subject,
    uid: user.uid,
    displayName: user.displayName,
    email: user.email,
  }
}

/**
 * Record one stable failure marker without any sensitive value.
 * @param code - stable code naming the failed stage.
 */
function logStableFailure(code: string): void {
  console.warn(`identity: ${code}`)
}

/** Identity service implementation backed by one SQLite store. */
class IdentityHttpService implements IdentityService {
  /** Authentication mode this instance runs in. */
  readonly mode: 'mock' | 'w3'
  /** Identity configuration. */
  private readonly config: IdentityConfig
  /** Open identity database. */
  private readonly store: IdentityStore
  /** Epoch-millisecond clock. */
  private readonly clock: () => number
  /** Fetch implementation used for W3 requests. */
  private readonly fetchImpl: typeof fetch | undefined
  /** Per-address login-attempt limiter. */
  private readonly loginLimiter: LoginRateLimiter

  /**
   * @param config - identity configuration.
   * @param store - open identity database.
   * @param clock - epoch-millisecond clock.
   * @param fetchImpl - fetch override for W3 requests.
   */
  constructor(
    config: IdentityConfig,
    store: IdentityStore,
    clock: () => number,
    fetchImpl: typeof fetch | undefined,
  ) {
    this.config = config
    this.store = store
    this.clock = clock
    this.fetchImpl = fetchImpl
    this.mode = config.mode
    this.loginLimiter = new LoginRateLimiter(config.loginRateLimit, clock)
  }

  /**
   * Append one audit event with the service clock.
   * @param input - event facts without a timestamp.
   */
  private audit(input: AuditEventInput): void {
    this.store.appendAudit(input, toIso(this.clock()))
  }

  /**
   * Handle one identity-surface request.
   * @param request - method, URL, headers, parsed cookies, and optional buffered body.
   * @returns the response, or undefined when the path is outside the identity surface.
   */
  async handle(request: PlatformHttpRequest): Promise<PlatformHttpResult | undefined> {
    const pathname = request.url.pathname
    const expectedMethod = ROUTE_METHODS[pathname]
    if (expectedMethod === undefined) return undefined
    if (request.method.toUpperCase() !== expectedMethod) return errorResult(404, 'not-found')
    switch (pathname) {
      case '/auth/health':
        return jsonResult(200, { ok: true, mode: this.config.mode })
      case '/auth/login':
        return this.login(request)
      case '/auth/callback':
        return this.callback(request)
      case '/auth/me':
        return this.me(request)
      case '/auth/logout':
        return this.logout(request)
      case '/auth/logout-all':
        return this.logoutAll(request)
      case '/internal/introspect':
        return this.introspect(request)
      default:
        return undefined
    }
  }

  /**
   * Resolve a session token to the authenticated identity.
   *
   * Expired sessions and revoked accounts are revoked in the database on first
   * observation so a later lookup cannot resurrect them. Activity refreshes are
   * written at most once per {@link SESSION_REFRESH_INTERVAL_MS} and never past
   * the absolute expiry.
   * @param sessionToken - raw session cookie token, or undefined when absent.
   * @returns the admitted session or the reason it is refused.
   */
  async authenticate(sessionToken: string | undefined): Promise<SessionLookup> {
    if (sessionToken === undefined || sessionToken === '') {
      return { ok: false, code: 'no-session' }
    }
    const found = this.store.findSessionByTokenHash(digest(sessionToken))
    if (found === undefined) return { ok: false, code: 'session-invalid' }
    const { session, user } = found
    if (session.revokedAt !== null) return { ok: false, code: 'session-revoked' }
    const nowMs = this.clock()
    const expiresAt = parseIso(session.expiresAt)
    const absoluteExpiresAt = parseIso(session.absoluteExpiresAt)
    const expired = expiresAt <= nowMs || absoluteExpiresAt <= nowMs
    const accountInactive =
      user.status !== 'active' || user.permissionVersion !== session.permissionVersion
    if (expired || accountInactive) {
      this.store.revokeSession(session.id, toIso(nowMs))
      return { ok: false, code: expired ? 'session-expired' : 'account-disabled' }
    }
    let effectiveExpiresAt = expiresAt
    if (nowMs - parseIso(session.lastSeenAt) >= SESSION_REFRESH_INTERVAL_MS) {
      effectiveExpiresAt = Math.min(nowMs + this.config.idleTimeoutMs, absoluteExpiresAt)
      this.store.updateSessionActivity(session.id, toIso(nowMs), toIso(effectiveExpiresAt))
    }
    return {
      ok: true,
      session: {
        user: toPlatformUser(user),
        sessionId: session.id,
        permissionVersion: session.permissionVersion,
        expiresAt: effectiveExpiresAt,
        absoluteExpiresAt,
      },
    }
  }

  /**
   * Verify a state-changing request's CSRF token against its session.
   * @param session - the already validated session.
   * @param csrfHeader - `x-csrf-token` request header, or undefined.
   * @param csrfCookie - CSRF cookie value, or undefined.
   * @returns true only when the header, cookie, and stored hash agree.
   */
  verifyCsrf(
    session: ValidatedSession,
    csrfHeader: string | undefined,
    csrfCookie: string | undefined,
  ): boolean {
    if (
      csrfHeader === undefined ||
      csrfCookie === undefined ||
      csrfHeader === '' ||
      csrfCookie === ''
    ) {
      return false
    }
    if (!constantTimeEquals(csrfHeader, csrfCookie)) return false
    const stored = this.store.findSessionById(session.sessionId)
    if (stored === undefined || stored.revokedAt !== null) return false
    return constantTimeEquals(digest(csrfCookie), stored.csrfTokenHash)
  }

  /** Release the database handle. */
  async close(): Promise<void> {
    this.store.close()
  }

  /**
   * Start a login.
   * @param request - login request; only `return_to` is read.
   * @returns a Mock redirect with session cookies, or a W3 authorize redirect.
   */
  private async login(request: PlatformHttpRequest): Promise<PlatformHttpResult> {
    const returnTo = safeReturnTo(request.url.searchParams.get('return_to'))
    const address = request.clientAddress ?? 'unknown'
    if (!this.loginLimiter.allow(address)) {
      this.audit({ action: 'login', outcome: 'rate-limited', clientAddress: address })
      return {
        status: 429,
        headers: { ...JSON_HEADERS, 'retry-after': String(this.loginLimiter.retryAfterSeconds(address)) },
        body: JSON.stringify({ error: { code: 'rate-limited' } }),
      }
    }
    if (this.config.mode === 'mock') {
      try {
        const user = syncMockUser(this.config, this.store, this.clock())
        const credentials = createSession(this.config, this.store, user, this.clock())
        this.audit({
          action: 'login',
          outcome: 'success',
          userId: user.id,
          subject: user.subject,
          clientAddress: address,
          detail: { mode: 'mock' },
        })
        return redirectResult(returnTo, sessionCookies(this.config, credentials))
      } catch (error) {
        if (error instanceof IdentityError) return errorResult(error.status, error.code)
        throw error
      }
    }
    const loginState = createLoginState(this.config, this.store, returnTo, this.clock())
    this.audit({ action: 'login.start', outcome: 'redirect', clientAddress: address, detail: { mode: 'w3' } })
    return redirectResult(authorizeUrl(this.config.w3, loginState.state), [
      loginNonceCookie(this.config, loginState.nonce),
    ])
  }

  /**
   * Complete a W3 login.
   * @param request - callback request carrying code, state, error, and the nonce cookie.
   * @returns a redirect to the stored return path, the login page error marker, or a 400.
   */
  private async callback(request: PlatformHttpRequest): Promise<PlatformHttpResult> {
    if (this.config.mode !== 'w3') return errorResult(404, 'not-found')
    const code = request.url.searchParams.get('code')
    const state = request.url.searchParams.get('state')
    const providerError = request.url.searchParams.get('error')
    const nonce = request.cookies[this.config.loginNonceCookieName]
    const address = request.clientAddress ?? 'unknown'
    const denied = (): PlatformHttpResult => {
      this.audit({ action: 'login', outcome: 'denied', clientAddress: address, detail: { mode: 'w3' } })
      return redirectResult(W3_DENIED_LOCATION, [clearedLoginNonceCookie(this.config)])
    }
    if ((providerError !== null && providerError !== '') || !isPresent(code) || !isPresent(state)) {
      if (isPresent(state) && nonce !== undefined && nonce !== '') {
        // Burn a transaction the provider denied or the request corrupted; an
        // unusable state stays unusable and provider text is never inspected.
        consumeLoginState(this.store, state, nonce, this.clock())
      }
      return denied()
    }
    const loginState = consumeLoginState(this.store, state, nonce, this.clock())
    if (loginState === undefined) {
      this.audit({ action: 'login', outcome: 'invalid-state', clientAddress: address })
      return errorResult(400, 'login-state-invalid')
    }
    try {
      const profile = await exchangeW3Profile(this.config.w3, code, { fetch: this.fetchImpl })
      const user = syncUser(this.store, profile, this.clock())
      const credentials = createSession(this.config, this.store, user, this.clock())
      this.audit({
        action: 'login',
        outcome: 'success',
        userId: user.id,
        subject: user.subject,
        clientAddress: address,
        detail: { mode: 'w3' },
      })
      return redirectResult(loginState.returnTo, [
        ...sessionCookies(this.config, credentials),
        clearedLoginNonceCookie(this.config),
      ])
    } catch (error) {
      if (!(error instanceof IdentityError)) logStableFailure('identity-callback-failed')
      this.audit({ action: 'login', outcome: 'error', clientAddress: address, detail: { mode: 'w3' } })
      // The transaction was consumed before the exchange, so it cannot be replayed.
      return denied()
    }
  }

  /**
   * Report the authenticated user.
   * @param request - request carrying the session cookie.
   * @returns the identity JSON, or 401 with the lookup failure code.
   */
  private async me(request: PlatformHttpRequest): Promise<PlatformHttpResult> {
    const lookup = await this.authenticate(request.cookies[this.config.sessionCookieName])
    if (!lookup.ok) return errorResult(401, lookup.code)
    return jsonResult(200, {
      user: userJson(lookup.session.user),
      sessionExpiresAt: toIso(lookup.session.absoluteExpiresAt),
    })
  }

  /**
   * Revoke the requesting browser's session.
   * @param request - request carrying the session and CSRF cookies.
   * @returns the logout JSON with cleared cookies, or 401/403 when unauthorised.
   */
  private async logout(request: PlatformHttpRequest): Promise<PlatformHttpResult> {
    const lookup = await this.authenticate(request.cookies[this.config.sessionCookieName])
    if (!lookup.ok) return errorResult(401, lookup.code)
    if (!this.csrfMatches(lookup.session, request)) return errorResult(403, 'csrf-invalid')
    this.store.revokeSession(lookup.session.sessionId, toIso(this.clock()))
    this.audit({
      action: 'logout',
      outcome: 'success',
      userId: lookup.session.user.id,
      subject: lookup.session.user.subject,
      clientAddress: request.clientAddress,
    })
    const logoutUrl = this.config.w3.logoutUrl === '' ? null : this.config.w3.logoutUrl
    return {
      status: 200,
      headers: JSON_HEADERS,
      cookies: clearedSessionCookies(this.config),
      body: JSON.stringify({ ok: true, logoutUrl }),
    }
  }

  /**
   * Revoke every session of the authenticated user.
   * @param request - request carrying the session, CSRF cookies, and confirmation header.
   * @returns `{ ok: true }`, 400 without the confirmation header, or 401/403 when unauthorised.
   */
  private async logoutAll(request: PlatformHttpRequest): Promise<PlatformHttpResult> {
    const lookup = await this.authenticate(request.cookies[this.config.sessionCookieName])
    if (!lookup.ok) return errorResult(401, lookup.code)
    if (!this.csrfMatches(lookup.session, request)) return errorResult(403, 'csrf-invalid')
    if (headerValue(request.headers, 'x-dsh-confirm') !== LOGOUT_ALL_CONFIRMATION) {
      return jsonResult(400, { error: { code: 'confirmation-required' } })
    }
    const revoked = this.store.revokeUserSessions(lookup.session.user.id, toIso(this.clock()))
    this.audit({
      action: 'logout.all',
      outcome: 'success',
      userId: lookup.session.user.id,
      subject: lookup.session.user.subject,
      clientAddress: request.clientAddress,
      detail: { sessionsRevoked: revoked },
    })
    return jsonResult(200, { ok: true })
  }

  /**
   * Resolve one session token for an internal service.
   * @param request - request carrying the internal service key and JSON body.
   * @returns the introspection JSON, or a stable 4xx failure.
   */
  private async introspect(request: PlatformHttpRequest): Promise<PlatformHttpResult> {
    if (this.config.internalApiKey === '') return errorResult(404, 'not-found')
    const providedKey = headerValue(request.headers, 'x-dsh-internal-key')
    if (providedKey === undefined || !constantTimeEquals(providedKey, this.config.internalApiKey)) {
      return errorResult(403, 'internal-unauthorized')
    }
    const payload = readJsonObject(request.body)
    const sessionToken = payload === undefined ? undefined : payload['session_token']
    if (typeof sessionToken !== 'string' || sessionToken === '') {
      return errorResult(400, 'session-invalid')
    }
    const lookup = await this.authenticate(sessionToken)
    if (!lookup.ok) return errorResult(401, lookup.code)
    const session = lookup.session
    return jsonResult(200, {
      active: true,
      user: userJson(session.user),
      sessionId: session.sessionId,
      expiresAt: toIso(session.expiresAt),
      absoluteExpiresAt: toIso(session.absoluteExpiresAt),
      permissionVersion: session.permissionVersion,
    })
  }

  /**
   * Compare the CSRF header and cookie against the session.
   * @param session - validated session.
   * @param request - request carrying the header and CSRF cookie.
   * @returns true when both values agree with the stored hash.
   */
  private csrfMatches(session: ValidatedSession, request: PlatformHttpRequest): boolean {
    return this.verifyCsrf(
      session,
      headerValue(request.headers, 'x-csrf-token'),
      request.cookies[this.config.csrfCookieName],
    )
  }
}

/**
 * Validate configuration facts the identity service cannot run without.
 * @param config - identity configuration.
 * @throws when Mock mode is requested in production or a lifetime is not positive.
 */
function assertUsableConfig(config: IdentityConfig): void {
  if (config.appEnv === 'production' && config.mode === 'mock') {
    throw new Error('Mock authentication is forbidden in production; set AUTH_MODE=w3')
  }
  for (const [name, value] of [
    ['idleTimeoutMs', config.idleTimeoutMs],
    ['absoluteTimeoutMs', config.absoluteTimeoutMs],
    ['oauthStateTtlMs', config.oauthStateTtlMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`identity ${name} must be a positive number of milliseconds`)
    }
  }
}

/**
 * Create the identity service over one SQLite database.
 * @param config - identity configuration.
 * @param options - fetch and clock overrides; defaults are the global fetch and `Date.now`.
 * @returns the ready identity service.
 * @throws when the configuration is unsafe, the database cannot be opened, or a migration fails.
 */
export async function createIdentityService(
  config: IdentityConfig,
  options: CreateIdentityServiceOptions = {},
): Promise<IdentityService> {
  assertUsableConfig(config)
  const clock = options.now ?? Date.now
  const store = new IdentityStore(openIdentityDatabase(config), toIso(clock()))
  return new IdentityHttpService(config, store, clock, options.fetch)
}
