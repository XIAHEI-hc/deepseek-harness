/**
 * Native browser-automation probe.
 *
 * Starts the platform with an explicitly supplied scripted model provider, seeds
 * the user's web-profile patch with the experimental Playwright MCP browser-use
 * provider, and lets a scripted model call one of that provider's tools from
 * inside the user's real runtime. The assertion covers the native browser
 * automation path: provider activation, per-Session Chromium, upstream MCP tool
 * naming, and the tool result persisted in the Session.
 *
 * Keyless: the scripted LLM replaces a real provider; browser, MCP, and runtime
 * layers are the shipped code.
 *
 * @module @deepseek-ai/dsh-platform-services/tests/e2e/browser-native-probe
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  if (!condition) throw new Error(`browser native probe failed: ${description}`)
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
 * Start the scripted Messages-compatible LLM that answers with one browser tool call.
 * @param port - loopback port.
 * @param toolName - model-facing browser tool name.
 * @param toolArguments - JSON arguments for that tool call.
 * @returns the child process once ready.
 */
async function startMockLlm(port: number, toolName: string, toolArguments: Record<string, unknown>): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, [
    '--import', 'tsx/esm',
    join(REPO_ROOT, 'packages/test-support/llm-mock-server/src/bin.ts'),
    '--port', String(port), '--api-key', 'mock-key',
    '--sequence', 'tool_call_success,success', '--repeat-last',
    '--tool-name', toolName, '--tool-arguments', JSON.stringify(toolArguments),
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
  ].join('\n')
  await writeFile(join(profile, 'cordis.patch.yml'), patch)
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
  const mockPort = await reservePort()
  const mock = await startMockLlm(mockPort, 'mcp__playwright-mcp__browser_navigate', {
    url: 'data:text/html,<title>DSH Browser Probe</title><h1>browser automation works</h1>',
  })
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-browser-native-'))
  const evidence = join(REPO_ROOT, 'docs/standalone-w3/evidence/browser-native')
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
  const context = await browser.newContext({ locale: 'en-US' })
  const page = await context.newPage()
  try {
    const userId = await signIn(origin, provider.url, context, 'a')
    const space = resolveRuntimeSpaceByKey({
      root: config.runtime.root,
      realm: config.realm,
      userId,
      spaceKey: computeSpaceKey(config.runtime.spaceKeySecret, config.realm, userId),
    })
    await seedBrowserProfile(space.dshHome)
    pass('seeded the user web profile with the Playwright MCP browser-use provider')

    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-platform-identity-launcher]', { timeout: 120_000 })
    await waitFor('runtime READY', async () => (await runtimeState(origin, context)) === 'READY', { timeoutMs: 240_000, intervalMs: 1000 })
    pass('the user runtime starts with browser automation enabled')

    const created = await rpc(origin, context, 'session/create', { request: {} })
    check(created.ok, 'the identity creates a Session whose browser MCP connection initializes')
    const sessionId = (created.value as { sessionId: string }).sessionId
    const catalog = await rpc(origin, context, 'session/modelCatalog', {})
    check(catalog.ok, 'the runtime exposes a model catalog')
    const selected = await rpc(origin, context, 'session/selectModel', { request: { sessionId, provider: 'deepseek-official', model: 'deepseek-flash' } })
    check(selected.ok, 'the identity selects a model for its Session')
    const prompt = await rpc(origin, context, 'session/prompt', {
      request: {
        requestId: crypto.randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'Open the probe page in the browser, then finish.' }],
      },
    })
    check(prompt.ok, 'the scripted model submits the prompt turn')

    let toolCall = ''
    let toolResult = ''
    await waitFor('browser tool call and result persist in the Session', async () => {
      const pageResult = await rpc(origin, context, 'session/page', { request: { address: { kind: 'session', sessionId }, maxMessages: 30 } })
      const records = (pageResult.value as { records?: { event?: { type?: string; data?: { name?: string; message?: { content?: { text?: string }[]; isError?: boolean } } } }[] }).records ?? []
      for (const record of records) {
        if (record.event?.type === 'tool/call' && record.event.data?.name === 'mcp__playwright-mcp__browser_navigate') toolCall = 'mcp__playwright-mcp__browser_navigate'
        if (record.event?.type === 'tool/result') {
          const text = record.event.data?.message?.content?.[0]?.text ?? ''
          if (text.includes('browser automation works') || text.includes('DSH Browser Probe')) toolResult = text.slice(0, 500)
        }
      }
      return toolCall !== '' && toolResult !== ''
    }, { timeoutMs: 180_000, intervalMs: 1000 })
    check(toolCall === 'mcp__playwright-mcp__browser_navigate', 'the model-facing browser tool name is mcp__playwright-mcp__browser_navigate')
    check(toolResult !== '', 'the per-Session Chromium navigated and returned the page content to the model turn')
    await writeFile(join(evidence, 'result.json'), `${JSON.stringify({ sessionId, toolCall, toolResult }, null, 2)}\n`)
  } finally {
    await context.close().catch(() => undefined)
    await browser.close().catch(() => undefined)
    await app.close().catch(() => undefined)
    await provider.stop().catch(() => undefined)
    mock.kill('SIGKILL')
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
  }
  console.log(`BROWSER NATIVE PASS: ${String(assertions)} assertions`)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
}
