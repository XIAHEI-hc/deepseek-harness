/**
 * Container backend: one unprivileged DSH container per user on a private network.
 *
 * The container gets no published port, no Docker socket, no host root, and no
 * Gateway private key. It mounts only the user's space directories (read-write)
 * and the Gateway public key and runtime overlay (read-only). The runtime binds
 * the container's own IPv4 address, which the backend reserves on the private
 * network before launch because the DSH web server refuses wildcard binds.
 *
 * @module @deepseek-ai/dsh-platform-services/runtime/container-backend
 */

import { exec, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { RuntimeConfig } from '../config.ts'
import {
  type DockerCommandResult,
  type DockerExecutor,
  type HttpProbe,
  type RuntimeBackend,
  type RuntimeInspection,
  type RuntimeInstance,
  type RuntimeStartSpec,
} from './backend.ts'
import { RuntimeBackendError } from './errors.ts'
import { probeHttp, readNumericErrorCode, sleep } from './support.ts'

/** Container name prefix; the opaque space-key prefix makes the name unpredictable. */
const CONTAINER_NAME_PREFIX = 'dsh-rt-'

/** Grace period `docker stop` grants before SIGKILL, in seconds. */
const CONTAINER_STOP_TIMEOUT_SECONDS = 10

/** Bound on linear probing for a free private IPv4 address. */
const CONTAINER_IP_ATTEMPT_LIMIT = 256

/** Docker inspect format printing running state and the container IPv4 address. */
const INSPECT_STATE_FORMAT = '{{.State.Running}}|{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'

/** Docker inspect format printing every IPAM subnet of a network. */
const INSPECT_SUBNET_FORMAT = '{{range .IPAM.Config}}{{.Subnet}} {{end}}'

/** Docker inspect format printing every attached container address of a network. */
const INSPECT_NETWORK_CONTAINERS_FORMAT = '{{range .Containers}}{{.IPv4Address}} {{end}}'

/** Optional injections for the container backend. */
export interface ContainerBackendOptions {
  /** Docker CLI executor; tests assert argv and answer without a daemon. */
  readonly executor?: DockerExecutor | undefined
  /** Readiness probe; tests answer without network reachability. */
  readonly probe?: HttpProbe | undefined
  /** Clock; tests advance it to reach the start timeout. */
  readonly now?: (() => number) | undefined
  /** Sleep; tests replace it to keep start-timeout cases instant. */
  readonly sleep?: ((durationMs: number) => Promise<void>) | undefined
  /** Interval between readiness probes, in milliseconds. */
  readonly probeIntervalMs?: number | undefined
  /** Per-probe timeout, in milliseconds. */
  readonly probeTimeoutMs?: number | undefined
  /** Per-Docker-command timeout, in milliseconds. */
  readonly commandTimeoutMs?: number | undefined
}

/** One observed container state. */
interface ContainerState {
  readonly running: boolean
  readonly ip: string | null
}

/**
 * Quote one argument for the Windows `cmd.exe` bridge.
 * @param value - raw argument.
 * @returns the argument quoted only when `cmd.exe` would otherwise split or expand it.
 */
function quoteForCmd(value: string): string {
  if (!/[\s"&|<>^]/.test(value)) return value
  return `"${value.replaceAll('"', '""')}"`
}

/**
 * Build the default Docker CLI executor.
 *
 * POSIX hosts use `execFile` and therefore shell-free argv. Windows resolves the
 * deployed `docker` forwarding wrapper through `cmd.exe`; that wrapper is the
 * documented development bridge, and no runtime argument carries a shell
 * metacharacter after quoting.
 * @param command - Docker CLI command or wrapper path from `config.dockerCommand`.
 * @param options - per-command timeout.
 * @returns the executor.
 */
export function createDefaultDockerExecutor(
  command: string,
  options: { readonly timeoutMs?: number | undefined } = {},
): DockerExecutor {
  const timeoutMs = options.timeoutMs ?? 60_000
  const maxBuffer = 8 * 1024 * 1024
  return async (args: readonly string[]): Promise<DockerCommandResult> => {
    if (process.platform === 'win32') {
      const line = [command, ...args].map(quoteForCmd).join(' ')
      return await new Promise<DockerCommandResult>(resolveResult => {
        exec(line, { timeout: timeoutMs, maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
          resolveResult({
            stdout: String(stdout),
            stderr: String(stderr),
            exitCode: error === null ? 0 : (readNumericErrorCode(error) ?? 1),
          })
        })
      })
    }
    return await new Promise<DockerCommandResult>(resolveResult => {
      execFile(
        command,
        [...args],
        { timeout: timeoutMs, maxBuffer, windowsHide: true },
        (error, stdout, stderr) => {
          resolveResult({
            stdout: String(stdout),
            stderr: String(stderr),
            exitCode: error === null ? 0 : (readNumericErrorCode(error) ?? 1),
          })
        },
      )
    })
  }
}

/**
 * Derive the container name of one user.
 * @param spaceKey - the user's opaque HMAC space key.
 * @returns the container name; Docker-safe and stable across restarts.
 */
export function containerNameForSpace(spaceKey: string): string {
  return `${CONTAINER_NAME_PREFIX}${spaceKey.slice(0, 16)}`
}

/**
 * Parse one dotted IPv4 address into its unsigned integer form.
 * @param text - address text.
 * @returns the address as an unsigned 32-bit integer, or null when malformed.
 */
function parseIpv4(text: string): number | null {
  const parts = text.trim().split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const byte = Number(part)
    if (byte > 255) return null
    value = value * 256 + byte
  }
  return value >>> 0
}

/**
 * Render one unsigned integer as a dotted IPv4 address.
 * @param value - unsigned 32-bit address value.
 * @returns the dotted address.
 */
function formatIpv4(value: number): string {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.')
}

/**
 * Reserve a stable private IPv4 address for one user on a network subnet.
 *
 * The same space key always asks for the same candidate first, so a restarted
 * runtime keeps its address; a taken address moves to the next free one.
 * @param subnet - network CIDR, for example `172.28.0.0/16`.
 * @param used - addresses already attached to the network.
 * @param spaceKey - the user's opaque space key.
 * @returns a free address, or null when the subnet cannot hold one.
 */
export function pickContainerIp(subnet: string, used: readonly string[], spaceKey: string): string | null {
  const [addressText, prefixText] = subnet.trim().split('/')
  const network = addressText === undefined ? null : parseIpv4(addressText)
  const prefix = prefixText === undefined ? Number.NaN : Number(prefixText)
  if (network === null || !Number.isInteger(prefix) || prefix < 8 || prefix > 30) return null
  const hostBits = 32 - prefix
  const size = 2 ** hostBits
  const first = network + 2
  const last = network + size - 2
  const usable = last - first + 1
  if (usable <= 0) return null
  const usedValues = new Set<number>()
  for (const entry of used) {
    const withoutMask = entry.split('/')[0] ?? ''
    const parsed = parseIpv4(withoutMask)
    if (parsed !== null) usedValues.add(parsed)
  }
  const digest = createHash('sha256').update(spaceKey).digest()
  const seed = digest.readUInt32BE(0)
  const attempts = Math.min(usable, CONTAINER_IP_ATTEMPT_LIMIT)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidate = first + ((seed + attempt) % usable)
    if (!usedValues.has(candidate)) return formatIpv4(candidate)
  }
  return null
}

/**
 * Build the read-write space mounts of one runtime.
 * @param config - runtime configuration naming the container data root.
 * @param spec - per-user start facts.
 * @returns `host:container` mount values.
 */
function buildSpaceMounts(config: RuntimeConfig, spec: RuntimeStartSpec): string[] {
  const pairs: readonly (readonly [string, string])[] = [
    [spec.space.dshHome, posix.join(config.containerDataRoot, 'dsh-home')],
    [spec.space.home, posix.join(config.containerDataRoot, 'home')],
    [spec.space.agentsHome, posix.join(config.containerDataRoot, 'agents-home')],
    [spec.space.workspaces, posix.join(config.containerDataRoot, 'workspaces')],
    [spec.space.uploads, posix.join(config.containerDataRoot, 'uploads')],
    [spec.space.tmp, posix.join(config.containerDataRoot, 'tmp')],
  ]
  return pairs.map(([hostPath, containerPath]) => `${hostPath}:${containerPath}`)
}

/**
 * Build the per-user environment the container receives.
 * @param config - runtime configuration naming container-side paths.
 * @param spec - per-user start facts.
 * @returns `NAME=value` entries, without any host credential.
 */
function buildContainerEnvironment(config: RuntimeConfig, spec: RuntimeStartSpec): string[] {
  return [
    `DSH_HOME=${posix.join(config.containerDataRoot, 'dsh-home')}`,
    `HOME=${posix.join(config.containerDataRoot, 'home')}`,
    `DSH_AGENTS_HOME=${posix.join(config.containerDataRoot, 'agents-home')}`,
    `TMP=${posix.join(config.containerDataRoot, 'tmp')}`,
    `TEMP=${posix.join(config.containerDataRoot, 'tmp')}`,
    // The runtime's working directory is the user's workspace, so the tsx loader
    // resolves the repository tsconfig from the image root rather than the cwd.
    `TSX_TSCONFIG_PATH=${posix.join(config.containerRepoRoot, 'tsconfig.json')}`,
    `DSH_GATEWAY_PUBLIC_KEY_FILE=${config.containerPublicKeyPath}`,
    `DSH_GATEWAY_ISSUER=${spec.runtimeAuth.issuer}`,
    `DSH_GATEWAY_AUDIENCE=${spec.runtimeAuth.audience}`,
    `DSH_GATEWAY_KEY_ID=${spec.runtimeAuth.keyId}`,
    `DSH_GATEWAY_REPLAY_WINDOW_SECONDS=${String(spec.runtimeAuth.replayWindowSeconds)}`,
    `DSH_GATEWAY_MAX_LIFETIME_SECONDS=${String(spec.runtimeAuth.maxLifetimeSeconds)}`,
    `DSH_RUNTIME_SUBJECT=${spec.userId}`,
    `DSH_RUNTIME_GENERATION=${String(spec.generation)}`,
    'NO_COLOR=1',
  ]
}

/**
 * Build the complete `docker run` argv of one runtime.
 * @param config - runtime configuration with limits, image, and container paths.
 * @param spec - per-user start facts.
 * @param containerName - reserved container name.
 * @param ip - private IPv4 address reserved for this container.
 * @returns the Docker CLI argv.
 */
function buildRunArguments(
  config: RuntimeConfig,
  spec: RuntimeStartSpec,
  containerName: string,
  ip: string,
): string[] {
  const args = [
    'run',
    '-d',
    '--name',
    containerName,
    '--label',
    'dsh.platform=1',
    '--network',
    config.network,
    '--ip',
    ip,
    '--cpus',
    config.cpuLimit,
    '--memory',
    `${String(config.memoryLimitMb)}m`,
    '--pids-limit',
    String(config.pidsLimit),
    '--user',
    `${String(config.containerUid)}:${String(config.containerUid)}`,
    // The user's default workspace is the runtime's cwd, matching the process backend.
    '-w',
    posix.join(config.containerDataRoot, 'workspaces', 'default'),
  ]
  for (const mount of buildSpaceMounts(config, spec)) args.push('-v', mount)
  args.push('-v', `${spec.runtimeAuth.publicKeyFile}:${config.containerPublicKeyPath}:ro`)
  args.push('-v', `${spec.patchFile}:${config.containerPatchPath}:ro`)
  for (const entry of buildContainerEnvironment(config, spec)) args.push('-e', entry)
  args.push(
    config.image,
    'web',
    '--patch',
    config.containerPatchPath,
    '--no-open',
    '--host',
    ip,
    '--port',
    String(config.containerPort),
    '--public-url',
    spec.publicOrigin,
    '--trusted-host',
    spec.publicAuthority,
  )
  return args
}

/**
 * Create the container-backed runtime backend.
 * @param config - runtime configuration naming Docker, image, limits, and paths.
 * @param options - injectable executor, probe, clock, and timeouts.
 * @returns the backend.
 */
export function createDockerBackend(
  config: RuntimeConfig,
  options: ContainerBackendOptions = {},
): RuntimeBackend {
  const executor =
    options.executor ??
    createDefaultDockerExecutor(config.dockerCommand, {
      timeoutMs: options.commandTimeoutMs ?? 60_000,
    })
  const probe = options.probe ?? probeHttp
  const now = options.now ?? Date.now
  const sleepFor = options.sleep ?? sleep
  const probeIntervalMs = options.probeIntervalMs ?? 250
  const probeTimeoutMs = options.probeTimeoutMs ?? 1_000
  let closed = false

  /**
   * Run one Docker CLI argv, classifying executor failures as backend errors.
   * @param args - Docker CLI argv.
   * @returns the completed command result.
   */
  const runDocker = async (args: readonly string[]): Promise<DockerCommandResult> => {
    try {
      return await executor(args)
    } catch (error) {
      throw new RuntimeBackendError('RUNTIME_BACKEND_ERROR', 'Docker CLI could not be executed', error)
    }
  }

  /**
   * Observe one container without failing on absence.
   * @param containerName - container name.
   * @returns the observed state, or null when no such container exists.
   */
  const observeContainer = async (containerName: string): Promise<ContainerState | null> => {
    const result = await runDocker(['inspect', '-f', INSPECT_STATE_FORMAT, containerName])
    if (result.exitCode !== 0) return null
    const [runningText = '', ipText = ''] = result.stdout.trim().split('|')
    const ip = ipText.trim()
    return { running: runningText === 'true', ip: ip === '' ? null : ip }
  }

  /**
   * Remove one container if it exists; absence is not a failure.
   * @param containerName - container name.
   */
  const removeContainer = async (containerName: string): Promise<void> => {
    await runDocker(['stop', '-t', String(CONTAINER_STOP_TIMEOUT_SECONDS), containerName])
    await runDocker(['rm', '-f', containerName])
  }

  /**
   * Read the network subnet and the addresses already in use.
   * @returns the subnet and used addresses.
   */
  const readNetworkAddresses = async (): Promise<{ subnet: string; used: string[] }> => {
    const subnetResult = await runDocker(['network', 'inspect', '-f', INSPECT_SUBNET_FORMAT, config.network])
    if (subnetResult.exitCode !== 0) {
      throw new RuntimeBackendError(
        'RUNTIME_BACKEND_ERROR',
        `private network ${JSON.stringify(config.network)} is not available; the deployment must create it`,
      )
    }
    const subnet = subnetResult.stdout.trim().split(/\s+/)[0] ?? ''
    if (subnet === '') {
      throw new RuntimeBackendError('RUNTIME_BACKEND_ERROR', 'private network has no IPv4 subnet')
    }
    const usedResult = await runDocker(['network', 'inspect', '-f', INSPECT_NETWORK_CONTAINERS_FORMAT, config.network])
    const used = usedResult.exitCode === 0 ? usedResult.stdout.trim().split(/\s+/).filter(entry => entry !== '') : []
    return { subnet, used }
  }

  /**
   * Ask the container's runtime root whether it answers HTTP.
   * @param host - container IPv4 address.
   * @returns true when the root answered.
   */
  const probeReady = async (host: string): Promise<boolean> => {
    try {
      return await probe(`http://${host}:${String(config.containerPort)}/`, probeTimeoutMs)
    } catch {
      // A probe rejection is an unanswered probe; the caller keeps waiting or times out.
      return false
    }
  }

  return {
    async start(spec: RuntimeStartSpec): Promise<RuntimeInstance> {
      if (closed) throw new RuntimeBackendError('RUNTIME_BACKEND_ERROR', 'container backend is closed')
      if (spec.publicOrigin === '') {
        throw new RuntimeBackendError('RUNTIME_BACKEND_ERROR', 'public origin is not configured')
      }
      if (spec.runtimeAuth.publicKeyFile === '') {
        throw new RuntimeBackendError('RUNTIME_BACKEND_ERROR', 'gateway public key file is not configured')
      }
      const containerName = containerNameForSpace(spec.spaceKey)
      await removeContainer(containerName)
      const { subnet, used } = await readNetworkAddresses()
      const ip = pickContainerIp(subnet, used, spec.spaceKey)
      if (ip === null) {
        throw new RuntimeBackendError('RUNTIME_BACKEND_ERROR', 'no free private address is available for the runtime')
      }
      const runResult = await runDocker(buildRunArguments(config, spec, containerName, ip))
      if (runResult.exitCode !== 0) {
        throw new RuntimeBackendError(
          'RUNTIME_BACKEND_ERROR',
          `docker run failed with exit code ${String(runResult.exitCode)}`,
        )
      }
      const startedAt = now()
      while (true) {
        const observed = await observeContainer(containerName)
        if (observed === null) {
          await removeContainer(containerName)
          throw new RuntimeBackendError('RUNTIME_BACKEND_ERROR', 'runtime container disappeared during start')
        }
        if (!observed.running) {
          await removeContainer(containerName)
          throw new RuntimeBackendError('RUNTIME_EXITED', 'runtime container exited before readiness')
        }
        const host = observed.ip ?? ip
        if (await probeReady(host)) {
          return { runtimeId: containerName, host, port: config.containerPort, imageDigest: config.image }
        }
        if (now() - startedAt >= spec.startTimeoutMs) {
          await removeContainer(containerName)
          throw new RuntimeBackendError('RUNTIME_START_TIMEOUT', 'runtime container did not become ready in time')
        }
        await sleepFor(probeIntervalMs)
      }
    },

    async stop(runtimeId: string): Promise<void> {
      if (runtimeId === '') {
        throw new RuntimeBackendError('RUNTIME_BACKEND_ERROR', 'runtime id is empty')
      }
      await removeContainer(runtimeId)
    },

    async inspect(runtimeId: string): Promise<RuntimeInspection> {
      if (runtimeId === '') return { running: false, host: null, port: null }
      const observed = await observeContainer(runtimeId)
      if (observed === null || !observed.running || observed.ip === null) {
        return { running: false, host: null, port: null }
      }
      const running = await probeReady(observed.ip)
      return running
        ? { running: true, host: observed.ip, port: config.containerPort }
        : { running: false, host: null, port: null }
    },

    async close(): Promise<void> {
      // Containers keep running so a restarted supervisor can adopt them; data
      // remains in the user's space directories either way.
      closed = true
    },
  }
}
