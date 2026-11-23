/**
 * Process backend: argv, filtered environment, readiness probe, timeout, stop, adopt, close.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { createPlatformConfig, type RuntimeConfig } from '../src/config.ts'
import {
  buildProcessRuntimeId,
  createProcessBackend,
  ensureRuntimeSpaceDirs,
  parseProcessRuntimeId,
  resolveRuntimeSpace,
  RuntimeBackendError,
  type ProcessBackendOptions,
  type RuntimeSpacePaths,
  type RuntimeStartSpec,
  type SpawnFunction,
  type SpawnOptionsLike,
  type SpawnedProcess,
} from '../src/runtime/index.ts'

const SECRET = 'process-test-secret-0123456789abcdef'
const RELEM = 'test-realm'
const USER = 'user-abc_123'
const PORT = 41_000
const PID = 4_242
const temporaryDirectories: string[] = []

/** One recorded spawn call. */
interface SpawnRecord {
  readonly command: string
  readonly args: readonly string[]
  readonly options: SpawnOptionsLike
}

/** Scripted child process used by the spawn recorder. */
class FakeChild implements SpawnedProcess {
  readonly pid: number
  stdout: NodeJS.ReadableStream | null = null
  stderr: NodeJS.ReadableStream | null = null
  readonly signals: (NodeJS.Signals | undefined)[] = []
  private readonly exitListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = []
  private readonly errorListeners: ((error: Error) => void)[] = []
  private exited = false

  /** @param pid - process id reported to the backend. */
  constructor(pid: number) {
    this.pid = pid
  }

  /** @inheritDoc */
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal)
    this.exit(0, null)
    return true
  }

  /** @inheritDoc */
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.push(listener)
  }

  /** @inheritDoc */
  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener)
  }

  /**
   * Report a process exit.
   * @param code - exit code.
   * @param signal - terminating signal.
   */
  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return
    this.exited = true
    for (const listener of [...this.exitListeners]) listener(code, signal)
  }

  /**
   * Report a spawn failure.
   * @param error - failure to report.
   */
  fail(error: Error): void {
    for (const listener of [...this.errorListeners]) listener(error)
  }
}

/**
 * Create a tracked temporary directory.
 * @returns the absolute directory.
 */
async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-runtime-process-'))
  temporaryDirectories.push(directory)
  return directory
}

/**
 * Build one resolved user space under a temporary root.
 * @param root - space root.
 * @returns the resolved space paths, with every directory created.
 */
async function makeSpace(root: string): Promise<RuntimeSpacePaths> {
  const space = resolveRuntimeSpace({ root, realm: RELEM, userId: USER, spaceKeySecret: SECRET })
  await ensureRuntimeSpaceDirs(space)
  return space
}

/**
 * Build the runtime configuration used by the backend under test.
 * @param root - space root.
 * @param dataDir - platform data directory.
 * @returns the runtime configuration.
 */
async function makeRuntimeConfig(root: string, dataDir: string): Promise<RuntimeConfig> {
  const platform = createPlatformConfig({
    dataDir,
    realm: RELEM,
    runtime: {
      root,
      processCommand: ['node', '--import', 'tsx/esm', '/repo/apps/cli/src/bin.ts'],
      patchFile: join(root, 'platform-runtime.patch.yml'),
      startTimeoutMs: 5_000,
      spaceKeySecret: SECRET,
      dockerCommand: 'docker',
    },
  })
  return platform.runtime
}

/**
 * Build one start specification.
 * @param space - resolved user space.
 * @returns the specification.
 */
function makeStartSpec(space: RuntimeSpacePaths): RuntimeStartSpec {
  return {
    realm: RELEM,
    userId: USER,
    spaceKey: space.spaceKey,
    generation: 4,
    space,
    patchFile: join(space.root, 'platform-runtime.patch.yml'),
    runtimeAuth: {
      publicKeyFile: join(space.root, 'gateway-public.pem'),
      issuer: 'dsh-gateway',
      audience: 'dsh-web',
      keyId: 'dsh-gateway-key-v1',
      replayWindowSeconds: 60,
      maxLifetimeSeconds: 300,
    },
    publicOrigin: 'http://127.0.0.1:8080',
    publicAuthority: '127.0.0.1:8080',
    startTimeoutMs: 5_000,
    onExit: () => undefined,
  }
}

