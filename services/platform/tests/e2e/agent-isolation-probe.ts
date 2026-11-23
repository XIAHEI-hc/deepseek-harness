/**
 * Agent-level isolation probe: concurrent file-writing agents through the real
 * platform runtimes, keyless.
 *
 * Starts the platform application in-process with the scripted W3 provider, lets
 * the supervisor start one real DSH runtime per identity, then runs one headless
 * DSH agent per identity against a scripted Messages-compatible mock LLM server.
 * Each agent is prompted (via the mock tool call) to write a distinct artifact in
 * its own runtime workspace.
 *
 * The probe then proves:
 * - both agents ran against the runtime the platform allocated for that identity;
 * - each artifact exists only in that identity's workspace, never the other's;
 * - the platform's native Session list shows each agent Session only to its owner;
 * - a foreign agent Session id is not addressable from the other runtime.
 *
 * Runs on the host (Windows/Linux) because the headless agents and the process
 * runtime backend both use the repository's tsx source launch.
 *
 * @module @deepseek-ai/dsh-platform-services/tests/e2e/agent-isolation-probe
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPlatformApp, type PlatformApp } from '../../src/app.ts'
import { computeSpaceKey, resolveRuntimeSpaceByKey } from '../../src/runtime/space.ts'
import { FakeW3Provider, reservePort, TestBrowser, waitFor, w3PlatformConfig } from './support.ts'

/** Repository root used to launch the DSH CLI and the mock LLM server. */
const REPO_ROOT = process.cwd()

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
  if (!condition) throw new Error(`agent isolation probe failed: ${description}`)
  pass(description)
}

/**
 * Wait for one child process to exit and return its combined output.
 * @param child - spawned process.
 * @param label - description used in timeout errors.
 * @param timeoutMs - wait budget.
 * @returns exit code and combined output.
 */
async function collect(child: ChildProcessWithoutNullStreams, label: string, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${label} did not finish in ${String(timeoutMs)}ms`))
    }, timeoutMs)
    child.once('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode) })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
  })
  return { code, output }
}

/**
 * Start one scripted mock LLM server.
 * @param port - loopback port to bind.
 * @param artifact - file name the mocked tool call writes.
 * @param value - content of that artifact.
 * @returns the child process and its base URL once ready.
 */
async function startMockLlm(port: number, artifact: string, value: string): Promise<{ child: ChildProcessWithoutNullStreams; baseURL: string }> {
  const toolArguments = JSON.stringify({
    command: `Set-Content -Path ${artifact} -Value ${value}`,
    description: `write ${artifact}`,
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
  await waitFor(`mock LLM on ${String(port)} ready`, () => output.includes('"type":"ready"'), { timeoutMs: 30_000, intervalMs: 100 })
  return { child, baseURL: `http://127.0.0.1:${String(port)}/v1` }
}

/**
 * Login through the scripted W3 provider.
 * @param origin - platform origin.
 * @param provider - fake W3 provider origin.
 * @param browser - that account's browser.
 * @param account - scripted account name.
 * @returns the authenticated user.
 */
async function login(origin: string, provider: string, browser: TestBrowser, account: string): Promise<{ id: string; uid: string }> {
  const choose = await browser.request(`${provider}/__account?account=${account}`)
  if (choose.status !== 200) throw new Error(`W3 test control failed for ${account}`)
  const start = await browser.request(`${origin}/auth/login?return_to=/workspace`)
  let next = await browser.follow(start)
  next = await browser.follow(next)
  const me = await browser.request(`${origin}/auth/me`)
  if (me.status !== 200) throw new Error(`login failed for ${account}`)
  return JSON.parse(me.body).user as { id: string; uid: string }
}

/**
 * Wait until one identity's runtime is READY.
 * @param origin - platform origin.
 * @param browser - authenticated browser.
 */
async function waitReady(origin: string, browser: TestBrowser): Promise<void> {
  await waitFor('runtime READY', async () => {
    const response = await browser.request(`${origin}/api/runtime/me`)
    if (response.status !== 200) return false
    const status = JSON.parse(response.body) as { state: string }
    return status.state === 'READY'
  }, { timeoutMs: 240_000, intervalMs: 1000 })
}

/**
 * Call one Typert Remote endpoint through the gateway.
 * @param origin - platform origin.
 * @param browser - authenticated browser.
 * @param endpoint - endpoint name.
 * @param args - endpoint arguments.
 * @returns business result.
 */
