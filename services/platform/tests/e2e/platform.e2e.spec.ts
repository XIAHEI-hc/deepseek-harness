/**
 * End-to-end acceptance over real per-user DSH runtimes.
 *
 * The suite drives the real platform application through its public HTTP
 * surface: two scripted W3 identities log in through the authorization-code
 * flow, the platform starts one native DSH runtime per identity, and the
 * gateway proxies the original DSH UI. It then exercises cross-user routing,
 * logout, session revocation, and WebSocket admission/revalidation.
 *
 * The runtimes are the real `dsh web` application launched by the process
 * backend; no DSH host is mocked. The W3 provider is scripted because no real
 * tenant credentials exist in this environment (AUTH-24 stays BLOCKED).
 *
 * @module @deepseek-ai/dsh-platform-services/tests/e2e/platform.e2e.spec
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPlatformApp, type PlatformApp } from '../../src/app.ts'
import { disableUser, enableUser } from '../../src/admin/users.ts'
import { computeSpaceKey, resolveRuntimeSpaceByKey } from '../../src/runtime/index.ts'
import { FakeW3Provider, reservePort, TestBrowser, waitFor, w3PlatformConfig } from './support.ts'

/** Repository root used to launch the real DSH CLI. */
const REPO_ROOT = process.cwd()

/** One live test platform plus its scripted identity provider. */
interface Fixture {
  readonly app: PlatformApp
  readonly provider: FakeW3Provider
  readonly origin: string
  readonly dataDir: string
  readonly browsers: { a: TestBrowser; b: TestBrowser }
}

/** Start the platform application over a fresh data directory. */
async function startFixture(): Promise<Fixture> {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-platform-e2e-'))
  const provider = new FakeW3Provider()
  const providerUrl = await provider.start()
  const listenPort = await reservePort()
  const config = w3PlatformConfig({ dataDir, listenPort, providerUrl, repoRoot: REPO_ROOT })
  const app = await createPlatformApp(config)
  const bound = await app.listen()
  const origin = `http://127.0.0.1:${String(bound.port)}`
  return {
    app,
    provider,
    origin,
    dataDir,
    browsers: { a: new TestBrowser(origin), b: new TestBrowser(origin) },
  }
}

/** Stop the platform and the provider, then delete the data directory. */
async function stopFixture(fixture: Fixture): Promise<void> {
  await fixture.app.close()
  await fixture.provider.stop()
  await rm(fixture.dataDir, { recursive: true, force: true })
}

/**
 * Complete one scripted W3 authorization-code login.
 * @param fixture - running platform fixture.
 * @param browser - that user's browser.
 * @param account - scripted W3 account name.
 * @returns the `/auth/me` payload after login.
 */
async function login(fixture: Fixture, browser: TestBrowser, account: string): Promise<{ user: { id: string; displayName: string; uid: string; subject: string } }> {
  const choose = await browser.request(`${fixture.provider.url}/__account?account=${account}`)
  expect(choose.status).toBe(200)
  const start = await browser.request(`${fixture.origin}/auth/login?return_to=/workspace`)
  expect(start.status).toBe(302)
  expect(String(start.headers['location'])).toContain(`${fixture.provider.url}/authorize`)
  const authorized = await browser.follow(start)
  expect(authorized.status).toBe(302)
  const callback = await browser.follow(authorized)
  expect(callback.status).toBe(302)
  expect(String(callback.headers['location'])).toContain('/workspace')
  const me = await browser.request(`${fixture.origin}/auth/me`)
  expect(me.status).toBe(200)
  return JSON.parse(me.body) as { user: { id: string; displayName: string; uid: string; subject: string } }
}

/**
 * Read the anonymous runtime status for one browser.
 * @param fixture - running platform fixture.
 * @param browser - authenticated browser.
 * @returns the parsed status body.
 */