/**
 * Build a backend with a recording spawn and scripted dependencies.
 * @param config - runtime configuration.
 * @param overrides - injected spawn, probe, clock, and other options.
 * @returns the backend plus the recorded spawn calls.
 */
function makeBackend(
  config: RuntimeConfig,
  overrides: ProcessBackendOptions = {},
): { backend: ReturnType<typeof createProcessBackend>; records: SpawnRecord[]; children: FakeChild[] } {
  const records: SpawnRecord[] = []
  const children: FakeChild[] = []
  let nextPid = PID
  const spawn: SpawnFunction = (command, args, options) => {
    records.push({ command, args, options })
    const child = new FakeChild(nextPid)
    nextPid += 1
    children.push(child)
    return child
  }
  const backend = createProcessBackend(config, {
    spawn,
    probe: async () => true,
    portAllocator: async () => PORT,
    env: { PATH: '/usr/bin:/bin', SystemRoot: 'C:\\Windows' },
    isProcessAlive: () => false,
    ...overrides,
  })
  return { backend, records, children }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('process backend launch', () => {
  it('spawns the configured command with the documented web flags in the user workspace', async () => {
    const root = await makeTemporaryDirectory()
    const dataDir = await makeTemporaryDirectory()
    const config = await makeRuntimeConfig(root, dataDir)
    const space = await makeSpace(root)
    const spec = makeStartSpec(space)
    const { backend, records } = makeBackend(config)

    const instance = await backend.start(spec)

    expect(records).toHaveLength(1)
    const [record] = records
    expect(record?.command).toBe('node')
    expect(record?.args).toEqual([
      '--import',
      'tsx/esm',
      '/repo/apps/cli/src/bin.ts',
      'web',
      '--patch',
      spec.patchFile,
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      String(PORT),
      '--public-url',
      'http://127.0.0.1:8080',
      '--trusted-host',
      '127.0.0.1:8080',
    ])
    expect(record?.options.cwd).toBe(space.defaultWorkspace)
    expect(instance.host).toBe('127.0.0.1')
    expect(instance.port).toBe(PORT)
    expect(instance.runtimeId).toBe(buildProcessRuntimeId(space.spaceKey, PID, PORT))
    expect(parseProcessRuntimeId(instance.runtimeId)).toEqual({ pid: PID, port: PORT })
    await backend.close()
  })

  it('injects the per-user environment and never the host credentials', async () => {
    const root = await makeTemporaryDirectory()
    const dataDir = await makeTemporaryDirectory()
    const config = await makeRuntimeConfig(root, dataDir)
    const space = await makeSpace(root)
    const spec = makeStartSpec(space)
    const hostSecrets = {
      PATH: '/usr/bin:/bin',
      SystemRoot: 'C:\\Windows',
      DEEPSEEK_API_KEY: 'sk-host-secret',
      W3_CLIENT_SECRET: 'w3-host-secret',
      W3_CLIENT_ID: 'w3-client',
      DSH_INTERNAL_API_KEY: 'internal-host-key',
      DSH_PLATFORM_DATA_DIR: dataDir,
      DSH_GATEWAY_PUBLIC_URL: 'https://platform.example',
      DSH_RUNTIME_KIND: 'process',
      DSH_HOME: '/host/home/.dsh',
    }
    const { backend, records } = makeBackend(config, { env: hostSecrets })

    await backend.start(spec)

    const environment = records[0]?.options.env ?? {}
    expect(environment.DSH_HOME).toBe(space.dshHome)
    expect(environment.HOME).toBe(space.home)
    expect(environment.USERPROFILE).toBe(space.home)
    expect(environment.DSH_AGENTS_HOME).toBe(space.agentsHome)
    expect(environment.TMP).toBe(space.tmp)
    expect(environment.TEMP).toBe(space.tmp)
    expect(environment.DSH_RUNTIME_SUBJECT).toBe(USER)
    expect(environment.DSH_RUNTIME_GENERATION).toBe('4')
    expect(environment.DSH_GATEWAY_PUBLIC_KEY_FILE).toBe(spec.runtimeAuth.publicKeyFile)
    expect(environment.DSH_GATEWAY_ISSUER).toBe('dsh-gateway')
    expect(environment.DSH_GATEWAY_AUDIENCE).toBe('dsh-web')
    expect(environment.DSH_GATEWAY_KEY_ID).toBe('dsh-gateway-key-v1')
    expect(environment.DSH_GATEWAY_REPLAY_WINDOW_SECONDS).toBe('60')
    expect(environment.DSH_GATEWAY_MAX_LIFETIME_SECONDS).toBe('300')
    expect(environment.NO_COLOR).toBe('1')
    expect(environment.PATH).toBe('/usr/bin:/bin')
    expect(environment.SystemRoot).toBe('C:\\Windows')
    for (const forbidden of [
      'DEEPSEEK_API_KEY',
      'W3_CLIENT_SECRET',
      'W3_CLIENT_ID',
      'DSH_INTERNAL_API_KEY',
      'DSH_PLATFORM_DATA_DIR',
      'DSH_GATEWAY_PUBLIC_URL',
      'DSH_RUNTIME_KIND',
    ]) {
      expect(environment[forbidden]).toBeUndefined()
    }
    await backend.close()
  })

  it('copies explicitly supplied runtime environment after the allowlist', async () => {
    const root = await makeTemporaryDirectory()
    const dataDir = await makeTemporaryDirectory()
    const config = await makeRuntimeConfig(root, dataDir)
    const space = await makeSpace(root)
    const { backend, records } = makeBackend(config, {
      env: { PATH: '/usr/bin:/bin' },
      extraEnv: { DEEPSEEK_BASE_URL: 'http://127.0.0.1:8123/v1', DEEPSEEK_API_KEY: 'mock-key' },
    })
    await backend.start(makeStartSpec(space))
    const environment = records[0]?.options.env ?? {}
    expect(environment.DEEPSEEK_BASE_URL).toBe('http://127.0.0.1:8123/v1')
    expect(environment.DEEPSEEK_API_KEY).toBe('mock-key')
    await backend.close()
  })

  it('copies DSH_CLIENT_VERSION only when the host defines it', async () => {
    const root = await makeTemporaryDirectory()
    const dataDir = await makeTemporaryDirectory()
    const config = await makeRuntimeConfig(root, dataDir)
    const space = await makeSpace(root)
    const withVersion = makeBackend(config, {
      env: { PATH: '/usr/bin', DSH_CLIENT_VERSION: '1.2.3' },
    })
    await withVersion.backend.start(makeStartSpec(space))
    expect(withVersion.records[0]?.options.env.DSH_CLIENT_VERSION).toBe('1.2.3')
    await withVersion.backend.close()

    const withoutVersion = makeBackend(config, { env: { PATH: '/usr/bin' } })
    await withoutVersion.backend.start(makeStartSpec(space))
    const environment = withoutVersion.records[0]?.options.env ?? {}
    expect('DSH_CLIENT_VERSION' in environment).toBe(false)
    await withoutVersion.backend.close()
  })
})

describe('process backend readiness and failure', () => {
  it('reports RUNTIME_START_TIMEOUT and terminates the child when the probe never answers', async () => {
    const root = await makeTemporaryDirectory()
    const dataDir = await makeTemporaryDirectory()
    const config = await makeRuntimeConfig(root, dataDir)
    const space = await makeSpace(root)
    let clock = 0
    const { backend, children } = makeBackend(config, {
      probe: async () => false,
      now: () => clock,
      sleep: async () => {
        clock += 60_000
      },
    })
    const spec = { ...makeStartSpec(space), startTimeoutMs: 5_000 }
    await expect(backend.start(spec)).rejects.toMatchObject({ code: 'RUNTIME_START_TIMEOUT' })
    expect(children[0]?.signals).toContain('SIGTERM')
    await backend.close()
  })

  it('reports RUNTIME_EXITED when the child exits before readiness', async () => {
    const root = await makeTemporaryDirectory()
    const dataDir = await makeTemporaryDirectory()
    const config = await makeRuntimeConfig(root, dataDir)
    const space = await makeSpace(root)
    const { backend, children } = makeBackend(config, {
      probe: async () => {
        children[0]?.exit(1, null)
        return false
      },
    })
    await expect(backend.start(makeStartSpec(space))).rejects.toMatchObject({ code: 'RUNTIME_EXITED' })
    await backend.close()
  })

  it('reports RUNTIME_BACKEND_ERROR when the configured spawn fails', async () => {
    const root = await makeTemporaryDirectory()
    const dataDir = await makeTemporaryDirectory()
    const config = await makeRuntimeConfig(root, dataDir)
    const space = await makeSpace(root)
    const spawn: SpawnFunction = (_command, _args, _options) => {
      throw new Error('spawn failed')
    }
    const backend = createProcessBackend(config, { spawn })
    await expect(backend.start(makeStartSpec(space))).rejects.toBeInstanceOf(RuntimeBackendError)
    await backend.close()
  })

  it('reports RUNTIME_BACKEND_ERROR when the child reports a spawn error', async () => {
    const root = await makeTemporaryDirectory()
    const dataDir = await makeTemporaryDirectory()
    const config = await makeRuntimeConfig(root, dataDir)
    const space = await makeSpace(root)
    let child: FakeChild | undefined
    const backend = createProcessBackend(config, {
      spawn: () => {
        child = new FakeChild(PID)
        return child
      },
      probe: async () => {
        child?.fail(new Error('spawn ENOENT'))
        return false
      },
      portAllocator: async () => PORT,
    })
    await expect(backend.start(makeStartSpec(space))).rejects.toMatchObject({ code: 'RUNTIME_BACKEND_ERROR' })
    await backend.close()
  })

  it('rejects a start without a public origin', async () => {
    const root = await makeTemporaryDirectory()
    const dataDir = await makeTemporaryDirectory()
    const config = await makeRuntimeConfig(root, dataDir)
    const space = await makeSpace(root)
    const { backend } = makeBackend(config)
    await expect(backend.start({ ...makeStartSpec(space), publicOrigin: '' })).rejects.toMatchObject({
      code: 'RUNTIME_BACKEND_ERROR',
    })
    await backend.close()
  })

  it('keeps a bounded, credential-redacted output tail', async () => {
    const root = await makeTemporaryDirectory()
    const dataDir = await makeTemporaryDirectory()
    const config = await makeRuntimeConfig(root, dataDir)
    const space = await makeSpace(root)
    const child = new FakeChild(PID)
    const stderr = new PassThrough()
    const stdout = new PassThrough()
    child.stderr = stderr
    child.stdout = stdout
    const backend = createProcessBackend(config, {
      spawn: () => child,
      probe: async () => true,
      portAllocator: async () => PORT,
    })
    const instance = await backend.start(makeStartSpec(space))
    stderr.write('x'.repeat(20_000))
    stderr.write('\nDEEPSEEK_API_KEY=sk-live-secret\n')
    await new Promise(resolve => setTimeout(resolve, 10))
    const tail = backend.readDiagnostics(instance.runtimeId)
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(8_192)
    expect(tail).not.toContain('sk-live-secret')
    expect(tail).toContain('[redacted]')
    await backend.close()
  })
})

describe('process backend inspection, stop, and close', () => {
  it('inspects a running child and an adopted pid', async () => {
    const root = await makeTemporaryDirectory()
    const dataDir = await makeTemporaryDirectory()
    const config = await makeRuntimeConfig(root, dataDir)
    const space = await makeSpace(root)
    const { backend } = makeBackend(config)
    const instance = await backend.start(makeStartSpec(space))
    expect(await backend.inspect(instance.runtimeId)).toEqual({ running: true, host: '127.0.0.1', port: PORT })

    const adoptedId = buildProcessRuntimeId(space.spaceKey, 777, 42_500)
    const adopted = createProcessBackend(config, {
      probe: async () => true,
      isProcessAlive: pid => pid === 777,
    })
    expect(await adopted.inspect(adoptedId)).toEqual({ running: true, host: '127.0.0.1', port: 42_500 })
    expect(await adopted.inspect(buildProcessRuntimeId(space.spaceKey, 778, 42_501))).toEqual({
      running: false,
      host: null,
      port: null,
    })
    expect(await adopted.inspect('not-a-process-runtime')).toEqual({ running: false, host: null, port: null })
    await adopted.close()
    await backend.close()
  })

  it('detects an exit after readiness', async () => {
    const root = await makeTemporaryDirectory()
    const dataDir = await makeTemporaryDirectory()
    const config = await makeRuntimeConfig(root, dataDir)
    const space = await makeSpace(root)
    const exits: string[] = []
    const { backend, children } = makeBackend(config)
    const instance = await backend.start({ ...makeStartSpec(space), onExit: runtimeId => exits.push(runtimeId) })
    children[0]?.exit(1, null)
    expect(exits).toEqual([instance.runtimeId])
    expect(await backend.inspect(instance.runtimeId)).toEqual({ running: false, host: null, port: null })
    await backend.close()
  })

  it('stops a live child with SIGTERM and closes every child', async () => {
    const root = await makeTemporaryDirectory()
    const dataDir = await makeTemporaryDirectory()
    const config = await makeRuntimeConfig(root, dataDir)
    const space = await makeSpace(root)
    const { backend, children } = makeBackend(config)
    const instance = await backend.start(makeStartSpec(space))
    await backend.stop(instance.runtimeId)
    expect(children[0]?.signals).toContain('SIGTERM')

    const second = await backend.start(makeStartSpec(space))
    await backend.close()
    expect(children[1]?.signals).toContain('SIGKILL')
    await expect(backend.start(makeStartSpec(space))).rejects.toMatchObject({ code: 'RUNTIME_BACKEND_ERROR' })
    expect(second.runtimeId).not.toBe(instance.runtimeId)
  })

  it('allocates a free loopback port when no allocator is injected', async () => {
    const root = await makeTemporaryDirectory()
    const dataDir = await makeTemporaryDirectory()
    const config = await makeRuntimeConfig(root, dataDir)
    const space = await makeSpace(root)
    const backend = createProcessBackend(config, {
      spawn: () => new FakeChild(PID),
      probe: async () => true,
    })
    const instance = await backend.start(makeStartSpec(space))
    expect(instance.port).toBeGreaterThan(0)
    expect(instance.port).toBeLessThan(65_536)
    expect(parseProcessRuntimeId(instance.runtimeId)?.port).toBe(instance.port)
    await backend.close()
  })
})

describe('process backend against a real child process', () => {
  it('adopts a still-running child by pid and HTTP probe after a supervisor restart', async () => {
    const root = await makeTemporaryDirectory()
    const dataDir = await makeTemporaryDirectory()
    const script = join(root, 'fake-runtime.mjs')
    await writeFile(
      script,
      [
        "import { createServer } from 'node:http'",
        'const args = process.argv.slice(2)',
        "const port = Number(args[args.indexOf('--port') + 1])",
        "const server = createServer((_request, response) => { response.writeHead(200); response.end('ok') })",
        "server.listen(port, '127.0.0.1')",
        '',
      ].join('\n'),
    )
    const config = await makeRuntimeConfig(root, dataDir)
    const runtimeConfig: RuntimeConfig = { ...config, processCommand: [process.execPath, script] }
    const space = await makeSpace(root)
    const spec = { ...makeStartSpec(space), startTimeoutMs: 15_000 }
    const backend = createProcessBackend(runtimeConfig, {
      probeIntervalMs: 50,
      probeTimeoutMs: 500,
      stopTimeoutMs: 5_000,
    })
    const adopted = createProcessBackend(runtimeConfig, {
      probeIntervalMs: 50,
      probeTimeoutMs: 500,
      stopTimeoutMs: 5_000,
    })
    try {
      const instance = await backend.start(spec)
      expect(instance.port).toBeGreaterThan(0)
      const parsed = parseProcessRuntimeId(instance.runtimeId)
      expect(parsed?.port).toBe(instance.port)
      expect(parsed?.pid).toBeGreaterThan(0)
      // A new backend represents the restarted supervisor; it must find the
      // surviving child through pid liveness and the HTTP probe.
      expect(await adopted.inspect(instance.runtimeId)).toEqual({
        running: true,
        host: '127.0.0.1',
        port: instance.port,
      })
      await adopted.stop(instance.runtimeId)
      await expect
        .poll(async () => await adopted.inspect(instance.runtimeId), { timeout: 10_000 })
        .toEqual({ running: false, host: null, port: null })
    } finally {
      await backend.close()
      await adopted.close()
    }
  }, 30_000)
})
