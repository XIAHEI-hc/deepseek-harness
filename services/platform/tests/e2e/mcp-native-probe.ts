/**
 * Native MCP round-trip probe.
 *
 * Starts the platform application in-process with the scripted W3 provider and an
 * explicitly supplied model-provider environment, seeds the user's DSH home
 * profile patch with one stdio MCP server (the repository's fixture server), and
 * lets a scripted model call that server's tool from inside the user's real
 * runtime. The assertion covers the native MCP path end to end: manager
 * configuration, stdio transport, tool discovery, model-facing tool naming,
 * execution in the user runtime, and the tool result persisted in the Session.
 *
 * Keyless: the scripted LLM replaces a real provider; every MCP and runtime layer
 * is the shipped code.
 *
 * @module @deepseek-ai/dsh-platform-services/tests/e2e/mcp-native-probe
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlatformApp, type PlatformApp } from '../../src/app.ts'
import { computeSpaceKey, resolveRuntimeSpaceByKey } from '../../src/runtime/space.ts'
import { FakeW3Provider, reservePort, waitFor, w3PlatformConfig } from './support.ts'

/** Repository root used to load the Web shell's Playwright dependency and fixtures. */
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
}

/** One browser context, including its cookie-sharing API request client. */
interface ContextLike {
  newPage(): Promise<PageLike>
  request: {
    get(url: string, options?: { failOnStatusCode?: boolean; maxRedirects?: number }): Promise<HttpResponseLike>
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
  if (!condition) throw new Error(`mcp native probe failed: ${description}`)
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
 * Start the scripted Messages-compatible LLM that answers with one MCP tool call.
 * @param port - loopback port.
 * @param toolName - model-facing MCP tool name.
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
 * Write the user's web-profile patch that mounts one stdio MCP server.
 * @param dshHome - that user's DSH home.
 * @param loaderUrl - file URL of the tsx ESM loader used for the TS fixture.
 * @param fixture - absolute path of the MCP fixture server.
 */
async function seedMcpProfile(dshHome: string, loaderUrl: string, fixture: string): Promise<void> {
  const profile = join(dshHome, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  const patch = [
    '- id: mcp-manager',
    '  config:',
    '    servers:',
    '      fixtures:',
    '        transport: stdio',
    '        command: node',
    '        args:',
    `          - '--import'`,
    `          - '${loaderUrl}'`,
    `          - '${fixture.replaceAll('\\', '/')}'`,
    '        env:',
    `          TSX_TSCONFIG_PATH: '${join(REPO_ROOT, 'tsconfig.json').replaceAll('\\', '/')}'`,
    '',
  ].join('\n')
  await writeFile(join(profile, 'cordis.patch.yml'), patch)
}

/** Run the probe. */
async function main(): Promise<void> {
  const playwright = createRequire(join(REPO_ROOT, 'apps/web/package.json'))('playwright') as PlaywrightLike
  const mockPort = await reservePort()
  const mock = await startMockLlm(mockPort, 'mcp__fixtures__add', { a: 2, b: 3 })
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-mcp-native-'))
  const evidence = join(REPO_ROOT, 'docs/standalone-w3/evidence/mcp-native')
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
    const loader = (await import('node:module')).createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx/esm')
    const { pathToFileURL } = await import('node:url')
    await seedMcpProfile(
      space.dshHome,
      pathToFileURL(loader).href,
      join(REPO_ROOT, 'packages/mcp/mcp-client/tests/fixture-server.ts'),
    )
    pass('seeded the user web profile with one stdio MCP server')

    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-platform-identity-launcher]', { timeout: 120_000 })
    await waitFor('runtime READY', async () => (await runtimeState(origin, context)) === 'READY', { timeoutMs: 240_000, intervalMs: 1000 })
    pass('the user runtime starts with the MCP manager configured')

    const created = await rpc(origin, context, 'session/create', { request: {} })
    check(created.ok, 'the identity creates a native Session through the Gateway')
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
        content: [{ type: 'text', text: 'Call the MCP add tool and report the result.' }],
      },
    })
    check(prompt.ok, 'the scripted model submits the prompt turn')

    let toolCall = ''
    let toolResult = ''
    await waitFor('MCP tool call and result persist in the Session', async () => {
      const pageResult = await rpc(origin, context, 'session/page', { request: { address: { kind: 'session', sessionId }, maxMessages: 30 } })
      const records = (pageResult.value as { records?: { event?: { type?: string; data?: { name?: string; message?: { content?: { text?: string }[]; isError?: boolean } } } }[] }).records ?? []
      for (const record of records) {
        if (record.event?.type === 'tool/call' && record.event.data?.name === 'mcp__fixtures__add') toolCall = 'mcp__fixtures__add'
        if (record.event?.type === 'tool/result' && record.event.data?.message?.content?.[0]?.text !== undefined) {
          const text = record.event.data.message.content[0].text
          if (text.trim() === '5') toolResult = text.trim()
        }
      }
      return toolCall !== '' && toolResult !== ''
    }, { timeoutMs: 120_000, intervalMs: 1000 })
    check(toolCall === 'mcp__fixtures__add', 'the model-facing MCP tool name is mcp__fixtures__add')
    check(toolResult === '5', 'the MCP stdio server executed the call and returned 5 to the model turn')
    await writeFile(join(evidence, 'result.json'), `${JSON.stringify({ sessionId, toolCall, toolResult }, null, 2)}\n`)
  } finally {
    await context.close().catch(() => undefined)
    await browser.close().catch(() => undefined)
    await app.close().catch(() => undefined)
    await provider.stop().catch(() => undefined)
    mock.kill('SIGKILL')
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
  }
  console.log(`MCP NATIVE PASS: ${String(assertions)} assertions`)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
}
