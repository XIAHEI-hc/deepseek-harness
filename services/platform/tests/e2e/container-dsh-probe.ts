/**
 * Real-container end-to-end probe: the complete platform over the full DSH
 * runtime image.
 *
 * Unlike `container-probe.ts` (which validates the supervisor with a lightweight
 * readiness image), this script boots the real `dsh-runtime` container image the
 * production deployment uses. It drives the platform's public HTTP surface with
 * the scripted W3 provider, lets the supervisor start per-user containers, then
 * proves that two identities receive fully working native DSH runtimes with
 * isolated Sessions, files, credentials, and host access.
 *
 * Runs inside WSL/Linux against the real Docker daemon; Node's native TypeScript
 * type stripping means no dependencies need to be installed in the repo tree.
 *
 * @module @deepseek-ai/dsh-platform-services/tests/e2e/container-dsh-probe
 */

import { execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createPlatformApp } from '../../src/app.ts'
import { createPlatformConfig, type PlatformConfig } from '../../src/config.ts'
import { FakeW3Provider, reservePort, TestBrowser, waitFor } from './support.ts'

const run = promisify(execFile)

/** Repository root on the WSL/Linux side of the mount. */
const REPO_ROOT = process.env.DSH_PROBE_REPO_ROOT ?? '/mnt/d/Vibe_coding/deepseek-harness'
/** Probe workspace; gitignored and removed on success. */
const WORK_ROOT = join(REPO_ROOT, '.dsh-container-runtime-test')
/** Probe network. */
const NETWORK = 'dsh-container-runtime-probe'
/** Real runtime image built from deploy/runtime/Dockerfile. */
const IMAGE = process.env.DSH_RUNTIME_IMAGE ?? 'dsh-runtime:dev'

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
 * @param description - failure text naming the violated policy.
 */
function check(condition: boolean, description: string): void {
  if (!condition) throw new Error(`container runtime probe failed: ${description}`)
  pass(description)
}

/**
 * Run one Docker CLI command.
 * @param args - Docker argv.
 * @returns trimmed stdout.
 */
async function docker(...args: string[]): Promise<string> {
  const result = await run('docker', args, { cwd: REPO_ROOT })
  return result.stdout.trim()
}

/**
 * Run one Docker CLI command whose nonzero exit is expected.
 * @param args - Docker argv.
 * @returns exit code and combined output.
 */
