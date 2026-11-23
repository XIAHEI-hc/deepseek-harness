/**
 * Background-job isolation probe.
 *
 * Starts the platform application in-process with the scripted W3 provider and an
 * explicitly supplied model-provider environment pointing at the scripted LLM.
 * Identity A prompts its runtime; the scripted model calls the shell tool with
 * `run_in_background`, so A's runtime registers a real background Job. The probe
 * then reads both identities' native `job/list` streams over the Gateway and
 * proves A's Job is invisible and unkillable to B.
 *
 * Keyless: the scripted LLM replaces a real provider; the Job registry, sandbox,
 * Gateway routing, and browser transports are the shipped code.
 *
 * @module @deepseek-ai/dsh-platform-services/tests/e2e/job-isolation-probe
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlatformApp, type PlatformApp } from '../../src/app.ts'
import { FakeW3Provider, reservePort, waitFor, w3PlatformConfig } from './support.ts'

/** Repository root used to load the Web shell's Playwright dependency and the mock LLM. */
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

/** One browser-collected stream frame set. */
interface StreamFrames {
  readonly frames: readonly string[]
  readonly closed: boolean
}

/** One registered background Job read from `job/list`. */
interface JobRow {
  readonly id: string
  readonly label: string
  readonly status: string
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
  if (!condition) throw new Error(`job isolation probe failed: ${description}`)
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
 * Start the scripted Messages-compatible LLM that answers with one background shell tool call.
 * @param port - loopback port.
 * @returns the child process once ready.
 */
async function startMockLlm(port: number): Promise<ChildProcessWithoutNullStreams> {
  const toolArguments = JSON.stringify({
    command: 'Start-Sleep -Seconds 120',
    description: 'long running isolation probe job',
    run_in_background: true,
  })
  const child = spawn(process.execPath, [
    '--import', 'tsx/esm',
    join(REPO_ROOT, 'packages/test-support/llm-mock-server/src/bin.ts'),
    '--port', String(port), '--api-key', 'mock-key',
    '--sequence', 'tool_call_success,success', '--repeat-last',
    '--tool-name', 'pwsh', '--tool-arguments', toolArguments,
  ], { cwd: REPO_ROOT, env: { ...process.env, NO_COLOR: '1' } })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  await waitFor('scripted LLM ready', () => output.includes('"type":"ready"'), { timeoutMs: 30_000, intervalMs: 100 })
  return child
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
 * Open one Remote stream in the page and keep it for later frame reads.
 * @param page - authenticated native page.
 * @param endpoint - stream endpoint name.
 * @param args - endpoint arguments.
 * @param initialMs - collection window after opening.
 * @returns initial frames.
 */
async function openStream(page: PageLike, endpoint: string, args: Record<string, unknown>, initialMs: number): Promise<StreamFrames> {
  return page.evaluate(async ({ endpoint: streamEndpoint, args: streamArgs, initialMs: waitMs }) => {
    const holder = globalThis as unknown as { __dshJobStream?: { socket: WebSocket; frames: string[] } }
    const socket = new WebSocket(`ws://${location.host}/api/remote.mux`)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => { resolve() }, { once: true })
      socket.addEventListener('error', () => { reject(new Error('WebSocket failed to open')) }, { once: true })
    })
    const frames: string[] = []
    socket.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data === 'string') frames.push(event.data)
    })
    socket.send(JSON.stringify({ type: 'open', streamId: 'job-stream', endpoint: streamEndpoint, payload: { args: streamArgs } }))
    await new Promise<void>((resolve) => { setTimeout(resolve, waitMs) })
    holder.__dshJobStream = { socket, frames }
    return { frames: [...frames], closed: socket.readyState === WebSocket.CLOSED }
  }, { endpoint, args, initialMs })
}

/**
 * Read frames accumulated by a stream opened earlier in the page.
 * @param page - authenticated native page.
 * @param waitMs - extra collection window.
 * @returns accumulated frames and whether the socket closed.
 */
async function readStream(page: PageLike, waitMs: number): Promise<StreamFrames> {
  return page.evaluate(async (wait: number) => {
    const holder = globalThis as unknown as { __dshJobStream?: { socket: WebSocket; frames: string[] } }
    if (holder.__dshJobStream === undefined) throw new Error('job stream was not opened')
    const started = Date.now()
    while (Date.now() - started < wait && holder.__dshJobStream.socket.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 100) })
    }
    return { frames: [...holder.__dshJobStream.frames], closed: holder.__dshJobStream.socket.readyState !== WebSocket.OPEN }
  }, waitMs)
}

/**
 * Close the stream opened earlier in the page.
 * @param page - authenticated native page.
 */
async function closeStream(page: PageLike): Promise<void> {
  await page.evaluate(() => {
    const holder = globalThis as unknown as { __dshJobStream?: { socket: WebSocket; frames: string[] } }
    holder.__dshJobStream?.socket.close()
  })
}

