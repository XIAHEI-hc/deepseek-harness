/**
 * Real-container verification for the runtime supervisor.
 *
 * Runs inside WSL/Linux against the real Docker daemon, using the production
 * `createDockerBackend`/`createRuntimeManager` code path and a lightweight probe
 * image that only answers the readiness probe. It proves the container launch
 * policy that unit tests can only describe:
 *
 * - one container per identity, two identities get distinct containers, private
 *   IPs, and disjoint space mounts;
 * - no published ports, fixed non-root UID/GID, CPU/memory/PID limits;
 * - the user container cannot see the Docker socket, the gateway private key,
 *   the host filesystem, or the other user's space directory;
 * - same identity reuses one container, and a restarted supervisor adopts the
 *   running container instead of starting a second one;
 * - a stopped container is detected as FAILED, retry restarts a new generation,
 *   and the persisted space data survives.
 *
 * Invoked by `deploy/scripts/verify-container-isolation.sh` through WSL's Node
 * (native TypeScript type stripping), so it needs no installed dependencies.
 *
 * @module @deepseek-ai/dsh-platform-services/tests/e2e/container-probe
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createRuntimeManager } from '../../src/runtime/manager.ts'
import { containerNameForSpace } from '../../src/runtime/container-backend.ts'
import { computeSpaceKey, resolveRuntimeSpaceByKey } from '../../src/runtime/space.ts'
import type { RuntimeConfig } from '../../src/config.ts'
import type { RuntimeEnsureResult } from '../../src/contracts.ts'

const run = promisify(execFile)

/** Repository root on the WSL/Linux side of the mount. */
const REPO_ROOT = process.env.DSH_PROBE_REPO_ROOT ?? '/mnt/d/Vibe_coding/deepseek-harness'
/** Probe workspace; gitignored and removed on success. */
const WORK_ROOT = join(REPO_ROOT, '.dsh-container-test')
/** Docker network reserved by the probe. */
const NETWORK = 'dsh-container-probe'
/** Lightweight runtime image answered by the probe entrypoint. */
const IMAGE = 'dsh-runtime-probe:test'
/** Platform identity secret used for the probe space key. */
const SPACE_SECRET = 'container-probe-space-key-0123456789abcdef'
/** Realm used by the probe registry. */
const REALM = 'dsh-container-probe'

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
  if (!condition) throw new Error(`container probe failed: ${description}`)
  pass(description)
}

/**
 * Run one Docker CLI command and return stdout.
 * @param args - Docker argv after the binary.
 * @returns trimmed standard output.
 */
async function docker(...args: string[]): Promise<string> {
  const result = await run('docker', args, { cwd: WORK_ROOT })
  return result.stdout.trim()
}

/**
 * Run one Docker CLI command whose nonzero exit is expected to be observable.
 * @param args - Docker argv after the binary.
 * @returns exit code and combined output.
 */