async function runtimeStatus(fixture: Fixture, browser: TestBrowser): Promise<{ state: string; generation: number; retryable: boolean; errorCode: string | null }> {
  const response = await browser.request(`${fixture.origin}/api/runtime/me`)
  expect(response.status).toBe(200)
  return JSON.parse(response.body) as { state: string; generation: number; retryable: boolean; errorCode: string | null }
}

/**
 * Open one WebSocket upgrade through the gateway.
 * @param origin - platform origin.
 * @param cookie - browser cookie header.
 * @param options - extra headers.
 * @returns the upgrade status and, on 101, the raw socket.
 */
async function openTunnel(
  origin: string,
  cookie: string | undefined,
  options: { headers?: Record<string, string> } = {},
): Promise<{ status: number; socket?: import('node:net').Socket }> {
  const url = new URL(`${origin}/api/remote.mux`)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: url.hostname,
      port: Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        // The runtime rejects a key that does not decode to the required 16 bytes.
        'sec-websocket-key': randomBytes(16).toString('base64'),
        origin,
        ...cookie === undefined ? {} : { cookie },
        ...options.headers,
      },
    })
    request.on('upgrade', (response, socket) => {
      resolve({ status: response.statusCode ?? 0, socket })
    })
    request.on('response', (response) => {
      response.resume()
      resolve({ status: response.statusCode ?? 0 })
    })
    request.on('error', reject)
    request.end()
  })
}

/**
 * Wait until one upgraded socket closes.
 * @param socket - upgraded transport, if the handshake produced one.
 * @param timeoutMs - wait budget.
 * @returns true when the socket closed within the budget.
 */
async function waitSocketClosed(socket: import('node:net').Socket | undefined, timeoutMs: number): Promise<boolean> {
  if (socket === undefined) return true
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { resolve(false) }, timeoutMs)
    socket.once('close', () => { clearTimeout(timer); resolve(true) })
    socket.once('error', () => { clearTimeout(timer); resolve(true) })
  })
}

/**
 * Open a tunnel, retrying while the freshly started runtime has not registered
 * its stream route yet (the native host serves pages before that route exists).
 * @param origin - platform origin.
 * @param cookie - browser cookie header.
 * @param timeoutMs - retry budget.
 * @returns the admitted tunnel, or the last refusal.
 */
async function openTunnelWhenReady(
  origin: string,
  cookie: string | undefined,
  timeoutMs = 30_000,
): Promise<{ status: number; socket?: import('node:net').Socket }> {
  const deadline = Date.now() + timeoutMs
  let last: { status: number; socket?: import('node:net').Socket } = { status: 0 }
  while (Date.now() < deadline) {
    last = await openTunnel(origin, cookie)
    if (last.status === 101) return last
    last.socket?.destroy()
    await new Promise<void>(resolve => { setTimeout(resolve, 500) })
  }
  return last
}

/**
 * Call one Typert Remote endpoint through the gateway with a browser session.
 * @param browser - authenticated browser.
 * @param endpoint - endpoint name such as `session/list`.
 * @param args - endpoint arguments.
 * @returns the business result (`ok` true with `value`, or false with `error`).
 */