/**
 * Parse the registered Jobs out of collected `job/list` frames.
 * @param frames - collected wire frames.
 * @returns the last reported Job rows.
 */
function jobsOf(frames: readonly string[]): JobRow[] {
  let rows: JobRow[] = []
  for (const frame of frames) {
    let message: unknown
    try {
      message = JSON.parse(frame)
    } catch (_error) {
      continue
    }
    const value = (message as { value?: unknown }).value
    if (typeof value !== 'object' || value === null) continue
    const list = (value as { jobs?: unknown }).jobs
    if (!Array.isArray(list)) continue
    rows = list.filter((entry): entry is JobRow => typeof entry === 'object' && entry !== null
      && typeof (entry as { id?: unknown }).id === 'string')
  }
  return rows
}

/** Run the probe. */
async function main(): Promise<void> {
  const playwright = createRequire(join(REPO_ROOT, 'apps/web/package.json'))('playwright') as PlaywrightLike
  const mockPort = await reservePort()
  const mock = await startMockLlm(mockPort)
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-job-isolation-'))
  const evidence = join(REPO_ROOT, 'docs/standalone-w3/evidence/job-isolation')
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
    await signIn(origin, provider.url, contextA, 'a', pageA)
    await signIn(origin, provider.url, contextB, 'b', pageB)
    const createdA = await rpc(origin, contextA, 'session/create', { request: {} })
    const createdB = await rpc(origin, contextB, 'session/create', { request: {} })
    check(createdA.ok && createdB.ok, 'both identities create a native Session through the Gateway')
    const sessionA = (createdA.value as { sessionId: string }).sessionId
    const sessionB = (createdB.value as { sessionId: string }).sessionId
    const catalog = await rpc(origin, contextA, 'session/modelCatalog', {})
    check(catalog.ok, 'A reads the model catalog from its own runtime')
    const selected = await rpc(origin, contextA, 'session/selectModel', { request: { sessionId: sessionA, provider: 'deepseek-official', model: 'deepseek-flash' } })
    check(selected.ok, 'A selects a model for its Session')

    const prompt = await rpc(origin, contextA, 'session/prompt', {
      request: {
        requestId: crypto.randomUUID(),
        sessionId: sessionA,
        mode: 'queue',
        content: [{ type: 'text', text: 'Start a long background job with the shell tool, then finish.' }],
      },
    })
    check(prompt.ok, 'A submits a prompt whose scripted model calls the background shell tool')

    // The scripted model's shell tool call registers the background Job; its tool
    // result names the Job id, which the probe then reads from the job streams.
    let jobId = ''
    await waitFor("A's agent starts the background Job", async () => {
      const pageResult = await rpc(origin, contextA, 'session/page', { request: { address: { kind: 'session', sessionId: sessionA }, maxMessages: 20 } })
      const records = (pageResult.value as { records?: { event?: { type?: string; data?: { message?: { content?: { text?: string }[] } } } }[] }).records ?? []
      for (const record of records) {
        if (record.event?.type !== 'tool/result') continue
        const text = record.event.data?.message?.content?.[0]?.text ?? ''
        const matched = /started background job (\S+)/.exec(text)
        if (matched !== null) jobId = matched[1] ?? ''
      }
      return jobId !== ''
    }, { timeoutMs: 120_000, intervalMs: 1000 })
    check(jobId !== '', "A's agent registered a background Job in A's runtime")

    await openStream(pageA, 'job/list', { request: { sessionId: sessionA } }, 2000)
    const ownFrames = await readStream(pageA, 500)
    const ownJobs = jobsOf(ownFrames.frames)
    check(ownJobs.some(job => job.id === jobId), "A's own job list contains its Job")
    await closeStream(pageA)

    await openStream(pageB, 'job/list', { request: { sessionId: sessionB } }, 1500)
    const foreignFrames = await readStream(pageB, 1000)
    const foreignJobs = jobsOf(foreignFrames.frames)
    check(!foreignJobs.some(job => job.id === jobId), "B's job list never contains A's Job")
    await closeStream(pageB)
    const foreignKill = await rpc(origin, contextB, 'job/kill', { request: { sessionId: sessionA, jobId } })
    check(!foreignKill.ok, "B cannot kill A's Job by id")
    const ownKill = await rpc(origin, contextA, 'job/kill', { request: { sessionId: sessionA, jobId } })
    check(ownKill.ok, "A can kill its own Job")
    await writeFile(join(evidence, 'result.json'), `${JSON.stringify({ sessionA, sessionB, jobId, ownJobs, foreignJobs, foreignKill }, null, 2)}\n`)
  } finally {
    await contextA.close().catch(() => undefined)
    await contextB.close().catch(() => undefined)
    await browser.close().catch(() => undefined)
    await app.close().catch(() => undefined)
    await provider.stop().catch(() => undefined)
    mock.kill('SIGKILL')
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
  }
  console.log(`JOB ISOLATION PASS: ${String(assertions)} assertions`)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
}
