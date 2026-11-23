/**
 * Process backend: one child DSH web process per user, on a loopback port.
 *
 * The child receives only the filtered per-user environment; host credentials
 * (`DEEPSEEK_API_KEY`, W3 secrets, platform internal keys, platform database
 * paths) are never part of the whitelist. Readiness is an HTTP answer from the
 * root path, never a fixed delay.
 *
 * @module @deepseek-ai/dsh-platform-services/runtime/process-backend
 */

import type { RuntimeConfig } from '../config.ts'
import { join } from 'node:path'
import {
  defaultSpawn,
  type HttpProbe,
  type RuntimeBackend,
  type RuntimeInspection,
  type RuntimeInstance,
  type RuntimeStartSpec,
  type SpawnFunction,
  type SpawnedProcess,
} from './backend.ts'
import { RuntimeBackendError } from './errors.ts'
import { BoundedTail, findFreePort, probeHttp, redactSecrets, sleep, waitForSettlement } from './support.ts'

/** Environment names copied from the supervisor host into a runtime. */
const INHERITED_ENVIRONMENT = [
  'PATH',
  'SystemRoot',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOME',
  'TMP',
  'TEMP',
  'DSH_CLIENT_VERSION',
] as const

/** `proc-<spaceKeyPrefix>-<pid>-<port>`: the persisted identity of one child process. */
const PROCESS_RUNTIME_ID_PATTERN = /^proc-([0-9a-f]{16})-([0-9]+)-([0-9]+)$/

/** One child process the backend is responsible for. */
interface LiveProcess {
  runtimeId: string
  readonly pid: number
  readonly port: number
  readonly tail: BoundedTail
  readonly child: SpawnedProcess
  readonly exited: Promise<void>
  exitInfo: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null
  startError: Error | null
  stopping: boolean
}

/** Optional injections for the process backend. */
export interface ProcessBackendOptions {
  /** Spawn implementation; tests record argv and environment here. */
  readonly spawn?: SpawnFunction | undefined
  /** Free-port allocator; tests return a fixed port. */
  readonly portAllocator?: (() => Promise<number>) | undefined
  /** Readiness probe; tests answer without binding a port. */
  readonly probe?: HttpProbe | undefined
  /** Clock; tests advance it to reach the start timeout. */
  readonly now?: (() => number) | undefined
  /** Sleep; tests replace it to keep start-timeout cases instant. */
  readonly sleep?: ((durationMs: number) => Promise<void>) | undefined
  /** Host environment the filtered runtime environment is copied from. */
  readonly env?: NodeJS.ProcessEnv | undefined
  /**
   * Explicit extra environment for every started runtime. The supervisor adds
   * these after the filtered allowlist, so an embedded deployment can supply
   * model-provider endpoints or test fixtures without inheriting the host
   * environment. Never populated from host secrets implicitly.
   */
  readonly extraEnv?: Readonly<Record<string, string>> | undefined
  /** Process liveness check; tests inject the answer for adopted pids. */
  readonly isProcessAlive?: ((pid: number) => boolean) | undefined
  /** Interval between readiness probes, in milliseconds. */
  readonly probeIntervalMs?: number | undefined
  /** Per-probe timeout, in milliseconds. */
  readonly probeTimeoutMs?: number | undefined
  /** SIGTERM-to-SIGKILL grace, in milliseconds. */
  readonly stopTimeoutMs?: number | undefined
}

/** Process backend with the diagnostic surface operators use locally. */
export interface ProcessRuntimeBackend extends RuntimeBackend {
  /**
   * Read the retained, credential-redacted output tail of one instance.
   * @param runtimeId - instance identifier.
   * @returns at most the configured tail size of output.
   */
  readDiagnostics(runtimeId: string): string
}

/**
 * Build the persisted runtime id of one child process.
 * @param spaceKey - the user's opaque space key.
 * @param pid - child process id, or zero when the platform did not report one.
 * @param port - loopback port the child listens on.
 * @returns the process runtime id.
 */
