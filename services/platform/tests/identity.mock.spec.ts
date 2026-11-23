/**
 * Mock-mode identity behaviour: login, session, CSRF-checked logout, cookie
 * attributes, safe `return_to` handling, and the production refusal.
 *
 * Covers AUTH-01, AUTH-16, AUTH-17, AUTH-18, AUTH-19, AUTH-20, AUTH-21 and
 * AUTH-22. AUTH-24 requires a real W3 tenant and is covered as BLOCKED in
 * `identity.w3.spec.ts`.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { IdentityConfig } from '../src/config.ts'
import { createIdentityService } from '../src/identity/index.ts'
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
  userOf,
  type TestIdentityFixture,
} from './identity.testkit.ts'

afterEach(cleanupIdentityTests)

/**
 * Start a Mock identity service on a temporary directory.
 * @param overrides - identity configuration overrides.
 * @returns the fixture, service, and a fresh browser.
 */
async function startMock(overrides: Partial<IdentityConfig> = {}): Promise<{
  fixture: TestIdentityFixture
  service: Awaited<ReturnType<typeof startIdentity>>['service']
  browser: ReturnType<typeof newBrowser>
}> {
  const fixture = createTestIdentity(overrides)
  const { service } = await startIdentity(fixture)
  return { fixture, service, browser: newBrowser(fixture, service) }
}

