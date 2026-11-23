/**
 * Session WebSocket event-isolation probe.
 *
 * Logs two identities in through the native DSH sign-in page in two browser
 * contexts, then opens the Gateway's Remote stream WebSocket inside each page and
 * subscribes to that identity's own Session events. Renaming A's Session through
 * the Gateway Remote API must reach A's stream and never B's; B asking for A's
 * Session stream must be refused; logging A out must close A's stream through the
 * per-connection revalidation the Gateway owns.
 *
 * Runs keylessly: Session metadata events need no model call.
 *
 * @module @deepseek-ai/dsh-platform-services/tests/e2e/ws-stream-isolation-probe
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlatformApp, type PlatformApp } from '../../src/app.ts'
import { FakeW3Provider, reservePort, waitFor, w3PlatformConfig } from './support.ts'
import { createRequire } from 'node:module'

/** Repository root used to load the Web shell's Playwright dependency. */
const REPO_ROOT = process.cwd()

/** One Gateway HTTP response the probe reads. */
interface HttpResponseLike {
  status(): number
  json(): Promise<unknown>
}

/** One browser page surface used by the probe. */
interface PageLike {
  goto(url: string, options?: { waitUntil?: 'domcontentloaded' | 'load'; timeout?: number }): Promise<unknown>
  waitForURL(predicate: RegExp | ((url: URL) => boolean), options?: { timeout?: number }): Promise<unknown>
  click(selector: string, options?: { timeout?: number }): Promise<void>
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>
  evaluate<T>(callback: () => T): Promise<T>
  evaluate<T, A>(callback: (argument: A) => T, argument: A): Promise<T>
  screenshot(options: { path: string }): Promise<unknown>
}

/** One browser context, including its cookie-sharing API request client. */
interface ContextLike {
  newPage(): Promise<PageLike>
  request: {
    get(url: string, options?: { failOnStatusCode?: boolean }): Promise<HttpResponseLike>
    post(url: string, options?: { data?: unknown; headers?: Record<string, string> }): Promise<HttpResponseLike>
  }
  close(): Promise<void>
}

/** The subset of the Playwright objects the probe uses. */
interface BrowserLike {
  newContext(options?: { locale?: string }): Promise<ContextLike>
  close(): Promise<void>
}

/** The subset of the Playwright module the probe uses. */
interface PlaywrightLike {
  chromium: { launch(options?: { headless?: boolean }): Promise<BrowserLike> }
}

/** One browser-collected stream frame, as returned from the page. */
interface StreamFrames {
  readonly frames: readonly string[]
  readonly closed: boolean
}

let assertions = 0

/**
 * Record one passing assertion.
 * @param description - assertion text printed as evidence.
 */
function pass(description: string): void {
  assertions += 1
  console.log(`PASS ${String(assertions)}: ${description}`)
}

/**
 * Assert one condition.
 * @param condition - result to require.
 * @param description - failure text.
 */
function check(condition: boolean, description: string): void {
  if (!condition) throw new Error(`ws stream isolation probe failed: ${description}`)
  pass(description)
}

/**
 * Read the platform runtime state of one browser context.
 * @param origin - platform origin.
 * @param context - browser context carrying the platform cookie.
 * @returns the runtime state string.
 */
async function runtimeState(origin: string, context: ContextLike): Promise<string> {
  const response = await context.request.get(`${origin}/api/runtime/me`)
  return ((await response.json()) as { state?: string }).state ?? 'UNKNOWN'
}

/**
 * Call one Typert Remote endpoint through the gateway.
 * @param origin - platform origin.
 * @param context - browser context carrying the platform cookie.
 * @param endpoint - endpoint name.
 * @param args - endpoint arguments.
 * @returns the business result.
 */
async function rpc(origin: string, context: ContextLike, endpoint: string, args: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown; error?: { code?: string } }> {
  const response = await context.request.post(`${origin}/api/${endpoint}`, {
    headers: { 'content-type': 'application/json' },
    data: { type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload: { args } },
  })
  return ((await response.json()) as { result: { ok: boolean; value?: unknown; error?: { code?: string } } }).result
}

/**
 * Log one browser context in through the native sign-in page and wait for its
 * personal runtime to become ready.
 * @param origin - platform origin.
 * @param provider - scripted W3 provider origin.
 * @param context - browser context to authenticate.
 * @param account - scripted account name.
 * @param page - page inside that context.
 */