export function buildProcessRuntimeId(spaceKey: string, pid: number, port: number): string {
  return `proc-${spaceKey.slice(0, 16)}-${String(pid)}-${String(port)}`
}

/**
 * Parse a persisted process runtime id back into its pid and port.
 * @param runtimeId - persisted runtime id.
 * @returns the pid and port, or null when the id is not a process runtime id.
 */
export function parseProcessRuntimeId(runtimeId: string): { pid: number; port: number } | null {
  const match = PROCESS_RUNTIME_ID_PATTERN.exec(runtimeId)
  if (match === null) return null
  const pid = Number(match[2])
  const port = Number(match[3])
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(port)) return null
  return { pid, port }
}

/**
 * Whether an operating-system process still exists.
 * @param pid - process id to check.
 * @returns true when the process exists or is owned by another user.
 */
function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // `EPERM` means the process exists under another owner; only `ESRCH` proves absence.
    return error !== null && typeof error === 'object' && 'code' in error && error.code === 'EPERM'
  }
}

/**
 * Build the filtered child environment for one runtime.
 * @param config - runtime configuration naming the repository checkout.
 * @param base - supervisor host environment the whitelist copies from.
 * @param spec - per-user start facts.
 * @returns the child environment; forbidden host secrets are absent by construction.
 */
function buildProcessEnvironment(
  base: NodeJS.ProcessEnv,
  config: RuntimeConfig,
  spec: RuntimeStartSpec,
  extraEnv: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const name of INHERITED_ENVIRONMENT) {
    const value = base[name]
    if (value !== undefined) environment[name] = value
  }
  // The child runs with the user workspace as cwd, so tsx must be told which
  // repository tsconfig supplies the workspace path aliases.
  environment.TSX_TSCONFIG_PATH = join(config.repoRoot, 'tsconfig.json')
  environment.DSH_HOME = spec.space.dshHome
  environment.HOME = spec.space.home
  environment.USERPROFILE = spec.space.home
  environment.DSH_AGENTS_HOME = spec.space.agentsHome
  environment.TMP = spec.space.tmp
  environment.TEMP = spec.space.tmp
  environment.DSH_GATEWAY_PUBLIC_KEY_FILE = spec.runtimeAuth.publicKeyFile
  environment.DSH_GATEWAY_ISSUER = spec.runtimeAuth.issuer
  environment.DSH_GATEWAY_AUDIENCE = spec.runtimeAuth.audience
  environment.DSH_GATEWAY_KEY_ID = spec.runtimeAuth.keyId
  environment.DSH_GATEWAY_REPLAY_WINDOW_SECONDS = String(spec.runtimeAuth.replayWindowSeconds)
  environment.DSH_GATEWAY_MAX_LIFETIME_SECONDS = String(spec.runtimeAuth.maxLifetimeSeconds)
  environment.DSH_RUNTIME_SUBJECT = spec.userId
  environment.DSH_RUNTIME_GENERATION = String(spec.generation)
  environment.NO_COLOR = '1'
  for (const [name, value] of Object.entries(extraEnv)) environment[name] = value
  return environment
}

/**
 * Build the DSH argv for one child process.
 * @param config - runtime configuration naming the command prefix and patch.
 * @param spec - per-user start facts.
 * @param port - loopback port to bind.
 * @param bindHost - concrete loopback address to bind.
 * @returns the command name and its arguments.
 */
function buildProcessCommand(
  config: RuntimeConfig,
  spec: RuntimeStartSpec,
  port: number,
  bindHost: string,
): { command: string; args: string[] } {
  const [command, ...prefix] = config.processCommand
  if (command === undefined) {
    throw new RuntimeBackendError('RUNTIME_BACKEND_ERROR', 'process runtime command is not configured')
  }
  return {
    command,
    args: [
      ...prefix,
      'web',
      '--patch',
      spec.patchFile,
      '--no-open',
      '--host',
      bindHost,
      '--port',
      String(port),
      '--public-url',
      spec.publicOrigin,
      '--trusted-host',
      spec.publicAuthority,
    ],
  }
}

