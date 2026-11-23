/**
 * W3 authorization-code behaviour against a local fake provider: authorize URL
 * parameters, token JSON/form bodies, user-info body, subject mapping, state and
 * nonce binding, replay/expiry/concurrency, and stable upstream failures.
 *
 * Covers AUTH-02 .. AUTH-16. AUTH-24 (real W3 tenant, two accounts) is BLOCKED:
 * the development package ships no reachable W3 tenant or credentials, so only a
 * Mock-based or local-provider assertion is possible here and that cannot stand
 * in for the real-tenant acceptance.
 */
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { IdentityConfig, W3Config } from '../src/config.ts'
import type { IdentityService, PlatformHttpResult } from '../src/contracts.ts'
import { IdentityError } from '../src/identity/errors.ts'
import { exchangeW3Profile } from '../src/identity/w3.ts'
import {
  cleanupIdentityTests,
  countRows,
  createTestIdentity,
  errorCodeOf,
  findCookie,
  jsonObject,
  newBrowser,
  openIdentityDatabase,
  registerCleanup,
  requireResult,
  startIdentity,
  startFakeW3,
  userOf,
  w3CallsTo,
  w3Config,
  TestClock,
  type FakeW3Provider,
  type TestBrowser,
  type TestIdentityFixture,
} from './identity.testkit.ts'

afterEach(cleanupIdentityTests)

/** A started W3-mode identity deployment. */
interface W3Context {
  readonly provider: FakeW3Provider
  readonly fixture: TestIdentityFixture
  readonly service: IdentityService
  readonly clock: TestClock
  readonly browser: TestBrowser
}

/**
 * Start a W3 identity service against a fresh fake provider.
 * @param options - clock, W3 provider, and identity configuration overrides.
 * @returns the started deployment.
 */
async function startW3(
  options: {
    clock?: TestClock
    w3?: Partial<W3Config>
    identity?: Partial<IdentityConfig>
  } = {},
): Promise<W3Context> {
  const provider = await startFakeW3()
  const fixture = createTestIdentity({
    mode: 'w3',
    w3: w3Config(provider, options.w3),
    ...options.identity,
  })
  const running = await startIdentity(fixture, { clock: options.clock })
  return {
    provider,
    fixture,
    service: running.service,
    clock: running.clock,
    browser: newBrowser(fixture, running.service),
  }
}

/** One started W3 login transaction. */
interface W3Login {
  /** Raw OAuth state parameter. */
  readonly state: string
  /** Authorization URL the browser was redirected to. */
  readonly authorizationUrl: URL
  /** Login redirect result. */
  readonly result: PlatformHttpResult
  /** Browser-binding nonce cookie value, when present. */
  readonly nonce: string | undefined
}

/**
 * Start one W3 login.
 * @param context - running deployment.
 * @param browser - browser to use; defaults to the context browser.
 * @param returnTo - requested post-login path.
 * @returns the parsed login transaction.
 */
async function beginLogin(
  context: W3Context,
  browser: TestBrowser = context.browser,
  returnTo = '/workspace',
): Promise<W3Login> {
  const result = requireResult(
    await browser.get(`/auth/login?return_to=${encodeURIComponent(returnTo)}`),
  )
  expect(result.status).toBe(302)
  const location = result.headers?.['location']
  if (location === undefined) throw new Error('W3 login redirect carried no location')
  const authorizationUrl = new URL(location)
  const state = authorizationUrl.searchParams.get('state')
  if (state === null) throw new Error('W3 authorize URL carried no state')
  return {
    state,
    authorizationUrl,
    result,
    nonce: findCookie(result.cookies, context.fixture.config.loginNonceCookieName)?.value,
  }
}

/**
 * Build a callback request path.
 * @param state - raw OAuth state.
 * @param code - authorization code; defaults to `test-code`.
 * @returns the request path.
 */