describe('mock identity surface', () => {
  it('AUTH-01 answers unauthenticated identity requests with 401 and leaves other paths to the gateway', async () => {
    const { fixture, service, browser } = await startMock()

    const me = requireResult(await browser.get('/auth/me'))
    expect(me.status).toBe(401)
    expect(errorCodeOf(me)).toBe('no-session')
    expect(me.body).not.toContain('user')

    browser.setCookie({ name: fixture.config.sessionCookieName, value: 'forged-session-token', path: '/' })
    const forged = requireResult(await browser.get('/auth/me'))
    expect(forged.status).toBe(401)
    expect(errorCodeOf(forged)).toBe('session-invalid')

    expect(await browser.get('/dsh/sessions')).toBeUndefined()
    expect(await browser.get('/auth/unknown')).toBeUndefined()
    expect(await browser.get('/internal/unknown')).toBeUndefined()

    const wrongMethod = requireResult(await browser.post('/auth/me'))
    expect(wrongMethod.status).toBe(404)
    expect(errorCodeOf(wrongMethod)).toBe('not-found')

    expect(service.mode).toBe('mock')

    const health = requireResult(await browser.get('/auth/health'))
    expect(health.status).toBe(200)
    expect(jsonObject(health)).toEqual({ ok: true, mode: 'mock' })
  })

  it('AUTH-17/19 logs in the configured Mock identity and never lets the browser choose it', async () => {
    const { fixture, browser } = await startMock()

    const login = requireResult(
      await browser.get(
        '/auth/login?return_to=%2Fworkspace&subject=forged&uid=forged&email=forged%40example.com',
        { headers: { 'x-user-id': 'forged', 'x-dsh-user': 'forged' } },
      ),
    )
    expect(login.status).toBe(302)
    expect(login.headers?.['location']).toBe('/workspace')

    const sessionCookie = findCookie(login.cookies, fixture.config.sessionCookieName)
    expect(sessionCookie?.httpOnly).toBe(true)
    expect(sessionCookie?.secure).toBe(false)
    expect(sessionCookie?.sameSite).toBe('Lax')
    expect(sessionCookie?.path).toBe('/')
    expect(sessionCookie?.maxAgeSeconds).toBe(fixture.config.absoluteTimeoutMs / 1000)
    expect(sessionCookie?.value).toMatch(/^[A-Za-z0-9_-]{64}$/)
    const csrfCookie = findCookie(login.cookies, fixture.config.csrfCookieName)
    expect(csrfCookie?.httpOnly).toBe(false)
    expect(csrfCookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(csrfCookie?.sameSite).toBe('Lax')
    expect(csrfCookie?.path).toBe('/')

    const me = requireResult(await browser.get('/auth/me'))
    expect(me.status).toBe(200)
    const user = userOf(me)
    expect(user.subject).toBe(fixture.config.mock.subject)
    expect(user.uid).toBe(fixture.config.mock.uid)
    expect(user.displayName).toBe(fixture.config.mock.displayName)
    expect(user.email).toBeNull()
    expect(jsonObject(me)['sessionExpiresAt']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('AUTH-18 refuses Mock authentication in production at construction', async () => {
    const fixture = createTestIdentity()
    const productionMock: IdentityConfig = { ...fixture.config, appEnv: 'production', mode: 'mock' }
    await expect(createIdentityService(productionMock)).rejects.toThrow(
      'Mock authentication is forbidden in production',
    )
    expect(existsSync(join(fixture.dataDir, 'identity.sqlite'))).toBe(false)
  })

  it('AUTH-16 blocks return_to open redirects while keeping same-site paths', async () => {
    const { browser } = await startMock()
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['%2F%2Fevil.example', '/'],
      ['https%3A%2F%2Fevil.example%2Fsteal', '/'],
      ['%2F%5Cevil.example', '/'],
      ['%2F%0D%0ASet-Cookie%3A%20forged', '/'],
      ['%2Fsafe%2Fpath%3Ftab%3D1', '/safe/path?tab=1'],
    ]
    for (const [raw, expected] of cases) {
      const login = requireResult(await browser.get(`/auth/login?return_to=${raw}`))
      expect(login.status).toBe(302)
      expect(login.headers?.['location']).toBe(expected)
    }
  })

  it('AUTH-20 marks every platform cookie Secure when the deployment requires it', async () => {
    const { fixture, browser } = await startMock({ cookieSecure: true })
    const login = requireResult(await browser.get('/auth/login'))
    const sessionCookie = findCookie(login.cookies, fixture.config.sessionCookieName)
    const csrfCookie = findCookie(login.cookies, fixture.config.csrfCookieName)
    expect(sessionCookie?.secure).toBe(true)
    expect(csrfCookie?.secure).toBe(true)
    expect(sessionCookie?.httpOnly).toBe(true)
    expect(csrfCookie?.httpOnly).toBe(false)
  })

  it('AUTH-21 rejects state-changing requests without a matching CSRF token', async () => {
    const { fixture, browser } = await startMock()
    requireResult(await browser.get('/auth/login'))
    const csrf = browser.cookieValue(fixture.config.csrfCookieName)
    expect(csrf).toBeDefined()

    const missing = requireResult(await browser.post('/auth/logout'))
    expect(missing.status).toBe(403)
    expect(errorCodeOf(missing)).toBe('csrf-invalid')

    const wrongHeader = requireResult(
      await browser.post('/auth/logout', { headers: { 'x-csrf-token': 'wrong-token' } }),
    )
    expect(wrongHeader.status).toBe(403)
    expect(errorCodeOf(wrongHeader)).toBe('csrf-invalid')

    browser.setCookie({ name: fixture.config.csrfCookieName, value: 'tampered-cookie', path: '/' })
    const mismatch = requireResult(
      await browser.post('/auth/logout', { headers: { 'x-csrf-token': csrf ?? '' } }),
    )
    expect(mismatch.status).toBe(403)
    expect(errorCodeOf(mismatch)).toBe('csrf-invalid')

    browser.setCookie({ name: fixture.config.csrfCookieName, value: csrf ?? '', path: '/' })
    const loggedOut = requireResult(
      await browser.post('/auth/logout', { headers: { 'x-csrf-token': csrf ?? '' } }),
    )
    expect(loggedOut.status).toBe(200)
    expect(jsonObject(loggedOut)['ok']).toBe(true)
    expect(jsonObject(loggedOut)['logoutUrl']).toBeNull()
    expect(findCookie(loggedOut.cookies, fixture.config.sessionCookieName)?.maxAgeSeconds).toBe(0)
    expect(findCookie(loggedOut.cookies, fixture.config.sessionCookieName)?.value).toBe('')
    expect(findCookie(loggedOut.cookies, fixture.config.csrfCookieName)?.maxAgeSeconds).toBe(0)
    expect(browser.cookieValue(fixture.config.sessionCookieName)).toBeUndefined()
    expect(browser.cookieValue(fixture.config.csrfCookieName)).toBeUndefined()

    const afterLogout = requireResult(await browser.get('/auth/me'))
    expect(afterLogout.status).toBe(401)
    expect(errorCodeOf(afterLogout)).toBe('no-session')

    const again = requireResult(await browser.post('/auth/logout'))
    expect(again.status).toBe(401)
    expect(errorCodeOf(again)).toBe('no-session')
  })

  it('AUTH-22 revokes only the logging-out session and keeps the other device valid', async () => {
    const { fixture, service, browser } = await startMock()
    const first = browser
    const second = newBrowser(fixture, service)
    requireResult(await first.get('/auth/login'))
    requireResult(await second.get('/auth/login'))
    const firstToken = first.cookieValue(fixture.config.sessionCookieName)
    const firstCsrf = first.cookieValue(fixture.config.csrfCookieName)
    expect(firstToken).toBeDefined()
    expect(second.cookieValue(fixture.config.sessionCookieName)).not.toBe(firstToken)

    const loggedOut = requireResult(
      await first.post('/auth/logout', { headers: { 'x-csrf-token': firstCsrf ?? '' } }),
    )
    expect(loggedOut.status).toBe(200)

    expect(requireResult(await second.get('/auth/me')).status).toBe(200)

    first.setCookie({ name: fixture.config.sessionCookieName, value: firstToken ?? '', path: '/' })
    const replayed = requireResult(await first.get('/auth/me'))
    expect(replayed.status).toBe(401)
    expect(errorCodeOf(replayed)).toBe('session-revoked')

    const database = openIdentityDatabase(fixture.dataDir)
    registerCleanup(() => {
      database.close()
    })
    expect(countRows(database, 'dsh_users')).toBe(1)
    expect(countRows(database, 'dsh_sessions')).toBe(2)
  })

  it('stores only a session token hash and keeps the raw token out of the database', async () => {
    const { fixture, browser } = await startMock()
    requireResult(await browser.get('/auth/login'))
    const rawToken = browser.cookieValue(fixture.config.sessionCookieName)
    expect(rawToken).toBeDefined()

    const database = openIdentityDatabase(fixture.dataDir)
    registerCleanup(() => {
      database.close()
    })
    const row = database.prepare('SELECT token_hash, csrf_token_hash FROM dsh_sessions').get()
    const tokenHash = row?.['token_hash']
    const csrfHash = row?.['csrf_token_hash']
    expect(typeof tokenHash).toBe('string')
    expect(tokenHash).not.toBe(rawToken)
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(csrfHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('records login and logout audit events with the client address', async () => {
    const { fixture, browser } = await startMock()
    requireResult(await browser.get('/auth/login'))
    const csrf = browser.csrfToken() ?? ''
    expect(requireResult(await browser.post('/auth/logout', { headers: { 'x-csrf-token': csrf } })).status).toBe(200)

    const database = openIdentityDatabase(fixture.dataDir)
    registerCleanup(() => {
      database.close()
    })
    const rows = database
      .prepare('SELECT action, outcome, user_id, client_address, detail FROM dsh_audit_events ORDER BY rowid')
      .all()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ action: 'login', outcome: 'success', client_address: '127.0.0.1' })
    expect(rows[1]).toMatchObject({ action: 'logout', outcome: 'success', client_address: '127.0.0.1' })
    expect(typeof rows[0]?.['user_id']).toBe('string')
    expect(rows[0]?.['detail']).not.toContain('csrf')
  })

  it('throttles login starts per client address and audits the refusal', async () => {
    const { fixture, service, browser } = await startMock({
      loginRateLimit: { windowMs: 60_000, maxAttemptsPerAddress: 2 },
    })
    expect(requireResult(await browser.get('/auth/login')).status).toBe(302)
    expect(requireResult(await browser.get('/auth/login')).status).toBe(302)
    const limited = requireResult(await browser.get('/auth/login'))
    expect(limited.status).toBe(429)
    expect(errorCodeOf(limited)).toBe('rate-limited')
    expect(Number(limited.headers?.['retry-after'])).toBeGreaterThan(0)

    const otherAddress = requireResult(await browser.get('/auth/login', { clientAddress: '10.0.0.8' }))
    expect(otherAddress.status).toBe(302)
    void service

    const database = openIdentityDatabase(fixture.dataDir)
    registerCleanup(() => {
      database.close()
    })
    const throttled = database
      .prepare("SELECT COUNT(*) AS total FROM dsh_audit_events WHERE action = 'login' AND outcome = 'rate-limited'")
      .get()
    expect(throttled?.['total']).toBe(1)
  })
})