async function dockerCode(...args: string[]): Promise<{ code: number; output: string }> {
  try {
    const result = await run('docker', args, { cwd: WORK_ROOT })
    return { code: 0, output: `${result.stdout}${result.stderr}` }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

/**
 * Read one container as JSON.
 * @param name - container name.
 * @returns the first inspect record.
 */
async function inspect(name: string): Promise<Record<string, unknown>> {
  const output = await docker('inspect', name)
  const parsed = JSON.parse(output) as Record<string, unknown>[]
  const first = parsed[0]
  if (first === undefined) throw new Error(`container ${name} was not inspected`)
  return first
}

/**
 * Read a nested field from an unknown JSON object.
 * @param value - container record or nested object.
 * @param path - dot-separated field path.
 * @returns the value, or undefined when absent.
 */
function field(value: unknown, path: string): unknown {
  let current: unknown = value
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/**
 * Execute a Node script inside one container.
 * @param container - container name.
 * @param script - Node one-liner.
 * @returns trimmed stdout.
 */
async function nodeIn(container: string, script: string): Promise<string> {
  return docker('exec', container, 'node', '-e', script)
}

/**
 * Ensure the probe network exists with an IPv4 subnet the supervisor can allocate from.
 */
async function ensureNetwork(): Promise<void> {
  const existing = await dockerCode('network', 'inspect', NETWORK)
  if (existing.code === 0) return
  await docker('network', 'create', '--driver', 'bridge', '--subnet', '172.30.0.0/16', NETWORK)
  pass('created probe bridge network with IPv4 subnet')
}

/** Ensure the lightweight probe image exists. */
async function ensureImage(): Promise<void> {
  const existing = await dockerCode('image', 'inspect', IMAGE)
  if (existing.code === 0) return
  await docker('build', '-t', IMAGE, join(REPO_ROOT, 'deploy/tests/probe-runtime'))
  pass('built probe runtime image')
}

/** Remove containers created by earlier probe runs, leaving the network. */
async function cleanupContainers(): Promise<void> {
  const names = await dockerCode('ps', '-a', '--filter', 'label=dsh.platform=1', '--format', '{{.Names}}')
  if (names.code !== 0) return
  for (const name of names.output.split('\n').map(line => line.trim()).filter(line => line !== '')) {
    await dockerCode('rm', '-f', name)
  }
}

/**
 * Build the runtime configuration for the probe.
 * @param dataDir - platform data directory under the probe workspace.
 * @returns the runtime configuration the manager receives.
 */
function probeConfig(dataDir: string): { config: RuntimeConfig & { dataDir: string; realm: string } } {
  return {
    config: {
      kind: 'container',
      spaceKeySecret: SPACE_SECRET,
      root: join(WORK_ROOT, 'spaces'),
      idleSeconds: 600,
      reapIntervalMs: 60_000,
      repoRoot: REPO_ROOT,
      processCommand: [],
      image: IMAGE,
      dockerCommand: 'docker',
      network: NETWORK,
      containerDataRoot: '/data',
      containerPublicKeyPath: '/run/dsh/gateway-public.pem',
      containerPatchPath: '/run/dsh/platform-runtime.patch.yml',
      containerRepoRoot: '/app',
      containerPort: 3080,
      containerUid: 1000,
      bindHost: undefined,
      publicAuthority: '127.0.0.1:8080',
      patchFile: join(REPO_ROOT, 'deploy/runtime/platform-runtime.patch.yml'),
      startTimeoutMs: 60_000,
      cpuLimit: '1',
      memoryLimitMb: 512,
      pidsLimit: 256,
      maxConcurrentStarts: 2,
      urlBasePath: '',
      dataDir,
      realm: REALM,
    },
  }
}

/**
 * Build manager options for the probe.
 * @param dataDir - platform data directory under the probe workspace.
 * @returns assertion facts and public facts.
 */
function probeOptions(dataDir: string): {
  runtimeAuth: { publicKeyFile: string; issuer: string; audience: string; keyId: string; replayWindowSeconds: number; maxLifetimeSeconds: number }
  publicOrigin: string
  publicAuthority: string
  dataDir: string
  inspectIntervalMs: number
} {
  return {
    runtimeAuth: {
      publicKeyFile: join(WORK_ROOT, 'keys/gateway-public.pem'),
      issuer: 'dsh-gateway',
      audience: 'dsh-web',
      keyId: 'dsh-gateway-key-v1',
      replayWindowSeconds: 60,
      maxLifetimeSeconds: 300,
    },
    publicOrigin: 'http://127.0.0.1:8080',
    publicAuthority: '127.0.0.1:8080',
    dataDir,
    // Inspect on every ensure so an externally stopped container is observed
    // immediately instead of being served from the READY target cache.
    inspectIntervalMs: 0,
  }
}

/** Throw unless one ensure result is READY with a target. */
function expectReady(result: RuntimeEnsureResult, label: string): RuntimeEnsureResult {
  check(result.state === 'READY', `${label} runtime is READY`)
  check(result.target !== undefined, `${label} runtime returns a private target`)
  return result
}

/**
 * Wait for a condition with a short poll budget.
 * @param description - failure text.
 * @param probe - condition to satisfy.
 * @param timeoutMs - total wait budget.
 */
async function waitUntil(description: string, probe: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe()) {
      pass(description)
      return
    }
    await new Promise<void>(resolve => { setTimeout(resolve, 100) })
  }
  throw new Error(`container probe failed: timed out waiting for ${description}`)
}

/** Run the full probe. */
async function main(): Promise<void> {
  await rm(WORK_ROOT, { recursive: true, force: true })
  await mkdir(join(WORK_ROOT, 'keys'), { recursive: true })
  await writeFile(join(WORK_ROOT, 'keys/gateway-public.pem'), 'probe public key\n')
  await writeFile(join(WORK_ROOT, 'keys/gateway-private.pem'), 'probe private key\n')
  await rm(join(WORK_ROOT, 'keys/gateway-private.pem'), { force: true })
  await ensureNetwork()
  await ensureImage()
  await cleanupContainers()

  const dataDir = join(WORK_ROOT, 'runtime')
  const { config } = probeConfig(dataDir)
  const options = probeOptions(dataDir)
  const manager = await createRuntimeManager(config, options)

  const userA = 'probe-user-a'
  const userB = 'probe-user-b'
  const spaceA = computeSpaceKey(SPACE_SECRET, REALM, userA)
  const spaceB = computeSpaceKey(SPACE_SECRET, REALM, userB)
  const nameA = containerNameForSpace(spaceA)
  const nameB = containerNameForSpace(spaceB)

  const a = expectReady(await manager.ensure(userA), 'user A')
  const inspectA = await inspect(nameA)
  check(a.target?.host === String(field(inspectA, `NetworkSettings.Networks.${NETWORK}.IPAddress`)), 'A target host is the container private IP')
  check(a.target?.port === 3080, 'A target port is the container runtime port')
  check(field(inspectA, 'Config.User') === '1000:1000', 'A container runs as fixed non-root uid/gid 1000:1000')

  const ports = field(inspectA, 'NetworkSettings.Ports') as Record<string, unknown> | null | undefined
  check(ports === null || ports === undefined || Object.keys(ports).length === 0, 'A container publishes no ports')
  check(field(inspectA, 'HostConfig.NetworkMode') === NETWORK, 'A container joins only the private network')
  check(field(inspectA, 'HostConfig.Memory') === 512 * 1024 * 1024, 'A container has the configured 512 MiB memory limit')
  check(field(inspectA, 'HostConfig.NanoCpus') === 1_000_000_000, 'A container has the configured 1 CPU limit')
  check(field(inspectA, 'HostConfig.PidsLimit') === 256, 'A container has the configured 256 PID limit')

  const mounts = field(inspectA, 'Mounts') as { Source?: string; Destination?: string; RW?: boolean }[]
  check(mounts.length === 8, `A container has exactly 8 mounts (space dirs + public key + overlay), got ${String(mounts.length)}`)
  const readOnly = mounts.filter(mount => mount.RW === false).map(mount => mount.Source ?? '')
  check(readOnly.length === 2, 'exactly two mounts are read-only (public key and runtime overlay)')
  check(readOnly.every(source => !source.includes('private')), 'no mount exposes the gateway private key')
  check(mounts.every(mount => !(mount.Source ?? '').includes('docker.sock')), 'no mount exposes the Docker socket')
  check(mounts.every(mount => !(mount.Source ?? '').endsWith('/spaces')), 'no container mounts the whole spaces root')
  const destinations = mounts.map(mount => mount.Destination ?? '')
  for (const expected of ['/data/dsh-home', '/data/home', '/data/agents-home', '/data/workspaces', '/data/uploads', '/data/tmp', '/run/dsh/gateway-public.pem', '/run/dsh/platform-runtime.patch.yml']) {
    check(destinations.includes(expected), `A container mounts ${expected}`)
  }

  const aDirs = resolveRuntimeSpaceByKey({ root: config.root, realm: REALM, userId: userA, spaceKey: spaceA })
  const bDirs = resolveRuntimeSpaceByKey({ root: config.root, realm: REALM, userId: userB, spaceKey: spaceB })
  check(aDirs.dshHome !== bDirs.dshHome, 'A and B resolve different DSH_HOME paths')
  await nodeIn(nameA, "require('node:fs').writeFileSync('/data/dsh-home/marker-a','A')")
  pass('A can write inside its own DSH_HOME mount')
  const isolation = await nodeIn(nameA, `
    const fs = require('node:fs')
    const report = {
      uid: process.getuid(),
      dockerSocket: fs.existsSync('/var/run/docker.sock'),
      privateKey: fs.existsSync('/run/dsh/gateway-private.pem'),
      hostRoot: fs.existsSync('/mnt/d'),
      bSpace: fs.existsSync(${JSON.stringify(bDirs.dshHome)}),
    }
    console.log(JSON.stringify(report))
  `)
  const isolated = JSON.parse(isolation) as { uid: number; dockerSocket: boolean; privateKey: boolean; hostRoot: boolean; bSpace: boolean }
  check(isolated.uid === 1000, 'A process runs as uid 1000 inside the container')
  check(isolated.dockerSocket === false, 'A container cannot see /var/run/docker.sock')
  check(isolated.privateKey === false, 'A container cannot see the gateway private key')
  check(isolated.hostRoot === false, 'A container has no host filesystem mount')
  check(isolated.bSpace === false, "A container cannot see B's space directory")

  const b = expectReady(await manager.ensure(userB), 'user B')
  check(b.target?.host !== a.target?.host, 'A and B run in containers with different private IPs')
  await nodeIn(nameB, "require('node:fs').writeFileSync('/data/dsh-home/marker-b','B')")
  const bIsolation = await nodeIn(nameB, `
    const fs = require('node:fs')
    console.log(JSON.stringify({ markerA: fs.existsSync('/data/dsh-home/marker-a'), markerB: fs.existsSync('/data/dsh-home/marker-b') }))
  `)
  const bReport = JSON.parse(bIsolation) as { markerA: boolean; markerB: boolean }
  check(bReport.markerA === false, "B cannot read A's marker file")
  check(bReport.markerB === true, 'B can read its own marker file')

  const againA = expectReady(await manager.ensure(userA), 'same-user second ensure')
  check(againA.target?.host === a.target?.host, 'same identity reuses the same container target')
  const countA = await docker('ps', '-q', '--filter', `name=^${nameA}$`)
  check(countA.split('\n').filter(line => line !== '').length === 1, 'same identity still has exactly one container')

  const adoptedManager = await createRuntimeManager(config, options)
  const adopted = expectReady(await adoptedManager.ensure(userA), 'supervisor restart adoption')
  check(adopted.target?.host === a.target?.host, 'restarted supervisor adopts the running container')
  check(adopted.generation === againA.generation, 'adoption keeps the same generation')
  const countAdopted = await docker('ps', '-q', '--filter', `name=^${nameA}$`)
  check(countAdopted.split('\n').filter(line => line !== '').length === 1, 'adoption starts no second container')
  await adoptedManager.close()

  await docker('stop', '-t', '1', nameA)
  const failed = await manager.ensure(userA)
  check(failed.state === 'FAILED', 'a stopped container is detected as FAILED')
  check(failed.retryable, 'the FAILED runtime is explicitly retryable')
  const retried = expectReady(await manager.retry(userA), 'retry after container stop')
  check(retried.generation > againA.generation, 'retry starts a new generation')
  const marker = await nodeIn(nameA, "console.log(require('node:fs').readFileSync('/data/dsh-home/marker-a','utf8'))")
  const retriedInspect = await inspect(nameA)
  const retriedMounts = field(retriedInspect, 'Mounts') as { Source?: string; Destination?: string }[]
  check(marker === 'A', `retry keeps the persisted user data (read ${JSON.stringify(marker)} from ${JSON.stringify(retriedMounts.find(mount => mount.Destination === '/data/dsh-home')?.Source ?? 'missing mount')})`)

  await manager.close()

  // Idle reclamation and leases, exercised against real containers. A positive
  // (but tiny) idle window enables the reaper; a zero window disables it.
  const idleConfig = { ...config, idleSeconds: 0.001, reapIntervalMs: 100 }
  const idleManager = await createRuntimeManager(idleConfig, options)
  const bBeforeIdle = expectReady(await idleManager.ensure(userB), 'idle test adoption')
  const releaseLease = idleManager.lease(userB)
  await new Promise<void>(resolve => { setTimeout(resolve, 400) })
  const leased = await idleManager.status(userB)
  check(leased.state === 'READY', 'a held lease prevents idle reclamation')
  releaseLease()
  await waitUntil('releasing the lease lets the idle reaper stop the container', async () => {
    const status = await idleManager.status(userB)
    return status.state === 'STOPPED'
  })
  const bDirsAfterIdle = resolveRuntimeSpaceByKey({ root: config.root, realm: REALM, userId: userB, spaceKey: spaceB })
  const persistedB = await readFile(join(bDirsAfterIdle.dshHome, 'marker-b'), 'utf8')
  check(persistedB === 'B', 'idle reclamation preserves the user data')
  const bAfterIdle = expectReady(await idleManager.ensure(userB), 'visit after idle reclamation')
  check(bAfterIdle.generation > bBeforeIdle.generation, 'the next visit starts a new generation')
  const persistedBa = await readFile(join(bDirsAfterIdle.dshHome, 'marker-b'), 'utf8')
  check(persistedBa === 'B', 'the user data survives the idle restart')
  await idleManager.close()

  await cleanupContainers()
  pass('container probe cleaned up its containers')
  console.log(`CONTAINER E2E PASS: ${String(assertions)} assertions`)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  await cleanupContainers().catch(() => {})
  process.exit(1)
}