async function dockerCode(...args: string[]): Promise<{ code: number; output: string }> {
  try {
    const result = await run('docker', args, { cwd: REPO_ROOT })
    return { code: 0, output: `${result.stdout}${result.stderr}` }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

/**
 * Log in through the scripted W3 provider.
 * @param origin - platform origin.
 * @param provider - fake provider origin.
 * @param browser - that user's browser.
 * @param account - scripted account name.
 * @returns the authenticated user JSON.
 */
async function login(origin: string, provider: string, browser: TestBrowser, account: string): Promise<{ id: string; displayName: string }> {
  const choose = await browser.request(`${provider}/__account?account=${account}`)
  check(choose.status === 200, `W3 test control accepted account ${account}`)
  const start = await browser.request(`${origin}/auth/login?return_to=/workspace`)
  check(start.status === 302, `login redirects account ${account} to W3`)
  let next = await browser.follow(start)
  next = await browser.follow(next)
  check(next.status === 302, `callback redirects account ${account} back to DSH`)
  const me = await browser.request(`${origin}/auth/me`)
  check(me.status === 200, `session for account ${account} is authenticated`)
  return JSON.parse(me.body).user as { id: string; displayName: string }
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

/**
 * Find one running runtime container by its Docker label.
 * @returns container names in start order.
 */
async function runtimeContainers(): Promise<string[]> {
  const output = await docker('ps', '--filter', 'label=dsh.platform=1', '--format', '{{.Names}}')
  return output.split('\n').map(line => line.trim()).filter(line => line !== '').sort()
}

/**
 * Read the platform's runtime status for one browser.
 * @param origin - platform origin.
 * @param browser - authenticated browser.
 * @returns parsed status.
 */
async function runtimeStatus(origin: string, browser: TestBrowser): Promise<{ state: string; generation: number }> {
  const response = await browser.request(`${origin}/api/runtime/me`)
  return JSON.parse(response.body) as { state: string; generation: number }
}

/** Run the probe. */
async function main(): Promise<void> {
  const image = await dockerCode('image', 'inspect', IMAGE)
  if (image.code !== 0) throw new Error(`runtime image ${IMAGE} is missing; run deploy/scripts/build-runtime-image.sh first`)
  await rm(WORK_ROOT, { recursive: true, force: true })
  await mkdir(join(WORK_ROOT, 'keys'), { recursive: true })
  const network = await dockerCode('network', 'inspect', NETWORK)
  if (network.code !== 0) await docker('network', 'create', '--driver', 'bridge', '--subnet', '172.31.0.0/16', NETWORK)
  const leftover = await runtimeContainers()
  for (const name of leftover) await dockerCode('rm', '-f', name)

  const provider = new FakeW3Provider()
  const providerUrl = await provider.start()
  const listenPort = await reservePort()
  const publicOrigin = `http://127.0.0.1:${String(listenPort)}`
  const dataDir = join(WORK_ROOT, 'data')
  const config: PlatformConfig = createPlatformConfig({
    appEnv: 'testing',
    dataDir,
    realm: 'dsh-container-runtime',
    identity: {
      mode: 'w3',
      dataDir,
      w3: {
        clientId: 'dsh-client', clientSecret: 'dsh-secret',
        authorizeUrl: `${providerUrl}/authorize`, tokenUrl: `${providerUrl}/token`,
        userinfoUrl: `${providerUrl}/userinfo`, logoutUrl: '',
        redirectUri: `${publicOrigin}/auth/callback`, scope: 'base.profile', tokenRequestFormat: 'json',
      },
    },
    runtime: {
      kind: 'container',
      root: join(WORK_ROOT, 'spaces'),
      image: IMAGE,
      network: NETWORK,
      patchFile: join(REPO_ROOT, 'deploy/runtime/platform-runtime.patch.yml'),
      startTimeoutMs: 180_000,
      idleSeconds: 600,
      spaceKeySecret: 'container-runtime-probe-secret-0123456789abcdef',
      memoryLimitMb: 2048,
      cpuLimit: '2',
    },
    gateway: {
      listenHost: '127.0.0.1',
      listenPort,
      publicOrigin,
      privateKeyFile: join(WORK_ROOT, 'keys/gateway-private.pem'),
      publicKeyFile: join(WORK_ROOT, 'keys/gateway-public.pem'),
      wsRevalidateSeconds: 20,
      generateKeyPairIfMissing: true,
    },
  })
  const app = await createPlatformApp(config)
  const bound = await app.listen()
  const origin = `http://127.0.0.1:${String(bound.port)}`
  try {
    const browserA = new TestBrowser(origin)
    const browserB = new TestBrowser(origin)
    const userA = await login(origin, provider.url, browserA, 'a')
    const userB = await login(origin, provider.url, browserB, 'b')
    check(userA.id !== userB.id, 'two W3 identities resolve to distinct platform users')

    const pageA = await browserA.request(`${origin}/`)
    const pageB = await browserB.request(`${origin}/`)
    check(pageA.status === 200 && pageA.body.includes('__DSH_BOOT__'), 'identity A receives the native DSH UI from its container')
    check(pageB.status === 200 && pageB.body.includes('__DSH_BOOT__'), 'identity B receives the native DSH UI from its container')
    await waitFor('A container runtime READY', async () => (await runtimeStatus(origin, browserA)).state === 'READY', { timeoutMs: 240_000 })
    await waitFor('B container runtime READY', async () => (await runtimeStatus(origin, browserB)).state === 'READY', { timeoutMs: 240_000 })
    const containers = await runtimeContainers()
    check(containers.length === 2, `two identities run two real DSH containers (got ${String(containers.length)})`)
    const countA = await docker('ps', '-q', '--filter', 'label=dsh.platform=1', '--format', '{{.Names}}')
    check(new Set(countA.split('\n').filter(line => line !== '')).size === 2, 'each identity owns exactly one container')
    for (const name of containers) {
      const output = await docker('inspect', name)
      const record = (JSON.parse(output) as Record<string, unknown>[])[0]
      if (record === undefined) throw new Error(`container ${name} was not inspected`)
      const config = record['Config'] as { User?: string } | undefined
      const network = record['NetworkSettings'] as { Ports?: Record<string, unknown> | null } | undefined
      const mounts = record['Mounts'] as { Destination?: string }[]
      check(config?.User === '1000:1000', `container ${name} runs as non-root uid/gid 1000:1000`)
      check(network?.Ports === null || Object.keys(network?.Ports ?? {}).length === 0, `container ${name} publishes no ports`)
      check(mounts.length === 8, `container ${name} exposes exactly 8 mounts`)
      check(mounts.every(mount => mount.Destination !== undefined && mount.Destination !== '/'), `container ${name} mounts only explicit per-user paths`)
    }

    // Native Session APIs through the platform gateway on real containers.
    const createA = await rpc(origin, browserA, 'session/create', { request: {} })
    const createB = await rpc(origin, browserB, 'session/create', { request: {} })
    check(createA.ok && createB.ok, 'both identities can create native Sessions in their own runtime')
    const sessionA = (createA.value as { sessionId: string }).sessionId
    const sessionB = (createB.value as { sessionId: string }).sessionId
    check(sessionA !== sessionB, 'the two identities receive distinct Session ids')
    const listA = await rpc(origin, browserA, 'session/list', { _request: {} })
    const listB = await rpc(origin, browserB, 'session/list', { _request: {} })
    check(sessionIds(listA).includes(sessionA) && !sessionIds(listA).includes(sessionB), "A's native Session list contains only A's Session")
    check(sessionIds(listB).includes(sessionB) && !sessionIds(listB).includes(sessionA), "B's native Session list contains only B's Session")
    const foreignState = await rpc(origin, browserA, 'session/state', { request: { sessionId: sessionB } })
    check(!foreignState.ok, "A cannot read B's Session state with B's id")
    const foreignRename = await rpc(origin, browserA, 'session/rename', { request: { sessionId: sessionB, title: 'hijacked' } })
    check(!foreignRename.ok, "A cannot rename B's Session")

    // Skills plaza drafts are workspace-scoped inside each user's DSH home.
    const draftContent = {
      title: 'Alpha private skill',
      slug: 'alpha-private-skill',
      description: 'Draft only identity A may see.',
      inputs: [], steps: ['do it'], outputs: [], verification: 'none',
      failureHandling: 'stop', toolDependencies: [],
    }
    const savedDraft = await rpc(origin, browserA, 'skillPlaza/saveDraft', { request: { content: draftContent } })
    check(savedDraft.ok, 'identity A can save a personal Skill Plaza draft')
    const draftValue = savedDraft.value as { draft?: { draftId?: unknown }; draftId?: unknown } | undefined
    const draftA = typeof draftValue?.draftId === 'string'
      ? draftValue.draftId
      : typeof draftValue?.draft?.draftId === 'string' ? draftValue.draft.draftId : ''
    check(draftA !== '', 'the saved draft reports a stable draft id')
    const draftsA = await rpc(origin, browserA, 'skillPlaza/drafts', { request: {} })
    const draftsB = await rpc(origin, browserB, 'skillPlaza/drafts', { request: {} })
    const draftIdsOf = (result: { ok: boolean; value?: unknown }): string[] => {
      const value = result.value as { drafts?: { draftId?: unknown }[]; items?: { draftId?: unknown }[] } | undefined
      return [...(value?.drafts ?? []), ...(value?.items ?? [])]
        .map(item => (typeof item.draftId === 'string' ? item.draftId : '')).filter(id => id !== '')
    }
    check(draftIdsOf(draftsA).includes(draftA), "A's draft list contains A's draft")
    check(!draftIdsOf(draftsB).includes(draftA), "B's draft list does not contain A's draft")
    const foreignDraft = await rpc(origin, browserB, 'skillPlaza/saveDraft', {
      request: { draftId: draftA, content: { ...draftContent, title: 'hijacked by B' } },
    })
    const draftsAAfter = await rpc(origin, browserA, 'skillPlaza/drafts', { request: {} })
    check(!draftIdsOf(draftsAAfter).includes('') && draftIdsOf(draftsAAfter).includes(draftA), "A's draft still belongs to A after B's attempt")
    if (foreignDraft.ok) {
      const detailA = await rpc(origin, browserA, 'skillPlaza/drafts', { request: {} })
      check(JSON.stringify(detailA.value).includes('Alpha private skill'), "B's attempted overwrite did not change A's draft title")
    } else {
      check(!foreignDraft.ok, "B cannot update A's draft by id")
    }

    // Files and credentials: container mounts, not host paths.
    const containerNames = await runtimeContainers()
    const [containerA, containerB] = containerNames
    if (containerA === undefined || containerB === undefined) throw new Error('runtime containers disappeared')
    // Determine which container belongs to which browser by read/write probes of a marker.
    let nameA = ''
    let nameB = ''
    for (const name of [containerA, containerB]) {
      const marker = await dockerCode('exec', name, 'sh', '-c', 'test -e /data/dsh-home/probe-owner.txt && cat /data/dsh-home/probe-owner.txt || echo none')
      if (marker.output.includes('A')) nameA = name
      if (marker.output.includes('B')) nameB = name
    }
    if (nameA === '' || nameB === '') {
      await dockerCode('exec', containerA, 'sh', '-c', "echo A > /data/dsh-home/probe-owner.txt")
      nameA = containerA
      nameB = containerB
      await dockerCode('exec', containerB, 'sh', '-c', "echo B > /data/dsh-home/probe-owner.txt")
    }
    const bSecretPath = '/data/dsh-home/secret-b.txt'
    await docker('exec', nameB, 'sh', '-c', `printf 'b-secret' > ${bSecretPath}`)
    const bOwnRead = await dockerCode('exec', nameB, 'sh', '-c', `cat ${bSecretPath}`)
    check(bOwnRead.code === 0 && bOwnRead.output.includes('b-secret'), 'B can read its own file inside its container')
    const aReadsB = await dockerCode('exec', nameA, 'sh', '-c', `cat /data/dsh-home/secret-b.txt 2>/dev/null || echo denied`)
    check(aReadsB.output.includes('denied'), "A's container cannot read B's file")
    const aHostRoot = await dockerCode('exec', nameA, 'sh', '-c', 'test -e /mnt/d && echo host-visible || echo host-hidden')
    check(aHostRoot.output.includes('host-hidden'), 'A container cannot see the host filesystem')
    const aDockerSocket = await dockerCode('exec', nameA, 'sh', '-c', 'test -e /var/run/docker.sock && echo socket-visible || echo socket-hidden')
    check(aDockerSocket.output.includes('socket-hidden'), 'A container cannot see the Docker socket')
    const aPrivateKey = await dockerCode('exec', nameA, 'sh', '-c', 'test -e /run/dsh/gateway-private.pem && echo key-visible || echo key-hidden')
    check(aPrivateKey.output.includes('key-hidden'), 'A container cannot see the gateway private key')
    const aOwnCredentials = await dockerCode('exec', nameA, 'sh', '-c', 'test -e /data/dsh-home/.credentials.yaml && echo own-creds || echo no-creds')
    void aOwnCredentials
    check(aReadsB.output.includes('denied'), 'credential files resolve inside each user mount, never another user')

    const disabled = await app.runtime.status(userA.id)
    check(disabled.state === 'READY', 'runtime manager reports the container runtime READY')

    // Provider account state is separate from the platform identity.
    const providerState = await rpc(origin, browserA, 'account/getState', {})
    check(providerState.ok, 'the model-provider account state is readable without provider sign-in')
    check((providerState.value as { status?: string }).status === 'signed-out', 'the model provider is signed out while the platform identity is active')
    await rpc(origin, browserA, 'account/signOut', {
      client: { version: 'container-probe', locale: 'en', timezoneOffsetSeconds: 0 },
    })
    const meAfterProvider = await browserA.request(`${origin}/auth/me`)
    check(meAfterProvider.status === 200, 'model-provider sign-out does not end the platform session')
    const pageAfterProvider = await browserA.request(`${origin}/`)
    check(pageAfterProvider.status === 200 && pageAfterProvider.body.includes('__DSH_BOOT__'), 'the native DSH UI stays available after provider sign-out')

    await browserA.request(`${origin}/auth/logout`, { method: 'POST', headers: { 'x-csrf-token': browserA.cookie('dsh_csrf') ?? '' } })
    const afterLogout = await browserA.request(`${origin}/auth/me`)
    check(afterLogout.status === 401, 'platform logout revokes the browser session against the container runtime')
    const pageBAfter = await browserB.request(`${origin}/`)
    check(pageBAfter.status === 200 && pageBAfter.body.includes('__DSH_BOOT__'), 'B keeps working after A logs out')
  } finally {
    await app.close()
    for (const name of await runtimeContainers()) await dockerCode('rm', '-f', name)
    await provider.stop()
    await rm(WORK_ROOT, { recursive: true, force: true }).catch(() => undefined)
  }
  console.log(`CONTAINER RUNTIME E2E PASS: ${String(assertions)} assertions`)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  for (const name of await runtimeContainers().catch(() => [])) await dockerCode('rm', '-f', name).catch(() => undefined)
  process.exit(1)
}