/**
 * Attach one bounded output tail to a child stream.
 * @param stream - captured standard output or error.
 * @param tail - buffer receiving the output.
 */
function captureStream(stream: NodeJS.ReadableStream | null, tail: BoundedTail): void {
  if (stream === null) return
  stream.on('data', (chunk: Buffer | string) => {
    tail.append(chunk)
  })
}

/**
 * Create the process-backed runtime backend.
 * @param config - runtime configuration naming the command prefix, patch, and timeouts.
 * @param options - injectable spawn, probe, clock, and process-liveness facts.
 * @returns the backend.
 */
export function createProcessBackend(
  config: RuntimeConfig,
  options: ProcessBackendOptions = {},
): ProcessRuntimeBackend {
  const spawnProcess = options.spawn ?? defaultSpawn
  const probe = options.probe ?? probeHttp
  const now = options.now ?? Date.now
  const sleepFor = options.sleep ?? sleep
  const baseEnvironment = options.env ?? process.env
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive
  const probeIntervalMs = options.probeIntervalMs ?? 250
  const probeTimeoutMs = options.probeTimeoutMs ?? 1_000
  const stopTimeoutMs = options.stopTimeoutMs ?? 10_000
  const bindHost = config.bindHost ?? '127.0.0.1'
  const live = new Map<string, LiveProcess>()
  const diagnostics = new Map<string, BoundedTail>()
  let closed = false

  /**
   * Stop one live child and wait for its exit.
   * @param state - live process state.
   */
  const shutdownLive = async (state: LiveProcess): Promise<void> => {
    state.stopping = true
    if (state.exitInfo !== null || state.startError !== null) return
    state.child.kill('SIGTERM')
    const exited = await waitForSettlement(state.exited, stopTimeoutMs)
    if (exited) return
    state.child.kill('SIGKILL')
    await waitForSettlement(state.exited, 250)
  }

  /**
   * Prove the runtime answers HTTP on its loopback port.
   * @param port - listening port.
   * @returns true when the root answered.
   */
  const probeReady = async (port: number): Promise<boolean> => {
    try {
      return await probe(`http://${bindHost}:${String(port)}/`, probeTimeoutMs)
    } catch {
      // A probe rejection is an unanswered probe; the caller keeps waiting or times out.
      return false
    }
  }

  return {
    async start(spec: RuntimeStartSpec): Promise<RuntimeInstance> {
      if (closed) throw new RuntimeBackendError('RUNTIME_BACKEND_ERROR', 'process backend is closed')
      if (spec.publicOrigin === '') {
        throw new RuntimeBackendError('RUNTIME_BACKEND_ERROR', 'public origin is not configured')
      }
      const allocate = options.portAllocator ?? (() => findFreePort(bindHost))
      let port: number
      try {
        port = await allocate()
      } catch (error) {
        throw new RuntimeBackendError('RUNTIME_BACKEND_ERROR', 'no free loopback port could be allocated', error)
      }
      const { command, args } = buildProcessCommand(config, spec, port, bindHost)
      const environment = buildProcessEnvironment(baseEnvironment, config, spec, options.extraEnv)
      const tail = new BoundedTail()
      let child: SpawnedProcess
      try {
        child = spawnProcess(command, args, {
          cwd: spec.space.defaultWorkspace,
          env: environment,
          windowsHide: true,
        })
      } catch (error) {
        throw new RuntimeBackendError('RUNTIME_BACKEND_ERROR', 'runtime process could not be spawned', error)
      }
      captureStream(child.stdout, tail)
      captureStream(child.stderr, tail)
      let resolveExit: () => void = () => {
        throw new Error('exit promise is not initialized')
      }
      const exited = new Promise<void>(resolve => {
        resolveExit = resolve
      })
      let started = false
      let runtimeId = ''
      const state: LiveProcess = {
        runtimeId: '',
        pid: child.pid ?? 0,
        port,
        tail,
        child,
        exited,
        exitInfo: null,
        startError: null,
        stopping: false,
      }
      child.onExit((code, signal) => {
        state.exitInfo = { code, signal }
        resolveExit()
        if (started && !state.stopping) spec.onExit(runtimeId)
      })
      child.onError(error => {
        state.startError = error
        resolveExit()
      })

      const startedAt = now()
      /**
       * Report the failure that prevented readiness, after stopping the child.
       * @returns never; always throws the classified failure.
       */
      const failBeforeReady = async (): Promise<never> => {
        await shutdownLive(state)
        if (state.startError !== null) {
          throw new RuntimeBackendError('RUNTIME_BACKEND_ERROR', 'runtime process could not be spawned', state.startError)
        }
        throw new RuntimeBackendError('RUNTIME_EXITED', 'runtime process exited before readiness')
      }
      while (true) {
        if (state.exitInfo !== null || state.startError !== null) await failBeforeReady()
        if (await probeReady(port)) break
        if (state.exitInfo !== null || state.startError !== null) await failBeforeReady()
        if (now() - startedAt >= spec.startTimeoutMs) {
          await shutdownLive(state)
          throw new RuntimeBackendError('RUNTIME_START_TIMEOUT', 'runtime did not become ready in time')
        }
        await sleepFor(probeIntervalMs)
      }

      runtimeId = buildProcessRuntimeId(spec.spaceKey, child.pid ?? 0, port)
      state.runtimeId = runtimeId
      started = true
      live.set(runtimeId, state)
      diagnostics.set(runtimeId, tail)
      return { runtimeId, host: bindHost, port, imageDigest: null }
    },

    async stop(runtimeId: string): Promise<void> {
      const parsed = parseProcessRuntimeId(runtimeId)
      if (parsed === null) {
        throw new RuntimeBackendError('RUNTIME_BACKEND_ERROR', 'unrecognized process runtime id')
      }
      const state = live.get(runtimeId)
      if (state !== undefined) {
        await shutdownLive(state)
        live.delete(runtimeId)
        return
      }
      if (!isProcessAlive(parsed.pid)) return
      try {
        process.kill(parsed.pid, 'SIGTERM')
      } catch {
        // The adopted process disappeared between the liveness check and the signal.
        return
      }
      const deadline = now() + stopTimeoutMs
      while (now() < deadline) {
        if (!isProcessAlive(parsed.pid)) return
        await sleepFor(50)
      }
      try {
        process.kill(parsed.pid, 'SIGKILL')
      } catch {
        // The process exited during the grace period; nothing is left to signal.
      }
    },

    async inspect(runtimeId: string): Promise<RuntimeInspection> {
      const parsed = parseProcessRuntimeId(runtimeId)
      if (parsed === null) return { running: false, host: null, port: null }
      const state = live.get(runtimeId)
      const alive = state !== undefined ? state.exitInfo === null && state.startError === null : isProcessAlive(parsed.pid)
      if (!alive) return { running: false, host: null, port: null }
      const running = await probeReady(parsed.port)
      return running
        ? { running: true, host: bindHost, port: parsed.port }
        : { running: false, host: null, port: null }
    },

    async close(): Promise<void> {
      if (closed) return
      closed = true
      const states = [...live.values()]
      live.clear()
      diagnostics.clear()
      await Promise.all(
        states.map(async state => {
          state.stopping = true
          if (state.exitInfo !== null) return
          state.child.kill('SIGKILL')
          await waitForSettlement(state.exited, 1_000)
        }),
      )
    },

    readDiagnostics(runtimeId: string): string {
      return redactSecrets(diagnostics.get(runtimeId)?.read() ?? '')
    },
  }
}
