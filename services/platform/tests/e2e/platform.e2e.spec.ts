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

import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPlatformApp, type PlatformApp } from '../../src/app.ts'
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
})
