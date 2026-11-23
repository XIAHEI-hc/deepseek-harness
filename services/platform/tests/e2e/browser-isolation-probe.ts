/**
 * Browser-automation isolation probe.
 *
 * Starts the platform with an explicitly supplied scripted model provider, seeds
 * two identities' web-profile patches with the experimental Playwright MCP
 * browser-use provider, and has each identity's real runtime navigate the same
 * local probe page through that provider's tools.
 *
 * The page echoes the request Cookie and sets one, so the assertions distinguish
 * one Session's persistent browser state from another identity's fresh browser:
 * A's first visit sees no cookie, A's second visit sees only A's cookie, and B's
 * first visit sees no cookie. Each runtime owns its own Chromium and MCP
 * connection, so browser automation state never crosses identities.
 *
 * Keyless: the scripted LLM replaces a real provider; browser, MCP, and runtime
 * layers are the shipped code.
 *
 * @module @deepseek-ai/dsh-platform-services/tests/e2e/browser-isolation-probe
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlatformApp, type PlatformApp } from '../../src/app.ts'
import { computeSpaceKey, resolveRuntimeSpaceByKey } from '../../src/runtime/space.ts'
import { FakeW3Provider, reservePort, waitFor, w3PlatformConfig } from './support.ts'

/** Repository root used to load the Web shell's Playwright dependency. */
const REPO_ROOT = process.cwd()

/** Installed Chromium selected through the provider's `executablePath`. */
const CHROMIUM = process.env.DSH_PROBE_CHROMIUM
  ?? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe')

/** One Gateway HTTP response the probe reads. */
interface HttpResponseLike {
  status(): number
  json(): Promise<unknown>
}

/** One browser page surface used by the probe. */
interface PageLike {
  goto(url: string, options?: { waitUntil?: 'domcontentloaded' | 'load'; timeout?: number }): Promise<unknown>
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>
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
  if (!condition) throw new Error(`browser isolation probe failed: ${description}`)
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
async function rpc(origin: string, context: ContextLike, endpoint: string, args: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown; error?: { code?: string; message?: string } }> {
  const response = await context.request.post(`${origin}/api/${endpoint}`, {
    headers: { 'content-type': 'application/json' },
    data: { type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload: { args } },
  })
  return ((await response.json()) as { result: { ok: boolean; value?: unknown; error?: { code?: string; message?: string } } }).result
}

/**
 * Start the scripted Messages-compatible LLM that answers every turn with one
 * browser navigation tool call.
 * @param port - loopback port.
 * @param url - page every mocked tool call navigates to.
 * @returns the child process once ready.
 */
async function startMockLlm(port: number, url: string): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, [
    '--import', 'tsx/esm',
    join(REPO_ROOT, 'packages/test-support/llm-mock-server/src/bin.ts'),
    '--port', String(port), '--api-key', 'mock-key',
    '--sequence', 'tool_call_success,success,tool_call_success,success,tool_call_success,success',
    '--repeat-last',
    '--tool-name', 'mcp__playwright-mcp__browser_navigate',
    '--tool-arguments', JSON.stringify({ url }),
  ], { cwd: REPO_ROOT, env: { ...process.env, NO_COLOR: '1' } })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  await waitFor('scripted LLM ready', () => output.includes('"type":"ready"'), { timeoutMs: 30_000, intervalMs: 100 })
  return child
}

/**
 * Sign one browser context in through the scripted W3 provider before any page
 * requests the native runtime, so the probe can seed the DSH home first.
 * @param origin - platform origin.
 * @param provider - scripted W3 provider origin.
 * @param context - browser context to authenticate.
 * @param account - scripted account name.
 * @returns the platform user id.
 */
async function signIn(origin: string, provider: string, context: ContextLike, account: string): Promise<string> {
  const control = await context.request.get(`${provider}/__account?account=${account}`, { failOnStatusCode: true })
  if (control.status() !== 200) throw new Error(`W3 test control failed for ${account}`)
  const start = await context.request.get(`${origin}/auth/login?return_to=%2F`)
  if (start.status() !== 200) throw new Error(`login redirect chain failed for ${account}: ${String(start.status())}`)
  const me = await context.request.get(`${origin}/auth/me`)
  const body = (await me.json()) as { user?: { id?: string } }
  const userId = body.user?.id ?? ''
  if (userId === '') throw new Error(`login produced no platform user for ${account}`)
  return userId
}

/**
 * Write the user's web-profile patch that mounts the Playwright MCP browser-use provider.
 * @param dshHome - that user's DSH home.
 */