function callbackPath(state: string, code = 'test-code'): string {
  return `/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
}

/**
 * Open the fixture database for assertions.
 * @param fixture - fixture owning the database.
 * @returns the open database, registered for cleanup.
 */
function openDatabase(fixture: TestIdentityFixture): DatabaseSync {
  const database = openIdentityDatabase(fixture.dataDir)
  registerCleanup(() => {
    database.close()
  })
  return database
}

/**
 * Forwarding fetch used to exercise the injected-fetch path.
 * @returns a fetch that forwards to the global implementation.
 */
function forwardingFetch(): typeof fetch {
  return (input, init) => fetch(input, init)
}

/**
 * Assert one W3 exchange fails with the stable 502 code and leaks no upstream text.
 * @param promise - exchange promise expected to reject.
 * @returns the identity error for further message assertions.
 */
async function expectW3Unavailable(promise: Promise<unknown>): Promise<IdentityError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(IdentityError)
    const identityError = error as IdentityError
    expect(identityError.status).toBe(502)
    expect(identityError.code).toBe('w3-unavailable')
    return identityError
  }
  throw new Error('expected the W3 exchange to fail')
}

describe('W3 authorization-code flow', () => {
  it('AUTH-02/03/05 completes a login with the documented authorize, token, and user-info requests', async () => {
    const context = await startW3()
    const login = await beginLogin(context)

    expect(`${login.authorizationUrl.origin}${login.authorizationUrl.pathname}`).toBe(
      `${context.provider.url}/authorize`,
    )
    expect(login.authorizationUrl.searchParams.get('tenant')).toBe('acme')
    expect(login.authorizationUrl.searchParams.get('client_id')).toBe(
      context.fixture.config.w3.clientId,
    )
    expect(login.authorizationUrl.searchParams.get('response_type')).toBe('code')
    expect(login.authorizationUrl.searchParams.get('redirect_uri')).toBe(
      context.fixture.config.w3.redirectUri,
    )
    expect(login.authorizationUrl.searchParams.get('scope')).toBe('base.profile')
    expect(login.authorizationUrl.searchParams.get('state')).toBe(login.state)
    expect(login.result.headers?.['location']).not.toContain('dsh-client-secret')

    const nonceCookie = findCookie(login.result.cookies, context.fixture.config.loginNonceCookieName)
    expect(nonceCookie?.httpOnly).toBe(true)
    expect(nonceCookie?.secure).toBe(context.fixture.config.cookieSecure)
    expect(nonceCookie?.sameSite).toBe('Lax')
    expect(nonceCookie?.path).toBe('/auth/callback')
    expect(nonceCookie?.maxAgeSeconds).toBe(context.fixture.config.oauthStateTtlMs / 1000)
    expect(nonceCookie?.value).not.toBe(login.state)

    const callback = requireResult(await context.browser.get(callbackPath(login.state)))
    expect(callback.status).toBe(302)
    expect(callback.headers?.['location']).toBe('/workspace')
    expect(findCookie(callback.cookies, context.fixture.config.sessionCookieName)?.httpOnly).toBe(true)
    expect(findCookie(callback.cookies, context.fixture.config.loginNonceCookieName)?.maxAgeSeconds).toBe(0)
    expect(context.browser.cookieValue(context.fixture.config.sessionCookieName)).toBeDefined()
    expect(context.browser.cookieValue(context.fixture.config.loginNonceCookieName)).toBeUndefined()

    const tokenCalls = w3CallsTo(context.provider, '/token')
    expect(tokenCalls).toHaveLength(1)
    const tokenCall = tokenCalls[0]
    if (tokenCall === undefined) throw new Error('token endpoint was not called')
    expect(tokenCall.contentType.startsWith('application/json')).toBe(true)
    expect(JSON.parse(tokenCall.body)).toEqual({
      client_id: context.fixture.config.w3.clientId,
      client_secret: context.fixture.config.w3.clientSecret,
      redirect_uri: context.fixture.config.w3.redirectUri,
      grant_type: 'authorization_code',
      code: 'test-code',
    })

    const infoCalls = w3CallsTo(context.provider, '/userinfo')
    expect(infoCalls).toHaveLength(1)
    const infoCall = infoCalls[0]
    if (infoCall === undefined) throw new Error('user-info endpoint was not called')
    expect(infoCall.contentType.startsWith('application/json')).toBe(true)
    expect(JSON.parse(infoCall.body)).toEqual({
      client_id: context.fixture.config.w3.clientId,
      access_token: 'test-access-token',
      scope: 'base.profile',
    })

    const me = requireResult(await context.browser.get('/auth/me'))
    expect(me.status).toBe(200)
    const user = userOf(me)
    expect(user.subject).toBe('w3-uuid-001')
    expect(user.uid).toBe('worker-001')
    expect(user.displayName).toBe('W3 测试用户')
    expect(user.email).toBe('worker@example.com')
    expect(jsonObject(me)['sessionExpiresAt']).toBe(
      new Date(context.clock.read() + context.fixture.config.absoluteTimeoutMs).toISOString(),
    )

    const health = requireResult(await context.browser.get('/auth/health'))
    expect(health.status).toBe(200)
    expect(jsonObject(health)).toEqual({ ok: true, mode: 'w3' })

    const csrf = context.browser.cookieValue(context.fixture.config.csrfCookieName)
    const loggedOut = requireResult(
      await context.browser.post('/auth/logout', { headers: { 'x-csrf-token': csrf ?? '' } }),
    )
    expect(loggedOut.status).toBe(200)
    expect(jsonObject(loggedOut)['logoutUrl']).toBe(context.fixture.config.w3.logoutUrl)
  })

  it('AUTH-04 posts the token request as a form body with identical fields', async () => {
    const context = await startW3({ w3: { tokenRequestFormat: 'form' } })
    const login = await beginLogin(context)
    const callback = requireResult(await context.browser.get(callbackPath(login.state)))
    expect(callback.status).toBe(302)

    const tokenCall = w3CallsTo(context.provider, '/token')[0]
    if (tokenCall === undefined) throw new Error('token endpoint was not called')
    expect(tokenCall.contentType.startsWith('application/x-www-form-urlencoded')).toBe(true)
    expect(Object.fromEntries(new URLSearchParams(tokenCall.body))).toEqual({
      client_id: context.fixture.config.w3.clientId,
      client_secret: context.fixture.config.w3.clientSecret,
      redirect_uri: context.fixture.config.w3.redirectUri,
      grant_type: 'authorization_code',
      code: 'test-code',
    })
    const infoCall = w3CallsTo(context.provider, '/userinfo')[0]
    expect(infoCall?.contentType.startsWith('application/json')).toBe(true)
  })

  it('AUTH-06 prefers uuid over sub and falls back through name and the uid', async () => {
    const context = await startW3()
    context.provider.userinfoBody = JSON.stringify({
      uuid: 'uuid-wins',
      sub: 'sub-loses',
      uid: 'worker-both',
      displayName: 'Both Names',
    })
    const firstLogin = await beginLogin(context)
    expect(
      requireResult(await context.browser.get(callbackPath(firstLogin.state))).status,
    ).toBe(302)
    expect(userOf(requireResult(await context.browser.get('/auth/me'))).subject).toBe('uuid-wins')

    context.provider.userinfoBody = JSON.stringify({
      sub: 'sub-only',
      uid: 'worker-sub',
      name: 'Name Only',
    })
    const secondBrowser = newBrowser(context.fixture, context.service)
    const secondLogin = await beginLogin(context, secondBrowser)
    expect(
      requireResult(await secondBrowser.get(callbackPath(secondLogin.state))).status,
    ).toBe(302)
    const secondUser = userOf(requireResult(await secondBrowser.get('/auth/me')))
    expect(secondUser.subject).toBe('sub-only')
    expect(secondUser.uid).toBe('worker-sub')
    expect(secondUser.displayName).toBe('Name Only')
    expect(secondUser.email).toBeNull()

    context.provider.userinfoBody = JSON.stringify({ sub: 'sub-bare', uid: 'worker-bare' })
    const bareBrowser = newBrowser(context.fixture, context.service)
    const bareLogin = await beginLogin(context, bareBrowser)
    expect(
      requireResult(await bareBrowser.get(callbackPath(bareLogin.state))).status,
    ).toBe(302)
    const bareUser = userOf(requireResult(await bareBrowser.get('/auth/me')))
    expect(bareUser.displayName).toBe('worker-bare')
  })

  it('AUTH-07 keeps one user across repeated logins with two independent sessions', async () => {
    const context = await startW3()
    const database = openDatabase(context.fixture)
    const secondBrowser = newBrowser(context.fixture, context.service)

    const firstLogin = await beginLogin(context)
    requireResult(await context.browser.get(callbackPath(firstLogin.state)))
    const secondLogin = await beginLogin(context, secondBrowser)
    requireResult(await secondBrowser.get(callbackPath(secondLogin.state)))

    const firstUser = userOf(requireResult(await context.browser.get('/auth/me')))
    const secondUser = userOf(requireResult(await secondBrowser.get('/auth/me')))
    expect(firstUser.id).toBe(secondUser.id)
    expect(countRows(database, 'dsh_users')).toBe(1)
    expect(countRows(database, 'dsh_sessions')).toBe(2)
  })

  it('AUTH-08 gives different W3 identities separate users and independently revocable sessions', async () => {
    const context = await startW3()
    const database = openDatabase(context.fixture)
    const browserA = newBrowser(context.fixture, context.service)
    const browserB = newBrowser(context.fixture, context.service)

    context.provider.userinfoBody = JSON.stringify({
      uuid: 'uuid-a',
      uid: 'worker-a',
      displayName: 'User A',
    })
    const loginA = await beginLogin(context, browserA)
    requireResult(await browserA.get(callbackPath(loginA.state)))

    context.provider.userinfoBody = JSON.stringify({
      uuid: 'uuid-b',
      uid: 'worker-b',
      displayName: 'User B',
    })
    const loginB = await beginLogin(context, browserB)
    requireResult(await browserB.get(callbackPath(loginB.state)))

    const userA = userOf(requireResult(await browserA.get('/auth/me')))
    const userB = userOf(requireResult(await browserB.get('/auth/me')))
    expect(userA.id).not.toBe(userB.id)
    expect(userA.subject).toBe('uuid-a')
    expect(userB.subject).toBe('uuid-b')
    expect(countRows(database, 'dsh_users')).toBe(2)
    expect(countRows(database, 'dsh_sessions')).toBe(2)

    const csrfA = browserA.cookieValue(context.fixture.config.csrfCookieName)
    const loggedOut = requireResult(
      await browserA.post('/auth/logout', { headers: { 'x-csrf-token': csrfA ?? '' } }),
    )
    expect(loggedOut.status).toBe(200)
    expect(requireResult(await browserA.get('/auth/me')).status).toBe(401)
    expect(requireResult(await browserB.get('/auth/me')).status).toBe(200)
  })

  it('AUTH-09 rejects profiles without uid or without uuid/sub and creates no session', async () => {
    const context = await startW3()
    const database = openDatabase(context.fixture)

    context.provider.userinfoBody = JSON.stringify({ uuid: 'uuid-no-uid', displayName: 'No Uid' })
    const missingUidLogin = await beginLogin(context)
    const missingUid = requireResult(
      await context.browser.get(callbackPath(missingUidLogin.state)),
    )
    expect(missingUid.status).toBe(302)
    expect(missingUid.headers?.['location']).toBe('/login?error=w3_denied')
    expect(findCookie(missingUid.cookies, context.fixture.config.sessionCookieName)).toBeUndefined()

    context.provider.userinfoBody = JSON.stringify({ uid: 'worker-no-subject' })
    const missingSubjectBrowser = newBrowser(context.fixture, context.service)
    const missingSubjectLogin = await beginLogin(context, missingSubjectBrowser)
    const missingSubject = requireResult(
      await missingSubjectBrowser.get(callbackPath(missingSubjectLogin.state)),
    )
    expect(missingSubject.status).toBe(302)
    expect(missingSubject.headers?.['location']).toBe('/login?error=w3_denied')

    expect(countRows(database, 'dsh_users')).toBe(0)
    expect(countRows(database, 'dsh_sessions')).toBe(0)
  })

  it('AUTH-10 never calls user-info when the token response has no access token', async () => {
    const context = await startW3()
    const database = openDatabase(context.fixture)
    context.provider.tokenBody = JSON.stringify({ token_type: 'Bearer' })

    const login = await beginLogin(context)
    const callback = requireResult(await context.browser.get(callbackPath(login.state)))
    expect(callback.status).toBe(302)
    expect(callback.headers?.['location']).toBe('/login?error=w3_denied')
    expect(findCookie(callback.cookies, context.fixture.config.sessionCookieName)).toBeUndefined()
    expect(w3CallsTo(context.provider, '/token')).toHaveLength(1)
    expect(w3CallsTo(context.provider, '/userinfo')).toHaveLength(0)
    expect(countRows(database, 'dsh_sessions')).toBe(0)
  })

  it('AUTH-11 maps upstream 500 and non-JSON answers to one 502 without leaking provider text', async () => {
    const context = await startW3()
    const w3 = context.fixture.config.w3
    const doFetch = forwardingFetch()

    context.provider.tokenStatus = 500
    context.provider.tokenBody = 'UPSTREAM-SECRET-BODY'
    const unavailable = await expectW3Unavailable(exchangeW3Profile(w3, 'code', { fetch: doFetch }))
    expect(unavailable.message).not.toContain('UPSTREAM-SECRET-BODY')
    expect(unavailable.message).not.toContain(context.fixture.config.w3.clientSecret)

    context.provider.tokenStatus = 200
    context.provider.tokenContentType = 'text/html'
    context.provider.tokenBody = '<html>UPSTREAM-HTML-SECRET</html>'
    const nonJson = await expectW3Unavailable(exchangeW3Profile(w3, 'code', { fetch: doFetch }))
    expect(nonJson.message).not.toContain('UPSTREAM-HTML-SECRET')

    context.provider.tokenStatus = 200
    context.provider.tokenContentType = 'application/json'
    context.provider.tokenBody = JSON.stringify({ access_token: 'test-access-token' })
    context.provider.userinfoStatus = 500
    context.provider.userinfoBody = 'USERINFO-SECRET-BODY'
    const userinfoFailure = await expectW3Unavailable(
      exchangeW3Profile(w3, 'code', { fetch: doFetch }),
    )
    expect(userinfoFailure.message).not.toContain('USERINFO-SECRET-BODY')

    const database = openDatabase(context.fixture)
    context.provider.tokenStatus = 500
    context.provider.tokenBody = 'CALLBACK-UPSTREAM-SECRET'
    const login = await beginLogin(context)
    const callback = requireResult(await context.browser.get(callbackPath(login.state)))
    expect(callback.status).toBe(302)
    expect(callback.headers?.['location']).toBe('/login?error=w3_denied')
    expect(JSON.stringify(callback)).not.toContain('CALLBACK-UPSTREAM-SECRET')
    expect(JSON.stringify(callback)).not.toContain(w3.clientSecret)
    expect(findCookie(callback.cookies, context.fixture.config.sessionCookieName)).toBeUndefined()
    expect(countRows(database, 'dsh_sessions')).toBe(0)

    context.browser.setCookie({
      name: context.fixture.config.loginNonceCookieName,
      value: login.nonce ?? '',
      path: '/auth/callback',
    })
    const replay = requireResult(await context.browser.get(callbackPath(login.state)))
    expect(replay.status).toBe(400)
    expect(errorCodeOf(replay)).toBe('login-state-invalid')
  })

  it('AUTH-12 refuses an expired login transaction without issuing a session', async () => {
    const context = await startW3({ clock: new TestClock() })
    const login = await beginLogin(context)
    context.clock.advance(context.fixture.config.oauthStateTtlMs + 1_000)
    const callback = requireResult(await context.browser.get(callbackPath(login.state)))
    expect(callback.status).toBe(400)
    expect(errorCodeOf(callback)).toBe('login-state-invalid')
    expect(callback.cookies ?? []).toHaveLength(0)
    expect(w3CallsTo(context.provider, '/token')).toHaveLength(0)
    const database = openDatabase(context.fixture)
    expect(countRows(database, 'dsh_sessions')).toBe(0)
  })

  it('AUTH-13 refuses a replayed state and never issues a second session', async () => {
    const context = await startW3()
    const database = openDatabase(context.fixture)
    const login = await beginLogin(context)
    const nonce = context.browser.cookieValue(context.fixture.config.loginNonceCookieName)
    const first = requireResult(await context.browser.get(callbackPath(login.state)))
    expect(first.status).toBe(302)
    expect(first.headers?.['location']).toBe('/workspace')

    context.browser.setCookie({
      name: context.fixture.config.loginNonceCookieName,
      value: nonce ?? '',
      path: '/auth/callback',
    })
    const replay = requireResult(await context.browser.get(callbackPath(login.state)))
    expect(replay.status).toBe(400)
    expect(errorCodeOf(replay)).toBe('login-state-invalid')
    expect(replay.cookies ?? []).toHaveLength(0)
    expect(countRows(database, 'dsh_sessions')).toBe(1)
  })

  it('AUTH-14 accepts exactly one of two concurrent callbacks for the same state', async () => {
    const context = await startW3()
    const database = openDatabase(context.fixture)
    const login = await beginLogin(context)
    const [first, second] = await Promise.all([
      context.browser.get(callbackPath(login.state)),
      context.browser.get(callbackPath(login.state)),
    ])
    const results = [requireResult(first), requireResult(second)]
    const winners = results.filter(result => result.headers?.['location'] === '/workspace')
    const losers = results.filter(result => result.status === 400)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(errorCodeOf(losers[0] ?? requireResult(first))).toBe('login-state-invalid')
    expect(
      findCookie(winners[0]?.cookies, context.fixture.config.sessionCookieName),
    ).toBeDefined()
    expect(w3CallsTo(context.provider, '/token')).toHaveLength(1)
    expect(countRows(database, 'dsh_sessions')).toBe(1)
  })

  it('AUTH-15 binds a state to the browser nonce that started the login', async () => {
    const context = await startW3()
    const browserA = newBrowser(context.fixture, context.service)
    const browserB = newBrowser(context.fixture, context.service)
    const loginA = await beginLogin(context, browserA)
    const loginB = await beginLogin(context, browserB)
    expect(loginA.state).not.toBe(loginB.state)

    const boundToOther = requireResult(await browserB.get(callbackPath(loginA.state)))
    expect(boundToOther.status).toBe(400)
    expect(errorCodeOf(boundToOther)).toBe('login-state-invalid')
    expect(findCookie(boundToOther.cookies, context.fixture.config.sessionCookieName)).toBeUndefined()

    const correct = requireResult(await browserA.get(callbackPath(loginA.state)))
    expect(correct.status).toBe(302)
    expect(correct.headers?.['location']).toBe('/workspace')
  })

  it('AUTH-16 sanitizes the stored return_to before redirecting after W3 login', async () => {
    const context = await startW3()
    const login = await beginLogin(context, context.browser, '//evil.example/steal')
    const callback = requireResult(await context.browser.get(callbackPath(login.state)))
    expect(callback.status).toBe(302)
    expect(callback.headers?.['location']).toBe('/')
  })

  it('answers 404 for the W3 callback when the service runs in Mock mode', async () => {
    const fixture = createTestIdentity()
    const { service } = await startIdentity(fixture)
    const browser = newBrowser(fixture, service)
    const callback = requireResult(await browser.get('/auth/callback?code=x&state=y'))
    expect(callback.status).toBe(404)
    expect(errorCodeOf(callback)).toBe('not-found')
  })
})