async function signIn(origin: string, provider: string, context: ContextLike, account: string, page: PageLike): Promise<void> {
  const control = await context.request.get(`${provider}/__account?account=${account}`, { failOnStatusCode: true })
  if (control.status() !== 200) throw new Error(`W3 test control failed for ${account}`)
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForURL(/\/login/, { timeout: 60_000 })
  await page.click('a.button')
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 120_000 })
  await page.waitForSelector('[data-platform-identity-launcher]', { timeout: 120_000 })
  await waitFor(`runtime ready for ${account}`, async () => (await runtimeState(origin, context)) === 'READY', { timeoutMs: 240_000, intervalMs: 1000 })
  pass(`identity ${account} is signed in and its runtime is READY`)
}

/**
 * Open one Remote stream in the page and keep it there for later frame reads.
 * @param page - authenticated native page.
 * @param endpoint - stream endpoint name.
 * @param args - endpoint arguments.
 * @param initialMs - collection window after opening.
 * @returns initial frames.
 */
async function openStream(page: PageLike, endpoint: string, args: Record<string, unknown>, initialMs: number): Promise<StreamFrames> {
  return page.evaluate(async ({ endpoint: streamEndpoint, args: streamArgs, initialMs: waitMs }) => {
    const holder = globalThis as unknown as {
      __dshStreamProbe?: { socket: WebSocket; frames: string[] }
    }
    const socket = new WebSocket(`ws://${location.host}/api/remote.mux`)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => { resolve() }, { once: true })
      socket.addEventListener('error', () => { reject(new Error('WebSocket failed to open')) }, { once: true })
    })
    const frames: string[] = []
    socket.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data === 'string') frames.push(event.data)
    })
    socket.send(JSON.stringify({
      type: 'open',
      streamId: 'probe-stream',
      endpoint: streamEndpoint,
      payload: { args: streamArgs },
    }))
    await new Promise<void>((resolve) => { setTimeout(resolve, waitMs) })
    holder.__dshStreamProbe = { socket, frames }
    return { frames: [...frames], closed: socket.readyState === WebSocket.CLOSED }
  }, { endpoint, args, initialMs })
}

/**
 * Read frames accumulated by a stream opened earlier in the page.
 * @param page - authenticated native page.
 * @param waitMs - extra collection window.
 * @returns accumulated frames and whether the socket already closed.
 */
async function readStream(page: PageLike, waitMs: number): Promise<StreamFrames> {
  return page.evaluate(async (wait: number) => {
    const holder = globalThis as unknown as {
      __dshStreamProbe?: { socket: WebSocket; frames: string[] }
    }
    if (holder.__dshStreamProbe === undefined) throw new Error('stream probe was not opened')
    const started = Date.now()
    while (Date.now() - started < wait && holder.__dshStreamProbe.socket.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 100) })
    }
    return { frames: [...holder.__dshStreamProbe.frames], closed: holder.__dshStreamProbe.socket.readyState !== WebSocket.OPEN }
  }, waitMs)
}

/**
 * Close the stream opened earlier in the page.
 * @param page - authenticated native page.
 */
async function closeStream(page: PageLike): Promise<void> {
  await page.evaluate(() => {
    const holder = globalThis as unknown as {
      __dshStreamProbe?: { socket: WebSocket; frames: string[] }
    }
    holder.__dshStreamProbe?.socket.close()
  })
}

/**
 * Resolve the Web shell's Playwright package, tolerating a pruned workspace link.
 * @returns the Playwright module face the probes use.
 */
function loadPlaywright(): PlaywrightLike {
  const requireFromRepo = createRequire(join(REPO_ROOT, 'package.json'))
  try {
    return requireFromRepo('playwright') as PlaywrightLike
  } catch (_error) {}
  for (const candidate of [join(REPO_ROOT, 'apps/web/node_modules/playwright'), join(REPO_ROOT, 'node_modules/.pnpm/node_modules/playwright')]) {
    try {
      return requireFromRepo(candidate) as PlaywrightLike
    } catch (_error) {}
  }
  throw new Error('playwright is not installed; run pnpm install')
}