async function seedBrowserProfile(dshHome: string): Promise<void> {
  const profile = join(dshHome, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  const patch = [
    '- insert:',
    '    - id: browser-use',
    `      name: '@deepseek-ai/dsh-browser-use'`,
    '',
    '    - id: browser-use-playwright-mcp',
    `      name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'`,
    '      config:',
    '        mode: launch',
    '        headless: true',
    `        executablePath: '${CHROMIUM.replaceAll('\\', '/')}'`,
    '',
    '# The scripted model server answers one behavior per request; disable the',
    '# first-prompt title call so model requests line up with the probe turns.',
    '- id: session-title-llm',
    '  disabled: true',
    '',
  ].join('\n')
  await writeFile(join(profile, 'cordis.patch.yml'), patch)
}

/**
 * Read the browser navigation results persisted in one Session.
 * @param origin - platform origin.
 * @param context - browser context carrying the platform cookie.
 * @param sessionId - Session to read.
 * @returns texts of tool results that echo the probe cookie.
 */
async function navigationResults(origin: string, context: ContextLike, sessionId: string): Promise<string[]> {
  const pageResult = await rpc(origin, context, 'session/page', { request: { address: { kind: 'session', sessionId }, maxMessages: 40 } })
  const records = (pageResult.value as { records?: { event?: { type?: string; data?: { message?: { content?: { text?: string }[] } } } }[] }).records ?? []
  const texts: string[] = []
  for (const record of records) {
    if (record.event?.type !== 'tool/result') continue
    const text = record.event.data?.message?.content?.[0]?.text ?? ''
    if (text.includes('probe-cookie-')) texts.push(text)
  }
  return texts
}

/**
 * Submit one browser-navigation prompt and wait for its persisted tool result.
 * @param origin - platform origin.
 * @param context - browser context carrying the platform cookie.
 * @param sessionId - Session to prompt.
 * @param expected - number of cookie results expected after this turn.
 * @returns the newest cookie result text.
 */
async function runBrowserTurn(origin: string, context: ContextLike, sessionId: string, expected: number): Promise<string> {
  const prompt = await rpc(origin, context, 'session/prompt', {
    request: {
      requestId: crypto.randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'Open the probe page in the browser, then finish.' }],
    },
  })
  if (!prompt.ok) throw new Error('browser prompt was not accepted')
  let newest = ''
  try {
    await waitFor(`browser result ${String(expected)}`, async () => {
      const texts = await navigationResults(origin, context, sessionId)
      if (texts.length < expected) return false
      newest = texts[expected - 1] ?? ''
      return newest !== ''
    }, { timeoutMs: 180_000, intervalMs: 1000 })
  } catch (error) {
    const pageResult = await rpc(origin, context, 'session/page', { request: { address: { kind: 'session', sessionId }, maxMessages: 30 } })
    const records = (pageResult.value as { records?: { event?: { type?: string; data?: unknown } }[] }).records ?? []
    console.error('DEBUG browser events:', JSON.stringify(records.map(record => ({
      type: record.event?.type,
      text: JSON.stringify(record.event?.data ?? '').slice(0, 400),
    })), null, 1))
    throw error
  }
  return newest
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
  const pageServer = createServer((request, response) => {
    const cookie = request.headers.cookie ?? ''
    const hasProbe = cookie.split(';').some(part => part.trim().startsWith('dsh_probe='))
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': 'dsh_probe=1; Path=/; SameSite=Lax',
    })
    response.end(`<html><title>probe-cookie-${hasProbe ? 'yes' : 'none'}</title><body><main>probe page</main></body></html>`)
  })
  const pagePort = await reservePort()
  await new Promise<void>((resolve) => { pageServer.listen(pagePort, '127.0.0.1', () => { resolve() }) })
  const probeUrl = `http://127.0.0.1:${String(pagePort)}/probe`
  const mockPort = await reservePort()
  const mock = await startMockLlm(mockPort, probeUrl)
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-isolation-'))
  const evidence = join(REPO_ROOT, 'docs/standalone-w3/evidence/browser-isolation')
  await mkdir(evidence, { recursive: true })
  const provider = new FakeW3Provider()
  const providerUrl = await provider.start()
  const listenPort = await reservePort()
  const config = w3PlatformConfig({ dataDir, listenPort, providerUrl, repoRoot: REPO_ROOT })
  const app: PlatformApp = await createPlatformApp(config, {
    runtimeEnv: { DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(mockPort)}/v1`, DEEPSEEK_API_KEY: 'mock-key' },
  })
  const bound = await app.listen()
  const origin = `http://127.0.0.1:${String(bound.port)}`
  const browser = await playwright.chromium.launch({ headless: true })
  const contextA = await browser.newContext({ locale: 'en-US' })
  const contextB = await browser.newContext({ locale: 'en-US' })
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()
  try {
    const users = await Promise.all([
      signIn(origin, provider.url, contextA, 'a'),
      signIn(origin, provider.url, contextB, 'b'),
    ])
    for (const userId of users) {
      const space = resolveRuntimeSpaceByKey({
        root: config.runtime.root,
        realm: config.realm,
        userId,
        spaceKey: computeSpaceKey(config.runtime.spaceKeySecret, config.realm, userId),
      })
      await seedBrowserProfile(space.dshHome)
    }
    pass('both identities have the Playwright MCP browser-use provider in their own profile')

    await pageA.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })
    await pageA.waitForSelector('[data-platform-identity-launcher]', { timeout: 120_000 })
    await waitFor('runtime A READY', async () => (await runtimeState(origin, contextA)) === 'READY', { timeoutMs: 300_000, intervalMs: 1000 })
    pass('identity A runtime is READY with browser automation enabled')

    const createdA = await rpc(origin, contextA, 'session/create', { request: {} })
    check(createdA.ok, 'identity A creates a Session whose browser MCP connection initializes')
    const sessionA = (createdA.value as { sessionId: string }).sessionId
    const catalogA = await rpc(origin, contextA, 'session/modelCatalog', {})
    check(catalogA.ok, 'identity A runtime exposes a model catalog')
    const selectedA = await rpc(origin, contextA, 'session/selectModel', { request: { sessionId: sessionA, provider: 'deepseek-official', model: 'deepseek-flash' } })
    check(selectedA.ok, 'identity A selects a model for its Session')

    const firstA = await runBrowserTurn(origin, contextA, sessionA, 1)
    check(firstA.includes('probe-cookie-none'), "A's first browser visit has no cookie (fresh per-Session Chromium)")
    const secondA = await runBrowserTurn(origin, contextA, sessionA, 2)
    check(secondA.includes('probe-cookie-yes'), "A's second browser visit sees A's own cookie (state persists inside A's Session browser)")

    await pageB.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })
    await pageB.waitForSelector('[data-platform-identity-launcher]', { timeout: 120_000 })
    await waitFor('runtime B READY', async () => (await runtimeState(origin, contextB)) === 'READY', { timeoutMs: 300_000, intervalMs: 1000 })
    pass('identity B runtime is READY with browser automation enabled')
    const createdB = await rpc(origin, contextB, 'session/create', { request: {} })
    check(createdB.ok, 'identity B creates a Session whose browser MCP connection initializes')
    const sessionB = (createdB.value as { sessionId: string }).sessionId
    const catalogB = await rpc(origin, contextB, 'session/modelCatalog', {})
    check(catalogB.ok, 'identity B runtime exposes a model catalog')
    const selectedB = await rpc(origin, contextB, 'session/selectModel', { request: { sessionId: sessionB, provider: 'deepseek-official', model: 'deepseek-flash' } })
    check(selectedB.ok, 'identity B selects a model for its Session')

    const firstB = await runBrowserTurn(origin, contextB, sessionB, 1)
    check(firstB.includes('probe-cookie-none'), "B's first browser visit sees no cookie, so A's browser state never reaches B")

    const toolNames = await rpc(origin, contextA, 'session/page', { request: { address: { kind: 'session', sessionId: sessionA }, maxMessages: 40 } })
    const calls = ((toolNames.value as { records?: { event?: { type?: string; data?: { name?: string } } }[] }).records ?? [])
      .filter(record => record.event?.type === 'tool/call').map(record => record.event?.data?.name)
    check(calls.every(name => name === 'mcp__playwright-mcp__browser_navigate'), 'both browser turns use the native mcp__playwright-mcp__browser_navigate tool')
    await writeFile(join(evidence, 'result.json'), `${JSON.stringify({ sessionA, sessionB, firstA, secondA, firstB }, null, 2)}\n`)
    await pageA.screenshot({ path: join(evidence, 'a-native-page.png') })
    await pageB.screenshot({ path: join(evidence, 'b-native-page.png') })
  } finally {
    await contextA.close().catch(() => undefined)
    await contextB.close().catch(() => undefined)
    await browser.close().catch(() => undefined)
    await app.close().catch(() => undefined)
    await provider.stop().catch(() => undefined)
    mock.kill('SIGKILL')
    await new Promise<void>((resolve) => { pageServer.close(() => { resolve() }) })
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
  }
  console.log(`BROWSER ISOLATION PASS: ${String(assertions)} assertions`)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
}