async function rpc(origin: string, browser: TestBrowser, endpoint: string, args: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown; error?: { code: string } }> {
  const response = await browser.request(`${origin}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload: { args } }),
  })
  if (response.status !== 200) throw new Error(`rpc ${endpoint} answered HTTP ${String(response.status)}`)
  return (JSON.parse(response.body) as { result: { ok: boolean; value?: unknown; error?: { code: string } } }).result
}

/**
 * Read the session ids of one `session/list` result.
 * @param result - business result.
 * @returns session ids.
 */
function sessionIds(result: { ok: boolean; value?: unknown }): string[] {
  const items = (result.value as { items?: { sessionId?: unknown }[] } | undefined)?.items ?? []
  return items.map(item => (typeof item.sessionId === 'string' ? item.sessionId : '')).filter(id => id !== '')
}

/** Run one headless agent against a user runtime space and return its Session id. */
async function runAgent(space: { dshHome: string; home: string; agentsHome: string; defaultWorkspace: string }, baseURL: string, task: string): Promise<string> {
  const child = spawn(process.execPath, [
    '--import', pathToFileURL(join(REPO_ROOT, 'node_modules/tsx/dist/esm/index.mjs')).href,
    join(REPO_ROOT, 'apps/cli/src/bin.ts'),
    'headless', '--json', '--permission-mode', 'danger-full-access', '--approval-policy', 'never', task,
  ], {
    cwd: space.defaultWorkspace,
    env: {
      ...process.env,
      DSH_HOME: space.dshHome,
      HOME: space.home,
      USERPROFILE: space.home,
      DSH_AGENTS_HOME: space.agentsHome,
      DEEPSEEK_BASE_URL: baseURL,
      DEEPSEEK_API_KEY: 'mock-key',
      TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json'),
      NO_COLOR: '1',
    },
  })
  const result = await collect(child, 'headless agent', 180_000)
  check(result.code === 0, 'headless agent exited successfully')
  check(result.output.includes('"tool_result"') && result.output.includes('"status":"completed"'), 'agent executed the mocked tool call inside its runtime workspace')
  const session = /"sessionId":"([^"]+)"/.exec(result.output)
  check(session !== null, 'agent reported its Session id')
  return session === null ? '' : session[1] ?? ''
}

/** Run the probe. */
async function main(): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-agent-isolation-'))
  const provider = new FakeW3Provider()
  const providerUrl = await provider.start()
  const listenPort = await reservePort()
  const config = w3PlatformConfig({ dataDir, listenPort, providerUrl, repoRoot: REPO_ROOT })
  const app: PlatformApp = await createPlatformApp(config)
  const bound = await app.listen()
  const origin = `http://127.0.0.1:${String(bound.port)}`
  const mockA = await startMockLlm(await reservePort(), 'artifact-a.txt', 'agentA')
  const mockB = await startMockLlm(await reservePort(), 'artifact-b.txt', 'agentB')
  try {
    const browserA = new TestBrowser(origin)
    const browserB = new TestBrowser(origin)
    const userA = await login(origin, provider.url, browserA, 'a')
    const userB = await login(origin, provider.url, browserB, 'b')
    const pageA = await browserA.request(`${origin}/`)
    const pageB = await browserB.request(`${origin}/`)
    check(pageA.status === 200 && pageB.status === 200, 'both identities reach their native runtime UI')
    await Promise.all([waitReady(origin, browserA), waitReady(origin, browserB)])
    pass('both per-identity runtimes are READY before the agents start')

    const spaceFor = (userId: string) => resolveRuntimeSpaceByKey({
      root: config.runtime.root,
      realm: config.realm,
      userId,
      spaceKey: computeSpaceKey(config.runtime.spaceKeySecret, config.realm, userId),
    })
    const spaceA = spaceFor(userA.id)
    const spaceB = spaceFor(userB.id)
    const [sessionA, sessionB] = await Promise.all([
      runAgent(spaceA, mockA.baseURL, 'Write artifact-a.txt with the pwsh tool, then finish.'),
      runAgent(spaceB, mockB.baseURL, 'Write artifact-b.txt with the pwsh tool, then finish.'),
    ])
    check(sessionA !== '' && sessionB !== '' && sessionA !== sessionB, 'the two concurrent agents produced distinct Sessions')
    check(sessionA.startsWith('session-') && sessionB.startsWith('session-'), 'agent Sessions carry native Session ids')

    check(existsSync(join(spaceA.defaultWorkspace, 'artifact-a.txt')), "A's agent artifact exists in A's workspace")
    check(!existsSync(join(spaceA.defaultWorkspace, 'artifact-b.txt')), "B's agent artifact is absent from A's workspace")
    check(existsSync(join(spaceB.defaultWorkspace, 'artifact-b.txt')), "B's agent artifact exists in B's workspace")
    check(!existsSync(join(spaceB.defaultWorkspace, 'artifact-a.txt')), "A's agent artifact is absent from B's workspace")
    check(!existsSync(join(spaceB.defaultWorkspace, 'artifact-a.txt')) && !existsSync(join(spaceA.defaultWorkspace, 'artifact-b.txt')), 'neither workspace contains the other identity artifact')

    const listA = await rpc(origin, browserA, 'session/list', { _request: {} })
    const listB = await rpc(origin, browserB, 'session/list', { _request: {} })
    check(sessionIds(listA).includes(sessionA), "A's native Session list contains its agent Session")
    check(!sessionIds(listA).includes(sessionB), "A's native Session list does not contain B's agent Session")
    check(sessionIds(listB).includes(sessionB), "B's native Session list contains its agent Session")
    check(!sessionIds(listB).includes(sessionA), "B's native Session list does not contain A's agent Session")
    const foreign = await rpc(origin, browserA, 'session/state', { request: { sessionId: sessionB } })
    check(!foreign.ok, "A cannot read B's agent Session state by id")
    const foreignPage = await rpc(origin, browserA, 'session/page', { request: { address: { kind: 'session', sessionId: sessionB } } })
    check(!foreignPage.ok, "A cannot page B's agent Session events by id")

    const artifactA = await readFile(join(spaceA.defaultWorkspace, 'artifact-a.txt'), 'utf8')
    check(artifactA.trim() === 'agentA', "A's artifact carries A's agent content")
  } finally {
    mockA.child.kill('SIGKILL')
    mockB.child.kill('SIGKILL')
    await app.close().catch(() => undefined)
    await provider.stop().catch(() => undefined)
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
  }
  console.log(`AGENT ISOLATION PASS: ${String(assertions)} assertions`)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
}