/** Run the probe. */
async function main(): Promise<void> {
  const playwright = loadPlaywright()
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-ws-stream-'))
  const evidence = join(REPO_ROOT, 'docs/standalone-w3/evidence/ws-stream-isolation')
  await mkdir(evidence, { recursive: true })
  const provider = new FakeW3Provider()
  const providerUrl = await provider.start()
  const listenPort = await reservePort()
  const app: PlatformApp = await createPlatformApp(w3PlatformConfig({ dataDir, listenPort, providerUrl, repoRoot: REPO_ROOT }))
  const bound = await app.listen()
  const origin = `http://127.0.0.1:${String(bound.port)}`
  const browser = await playwright.chromium.launch({ headless: true })
  const contextA = await browser.newContext({ locale: 'en-US' })
  const contextB = await browser.newContext({ locale: 'en-US' })
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()
  try {
    await signIn(origin, provider.url, contextA, 'a', pageA)
    await signIn(origin, provider.url, contextB, 'b', pageB)
    await pageA.waitForSelector('[data-platform-identity-launcher]', { timeout: 60000 })
    await waitFor('A native page booted', async () => (await pageA.evaluate(() => document.body.innerText)).includes('New Session'), { timeoutMs: 120_000, intervalMs: 500 })
    await waitFor('B native page booted', async () => (await pageB.evaluate(() => document.body.innerText)).includes('New Session'), { timeoutMs: 120_000, intervalMs: 500 })
    const createdA = await rpc(origin, contextA, 'session/create', { request: {} })
    const createdB = await rpc(origin, contextB, 'session/create', { request: {} })
    check(createdA.ok && createdB.ok, 'both identities create a native Session through the Gateway')
    const sessionA = (createdA.value as { sessionId: string }).sessionId
    const sessionB = (createdB.value as { sessionId: string }).sessionId

    const followArgs = { request: { address: { kind: 'session', sessionId: sessionA } } }
    const openedA = await openStream(pageA, 'session/follow', followArgs, 2000)
    check(!openedA.closed, "A's Session event stream stays open")
    const titleA = 'A 的实时 WebSocket 标题'
    const renamedA = await rpc(origin, contextA, 'session/rename', { request: { sessionId: sessionA, title: titleA } })
    check(renamedA.ok, 'A renames its own Session through the Gateway')
    const afterA = await readStream(pageA, 4000)
    check(afterA.frames.some(frame => frame.includes(titleA)), "A's Session stream receives its own rename event")
    await closeStream(pageA)

    const followBArgs = { request: { address: { kind: 'session', sessionId: sessionB } } }
    await openStream(pageB, 'session/follow', followBArgs, 2000)
    await readStream(pageB, 1000)
    const pageBText = await pageB.evaluate(() => document.body.innerText)
    check(!pageBText.includes(titleA), "B's page never shows A's Session title")

    const crossArgs = { request: { address: { kind: 'session', sessionId: sessionA } } }
    const cross = await openStream(pageB, 'session/follow', crossArgs, 2500)
    const crossText = cross.frames.join('\n')
    check(crossText.includes('session/not-found') || crossText.includes('not-found'), "B's Session stream request for A's Session is refused as not-found")
    await closeStream(pageB)

    const revoked = await contextA.request.post(`${origin}/auth/logout`, {
      headers: { 'x-csrf-token': await pageA.evaluate(() => {
        const cookie = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith('dsh_csrf='))
        return cookie === undefined ? '' : decodeURIComponent(cookie.slice('dsh_csrf='.length))
      }) },
    })
    check(revoked.status() === 200, 'identity A signs out its browser session')
    const closedA = await waitFor('A stream closes after sign-out', async () => (await readStream(pageA, 0)).closed, { timeoutMs: 30_000, intervalMs: 500 })
      .then(() => true).catch(() => false)
    check(closedA, "A's Session WebSocket is closed after sign-out")
    await writeFile(join(evidence, 'result.json'), `${JSON.stringify({ sessionA, sessionB, titleA, frames: afterA.frames.length, cross }, null, 2)}\n`)
    await pageA.screenshot({ path: join(evidence, 'a-session-stream.png') })
    await pageB.screenshot({ path: join(evidence, 'b-session-stream.png') })
  } finally {
    await contextA.close().catch(() => undefined)
    await contextB.close().catch(() => undefined)
    await browser.close().catch(() => undefined)
    await app.close().catch(() => undefined)
    await provider.stop().catch(() => undefined)
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
  }
  console.log(`WS STREAM ISOLATION PASS: ${String(assertions)} assertions`)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
}
