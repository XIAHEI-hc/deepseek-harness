/**
 * The runtime backend seam: one process or container per user.
 *
 * The manager owns the lifecycle and the registry; a backend only starts, stops,
 * and inspects the operating-system fact for one instance. Tests replace the
 * whole backend so lifecycle, reclamation, and reconciliation never need a real
 * DSH runtime.
 *
 * @module @deepseek-ai/dsh-platform-services/runtime/backend
 */

import { spawn } from 'node:child_process'
import type { RuntimeSpacePaths } from './space.ts'

/** Assertion facts the supervisor stamps on every runtime it launches. */
export interface RuntimeAssertionFacts {
  /** PEM public key the runtime verifies gateway assertions with. */
  readonly publicKeyFile: string
  /** Assertion issuer the runtime accepts. */
  readonly issuer: string
  /** Assertion audience the runtime accepts. */
  readonly audience: string
  /** Key id the runtime accepts. */
  readonly keyId: string
  /** Replay window the runtime keeps, in seconds. */
  readonly replayWindowSeconds: number
  /** Longest assertion lifetime the runtime policy accepts, in seconds. */
  readonly maxLifetimeSeconds: number
}

/** Everything a backend needs to launch one user runtime. */
export interface RuntimeStartSpec {
  /** Deployment realm. */
  readonly realm: string
  /** Internal user id; it is also the fixed assertion subject. */
  readonly userId: string
  /** Opaque space key naming the user's directory and container. */
  readonly spaceKey: string
  /** Generation the runtime binds its assertion verification to. */
  readonly generation: number
  /** Resolved directories of the user's space. */
  readonly space: RuntimeSpacePaths
  /** Cordis overlay that enables the gateway identity provider. */
  readonly patchFile: string
  /** Assertion facts written into the runtime environment. */
  readonly runtimeAuth: RuntimeAssertionFacts
  /** Public HTTP(S) origin the runtime advertises. */
  readonly publicOrigin: string
  /** Public host authority the runtime's browser-trust fence accepts. */
  readonly publicAuthority: string
  /** Longest accepted cold start in milliseconds. */
  readonly startTimeoutMs: number
  /**
   * Report that the launched instance exited after `start` resolved.
   * @param runtimeId - instance identifier the backend assigned.
   */
  readonly onExit: (runtimeId: string) => void
}

/** One running runtime instance the backend can address. */
export interface RuntimeInstance {
  /** Backend instance identifier persisted as `runtime_id`. */
  readonly runtimeId: string
  /** Loopback or private-network host the supervisor connects to. */
  readonly host: string
  /** Port the runtime listens on. */
  readonly port: number
  /** Immutable image identity, when the backend has one. */
  readonly imageDigest: string | null
}

/** What a backend observes about one instance right now. */
export interface RuntimeInspection {
  /** Whether the instance is actually running and answering its probe. */
  readonly running: boolean
  /** Reachable host when running; null otherwise. */
  readonly host: string | null
  /** Reachable port when running; null otherwise. */
  readonly port: number | null
}

/** Starts, stops, and inspects runtime instances of one execution kind. */
export interface RuntimeBackend {
  /**
   * Launch one runtime and wait for its readiness probe.
   * @param spec - per-user facts, directories, and assertion material.
   * @returns the running instance and its private endpoint.
   */
  start(spec: RuntimeStartSpec): Promise<RuntimeInstance>
  /**
   * Stop one instance; data on disk or in volumes stays.
   * @param runtimeId - instance identifier persisted earlier.
   */
  stop(runtimeId: string): Promise<void>
  /**
   * Observe one instance without starting or stopping it.
   * @param runtimeId - instance identifier persisted earlier.
   * @returns whether the instance runs now and where it answers.
   */
  inspect(runtimeId: string): Promise<RuntimeInspection>
  /** Release backend resources; containers keep running so a restart can adopt them. */
  close(): Promise<void>
}

/** HTTP readiness probe; injectable so tests never bind a real port. */
export type HttpProbe = (url: string, timeoutMs: number) => Promise<boolean>

/** Child process handle a {@link SpawnFunction} returns. */
export interface SpawnedProcess {
  /** Operating-system process id, when the spawn succeeded. */
  readonly pid: number | undefined
  /** Captured standard output, when the spawn was configured with a pipe. */
  readonly stdout: NodeJS.ReadableStream | null
  /** Captured standard error, when the spawn was configured with a pipe. */
  readonly stderr: NodeJS.ReadableStream | null
  /**
   * Send a signal to the process.
   * @param signal - signal to send; platform defaults apply when omitted.
   * @returns whether the signal was delivered.
   */
  kill(signal?: NodeJS.Signals): boolean
  /**
   * Register the one-shot exit listener.
   * @param listener - receives the exit code and signal.
   */
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  /**
   * Register the one-shot spawn-failure listener.
   * @param listener - receives the spawn failure.
   */
  onError(listener: (error: Error) => void): void
}

/** Options a spawn call receives; `env` is the already-filtered runtime environment. */
export interface SpawnOptionsLike {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly windowsHide: boolean
}

/** Spawn one runtime command; injectable so tests can assert argv and environment. */
export type SpawnFunction = (command: string, args: readonly string[], options: SpawnOptionsLike) => SpawnedProcess

/**
 * Spawn one runtime command with piped output and no shared console.
 * @param command - executable path or bare command name.
 * @param args - argument vector, never shell-interpreted.
 * @param options - working directory, filtered environment, and window behavior.
 * @returns the child process handle.
 */
export function defaultSpawn(command: string, args: readonly string[], options: SpawnOptionsLike): SpawnedProcess {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: options.windowsHide,
  })
  return {
    pid: child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: signal => child.kill(signal),
    onExit: listener => {
      child.once('exit', listener)
    },
    onError: listener => {
      child.once('error', listener)
    },
  }
}

/** One completed Docker CLI invocation. */
export interface DockerCommandResult {
  /** Captured standard output. */
  readonly stdout: string
  /** Captured standard error. */
  readonly stderr: string
  /** Process exit code; nonzero means the command failed. */
  readonly exitCode: number
}

/** Executes one Docker CLI argv; injectable so container tests need no Docker daemon. */
export type DockerExecutor = (args: readonly string[]) => Promise<DockerCommandResult>

/** Timer abstraction so tests can drive idle reclamation deterministically. */
export interface RuntimeScheduler {
  /**
   * Schedule a repeating callback.
   * @param callback - callback invoked once per interval.
   * @param intervalMs - interval in milliseconds.
   * @returns an opaque handle passed back to {@link RuntimeScheduler.clearInterval}.
   */
  setInterval(callback: () => void, intervalMs: number): unknown
  /**
   * Cancel a scheduled callback.
   * @param handle - handle returned by {@link RuntimeScheduler.setInterval}.
   */
  clearInterval(handle: unknown): void
}