async function rpc(
  origin: string,
  browser: TestBrowser,
  endpoint: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }> {
  const response = await browser.request(`${origin}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method: endpoint,
      payload: { args },
    }),
  })
  if (response.status !== 200) throw new Error(`rpc ${endpoint} answered HTTP ${String(response.status)}`)
  const envelope = JSON.parse(response.body) as { result: { ok: boolean; value?: unknown; error?: { code: string; message: string } } }
  return envelope.result
}

/**
 * Read the session ids from one `session/list` result.
 * @param result - `session/list` business result.
 * @returns the listed session ids.
 */
function sessionIds(result: { ok: boolean; value?: unknown }): string[] {
  const value = result.value as { items?: { sessionId?: unknown }[] } | undefined
  return (value?.items ?? []).map(item => (typeof item.sessionId === 'string' ? item.sessionId : '')).filter(id => id !== '')
}

/**
 * Read one listed session row.
 * @param result - `session/list` business result.
 * @param sessionId - session to find.
 * @returns the row, or undefined.
 */
function listedSession(result: { ok: boolean; value?: unknown }, sessionId: string): Record<string, unknown> | undefined {
  const value = result.value as { items?: Record<string, unknown>[] } | undefined
  return (value?.items ?? []).find(item => item.sessionId === sessionId)
}

/**
 * Read one listed session's projected title.
 * @param result - `session/list` business result.
 * @param sessionId - session to find.
 * @returns the title, or undefined while the projection has not landed.
 */
function listedTitle(result: { ok: boolean; value?: unknown }, sessionId: string): string | undefined {
  const row = listedSession(result, sessionId)
  const projections = row?.['projections'] as { values?: { title?: unknown } } | undefined
  const title = projections?.values?.title
  return typeof title === 'string' ? title : undefined
}

describe('DSH platform end to end', () => {
  let fixture: Fixture
  let userA: { id: string; displayName: string; uid: string; subject: string }
  let userB: { id: string; displayName: string; uid: string; subject: string }

  beforeAll(async () => {
    fixture = await startFixture()
  }, 120_000)

  afterAll(async () => {
    if (fixture !== undefined) await stopFixture(fixture)
  }, 120_000)

  it('redirects anonymous page traffic to the platform login page and refuses anonymous APIs', async () => {
    const page = await fixture.browsers.a.request(`${fixture.origin}/`)
    expect(page.status).toBe(302)
    const location = String(page.headers['location'])
    expect(location.startsWith('/login?return_to=')).toBe(true)

    const api = await fixture.browsers.a.request(`${fixture.origin}/api/runtime/me`)
    expect(api.status).toBe(401)

    const tunnel = await openTunnel(fixture.origin, undefined)
    expect(tunnel.status).toBe(401)
  })

  it('logs in two W3 identities and starts one native DSH runtime each', async () => {
    userA = (await login(fixture, fixture.browsers.a, 'a')).user
    userB = (await login(fixture, fixture.browsers.b, 'b')).user
    expect(userA.displayName).toBe('User A')
    expect(userB.displayName).toBe('User B')
    expect(userA.id).not.toBe(userB.id)
    expect(userA.subject).toBe('w3-a')
    expect(userB.subject).toBe('w3-b')

    // Getting the native UI triggers the runtime ensure for that identity.
    const pageA = await fixture.browsers.a.request(`${fixture.origin}/`)
    expect(pageA.status).toBe(200)
    expect(pageA.body).toContain('__DSH_BOOT__')
    const pageB = await fixture.browsers.b.request(`${fixture.origin}/`)
    expect(pageB.status).toBe(200)
    expect(pageB.body).toContain('__DSH_BOOT__')

    await waitFor('user A runtime READY', async () => (await runtimeStatus(fixture, fixture.browsers.a)).state === 'READY')
    await waitFor('user B runtime READY', async () => (await runtimeStatus(fixture, fixture.browsers.b)).state === 'READY')

    const statusA = await runtimeStatus(fixture, fixture.browsers.a)
    const statusB = await runtimeStatus(fixture, fixture.browsers.b)
    expect(statusA.generation).toBeGreaterThanOrEqual(1)
    expect(statusB.generation).toBeGreaterThanOrEqual(1)

    // Private routing targets differ, and the anonymous status never leaks them.
    const ensuredA = await fixture.app.runtime.ensure(userA.id)
    const ensuredB = await fixture.app.runtime.ensure(userB.id)
    expect(ensuredA.target).toBeDefined()
    expect(ensuredB.target).toBeDefined()
    expect(ensuredA.target?.port).not.toBe(ensuredB.target?.port)
    const rawStatus = await fixture.browsers.a.request(`${fixture.origin}/api/runtime/me`)
    expect(rawStatus.body).not.toContain(String(ensuredA.target?.port))
    expect(rawStatus.body).not.toContain(ensuredA.target?.host ?? '127.0.0.1')

    // Each identity owns a distinct opaque space directory with its own stores.
    const config = fixture.app.config
    const spaceA = computeSpaceKey(config.runtime.spaceKeySecret, config.realm, userA.id)
    const spaceB = computeSpaceKey(config.runtime.spaceKeySecret, config.realm, userB.id)
    expect(spaceA).not.toBe(spaceB)
    const dirsA = resolveRuntimeSpaceByKey({ root: config.runtime.root, realm: config.realm, userId: userA.id, spaceKey: spaceA })
    const dirsB = resolveRuntimeSpaceByKey({ root: config.runtime.root, realm: config.realm, userId: userB.id, spaceKey: spaceB })
    for (const path of [dirsA.dshHome, dirsA.home, dirsA.agentsHome, dirsA.workspaces, dirsB.dshHome, dirsB.home]) {
      expect((await stat(path)).isDirectory()).toBe(true)
    }
    expect(dirsA.dshHome).not.toBe(dirsB.dshHome)
  }, 300_000)

  it('reuses one runtime for the same identity and keeps other identities independent', async () => {
    const secondBrowser = new TestBrowser(fixture.origin)
    // A second browser for A shares A's jar-less view: log in again as A.
    const again = await login(fixture, secondBrowser, 'a')
    expect(again.user.id).toBe(userA.id)
    const ensured = await fixture.app.runtime.ensure(userA.id)
    const first = await fixture.app.runtime.ensure(userA.id)
    expect(first.target?.port).toBe(ensured.target?.port)
    expect((await runtimeStatus(fixture, secondBrowser)).state).toBe('READY')
    const page = await secondBrowser.request(`${fixture.origin}/`)
    expect(page.status).toBe(200)
    expect(page.body).toContain('__DSH_BOOT__')
  }, 120_000)

  it('admits an authenticated WebSocket tunnel and keeps other users out', async () => {
    const socketA = await openTunnel(fixture.origin, fixture.browsers.a.cookieHeader())
    expect(socketA.status).toBe(101)
    expect(socketA.socket).toBeDefined()
    socketA.socket?.destroy()

    // A forged cookie is not A's session and gets no tunnel.
    const forged = await openTunnel(fixture.origin, 'dsh_session=forged-session-token')
    expect(forged.status).toBe(401)
    forged.socket?.destroy()

    // A cross-site Origin is refused even with a valid cookie (the gateway
    // refuses the handshake before any runtime is contacted).
    const crossSite = await openTunnel(fixture.origin, fixture.browsers.a.cookieHeader(), {
      headers: { origin: 'https://evil.example' },
    })
    expect(crossSite.status).toBe(401)
    crossSite.socket?.destroy()
  }, 120_000)

  it('revokes the current session on logout and drops its live WebSocket', async () => {
    const staleCookie = fixture.browsers.a.cookieHeader() ?? ''
    const csrf = fixture.browsers.a.cookie('dsh_csrf') ?? ''
    const tunnel = await openTunnel(fixture.origin, staleCookie)
    expect(tunnel.status).toBe(101)

    const logout = await fixture.browsers.a.request(`${fixture.origin}/auth/logout`, {
      method: 'POST',
      headers: { 'x-csrf-token': csrf },
    })
    expect(logout.status).toBe(200)

    // The live tunnel is revalidated within the configured one-second period.
    const closed = await new Promise<boolean>((resolve) => {
      const socket = tunnel.socket
      if (socket === undefined) {
        resolve(true)
        return
      }
      const timer = setTimeout(() => { resolve(false) }, 10_000)
      socket.once('close', () => { clearTimeout(timer); resolve(true) })
      socket.once('error', () => { clearTimeout(timer); resolve(true) })
    })
    expect(closed).toBe(true)

    // A stale Cookie value no longer authenticates; B is unaffected.
    const replay = await new TestBrowser(fixture.origin).request(`${fixture.origin}/auth/me`, {
      headers: { cookie: staleCookie },
      sendCookies: false,
    })
    expect(replay.status).toBe(401)
    const stillB = await fixture.browsers.b.request(`${fixture.origin}/auth/me`)
    expect(stillB.status).toBe(200)
    expect(JSON.parse(stillB.body).user.id).toBe(userB.id)
    const pageB = await fixture.browsers.b.request(`${fixture.origin}/`)
    expect(pageB.status).toBe(200)
    expect(pageB.body).toContain('__DSH_BOOT__')
  }, 120_000)

  it('operator disable revokes a live session and its WebSocket without touching other users', async () => {
    const browserC = new TestBrowser(fixture.origin)
    const userC = (await login(fixture, browserC, 'c')).user
    const pageC = await browserC.request(`${fixture.origin}/`)
    expect(pageC.status).toBe(200)
    expect(pageC.body).toContain('__DSH_BOOT__')
    await waitFor('user C runtime READY', async () => (await runtimeStatus(fixture, browserC)).state === 'READY')

    const tunnel = await openTunnelWhenReady(fixture.origin, browserC.cookieHeader())
    expect(tunnel.status).toBe(101)

    const disabled = await disableUser({ identity: fixture.app.config.identity, subject: userC.subject, confirm: true })
    expect(disabled.status).toBe('disabled')
    expect(disabled.sessionsRevoked).toBeGreaterThanOrEqual(1)

    // The gateway re-checks every request and closes the live tunnel within one
    // revalidation period; B's session is untouched.
    await waitFor('disabled user C is refused', async () => {
      return (await browserC.request(`${fixture.origin}/auth/me`)).status === 401
    })
    expect(await waitSocketClosed(tunnel.socket, 10_000)).toBe(true)
    const stillB = await fixture.browsers.b.request(`${fixture.origin}/auth/me`)
    expect(stillB.status).toBe(200)
    expect(JSON.parse(stillB.body).user.id).toBe(userB.id)

    // Re-enabling lets the user log in again, with a fresh identity session.
    const enabled = await enableUser({ identity: fixture.app.config.identity, subject: userC.subject, confirm: true })
    expect(enabled.status).toBe('active')
    const reloginBrowser = new TestBrowser(fixture.origin)
    const relogin = await login(fixture, reloginBrowser, 'c')
    expect(relogin.user.id).toBe(userC.id)
  }, 180_000)

  it('isolates session lists, search, reads, and mutations between two identities', async () => {
    const browserA = new TestBrowser(fixture.origin)
    await login(fixture, browserA, 'a')
    const browserB = fixture.browsers.b

    const createA = await rpc(fixture.origin, browserA, 'session/create', { request: {} })
    const createB = await rpc(fixture.origin, browserB, 'session/create', { request: {} })
    expect(createA.ok).toBe(true)
    expect(createB.ok).toBe(true)
    const sessionA = (createA.value as { sessionId: string }).sessionId
    const sessionB = (createB.value as { sessionId: string }).sessionId
    expect(sessionA).not.toBe(sessionB)

    const renameA = await rpc(fixture.origin, browserA, 'session/rename', { request: { sessionId: sessionA, title: 'alpha-private-history' } })
    const renameB = await rpc(fixture.origin, browserB, 'session/rename', { request: { sessionId: sessionB, title: 'bravo-private-history' } })
    expect(renameA.ok).toBe(true)
    expect(renameB.ok).toBe(true)

    const listA = await rpc(fixture.origin, browserA, 'session/list', { _request: {} })
    const listB = await rpc(fixture.origin, browserB, 'session/list', { _request: {} })
    expect(listA.ok).toBe(true)
    expect(listB.ok).toBe(true)
    const idsA = sessionIds(listA)
    const idsB = sessionIds(listB)
    expect(idsA).toContain(sessionA)
    expect(idsA).not.toContain(sessionB)
    expect(idsB).toContain(sessionB)
    expect(idsB).not.toContain(sessionA)
    await waitFor('A session title projects', async () => {
      const current = await rpc(fixture.origin, browserA, 'session/list', { _request: {} })
      return listedTitle(current, sessionA) === 'alpha-private-history'
    })
    await waitFor('B session title projects', async () => {
      const current = await rpc(fixture.origin, browserB, 'session/list', { _request: {} })
      return listedTitle(current, sessionB) === 'bravo-private-history'
    })

    // Full-text search runs against a per-user SQLite index under this identity's
    // own DSH home. Blank sessions carry no message text, so this asserts the
    // isolation property (no other identity's session is ever returned) rather
    // than message-content ranking, which needs an agent run.
    const searchA = await rpc(fixture.origin, browserA, 'session/search', { request: { query: 'private-history' } })
    expect(searchA.ok).toBe(true)
    const searchIds = (searchA.value as { items?: { sessionId?: unknown }[] }).items?.map(item => item.sessionId) ?? []
    expect(searchIds).not.toContain(sessionB)
    const searchB = await rpc(fixture.origin, browserB, 'session/search', { request: { query: 'private-history' } })
    expect(searchB.ok).toBe(true)
    const searchIdsB = (searchB.value as { items?: { sessionId?: unknown }[] }).items?.map(item => item.sessionId) ?? []
    expect(searchIdsB).not.toContain(sessionA)

    // IDOR: B's session id is not addressable from A's runtime for read or mutation.
    const stateB = await rpc(fixture.origin, browserA, 'session/state', { request: { sessionId: sessionB } })
    expect(stateB.ok).toBe(false)
    expect(stateB.error?.code ?? '').toContain('not-found')
    const pageB = await rpc(fixture.origin, browserA, 'session/page', { request: { address: { kind: 'session', sessionId: sessionB } } })
    expect(pageB.ok).toBe(false)
    expect(pageB.error?.code ?? '').toContain('not-found')
    const renameForeign = await rpc(fixture.origin, browserA, 'session/rename', { request: { sessionId: sessionB, title: 'hijacked' } })
    expect(renameForeign.ok).toBe(false)
    const forkForeign = await rpc(fixture.origin, browserA, 'session/fork', { request: { sessionId: sessionB } })
    expect(forkForeign.ok).toBe(false)
    const cancelForeign = await rpc(fixture.origin, browserA, 'session/cancel', { request: { sessionId: sessionB } })
    expect(cancelForeign.ok).toBe(false)

    // B's session and title are unchanged by A's attempts.
    const listBAfter = await rpc(fixture.origin, browserB, 'session/list', { _request: {} })
    expect(listedTitle(listBAfter, sessionB)).toBe('bravo-private-history')
    expect(sessionIds(listBAfter)).not.toContain(sessionA)

    // Logging out and back in restores this identity's own history only.
    const csrf = browserA.cookie('dsh_csrf') ?? ''
    const logout = await browserA.request(`${fixture.origin}/auth/logout`, {
      method: 'POST',
      headers: { 'x-csrf-token': csrf },
    })
    expect(logout.status).toBe(200)
    const returnBrowser = new TestBrowser(fixture.origin)
    await login(fixture, returnBrowser, 'a')
    const listReturned = await rpc(fixture.origin, returnBrowser, 'session/list', { _request: {} })
    expect(sessionIds(listReturned)).toContain(sessionA)
    await waitFor('restored session title', async () => {
      const current = await rpc(fixture.origin, returnBrowser, 'session/list', { _request: {} })
      return listedTitle(current, sessionA) === 'alpha-private-history'
    })
    expect(sessionIds(listReturned)).not.toContain(sessionB)
  }, 240_000)
})
