/**
 * Per-user runtime manager and supervisor.
 *
 * The manager owns the durable record for each `(realm, user_id)`, the lifecycle
 * state machine, the monotonic generation, idempotent `ensure`, restart
 * reconciliation, and idle reclamation. It never starts a second instance for a
 * user and never trusts a persisted READY state without asking the backend.
 *
 * @module @deepseek-ai/dsh-platform-services/runtime/manager
 */

import { join } from 'node:path'
import type { RuntimeConfig } from '../config.ts'
import type {
  RuntimeEnsureResult,
  RuntimeManager,
  RuntimeStatusView,
  RuntimeTarget,
} from '../contracts.ts'
import {
  type DockerExecutor,
  type HttpProbe,
  type RuntimeAssertionFacts,
  type RuntimeBackend,
  type RuntimeInspection,
  type RuntimeInstance,
  type RuntimeScheduler,
  type RuntimeStartSpec,
  type SpawnFunction,
} from './backend.ts'
import { createDockerBackend } from './container-backend.ts'
import { RuntimeManagerError, runtimeErrorCode, type RuntimeErrorCode } from './errors.ts'
import { createProcessBackend } from './process-backend.ts'
import { RuntimeRegistry, type RuntimeRecord } from './registry.ts'
import {
  assertUserId,
  computeSpaceKey,
  ensureRuntimeSpaceDirs,
  resolveRuntimeSpaceByKey,
  type RuntimeSpacePaths,
} from './space.ts'
import { hashUserRef, stderrRuntimeLog, type RuntimeLog } from './support.ts'

/** Default minimum interval between two READY inspections, in milliseconds. */
const DEFAULT_INSPECT_INTERVAL_MS = 5_000

/** Configuration the runtime manager receives from its platform composition root. */
export type RuntimeManagerConfig = RuntimeConfig & {
  /** Platform data directory; the registry lives beneath it unless `options.dataDir` overrides it. */
  readonly dataDir: string
  /** Deployment realm; part of the space-key HMAC input. */
  readonly realm: string
}

/** Optional runtime manager injections; every one exists so tests need no real runtime. */
export interface RuntimeManagerOptions {
  /** Assertion facts stamped on every runtime; required for a real backend. */
  readonly runtimeAuth?: RuntimeAssertionFacts | undefined
  /** Public HTTP(S) origin the runtime advertises; required for a real backend. */
  readonly publicOrigin?: string | undefined
  /** Public host authority the runtime browsers-trust fence accepts. */
  readonly publicAuthority?: string | undefined
  /** Directory holding `runtime.sqlite`; defaults to `config.dataDir`. */
  readonly dataDir?: string | undefined
  /** Replacement backend; disables the real process/container backend. */
  readonly backend?: RuntimeBackend | undefined
  /** Clock used for registry timestamps and idle decisions. */
  readonly now?: (() => number) | undefined
  /** Free-port allocator passed to the process backend. */
  readonly portAllocator?: (() => Promise<number>) | undefined
  /** Spawn implementation passed to the process backend. */
  readonly spawn?: SpawnFunction | undefined
  /** Docker executor passed to the container backend. */
  readonly dockerExecutor?: DockerExecutor | undefined
  /** Readiness probe passed to both real backends. */
  readonly probe?: HttpProbe | undefined
  /** Sleep passed to both real backends; tests keep timeouts instant. */
  readonly sleep?: ((durationMs: number) => Promise<void>) | undefined
  /** Timer abstraction for idle reclamation. */
  readonly timers?: RuntimeScheduler | undefined
  /** Minimum interval between READY inspections triggered by `ensure`, in milliseconds. */
  readonly inspectIntervalMs?: number | undefined
  /** Structured log sink; defaults to one JSON line per event on stderr. */
  readonly log?: RuntimeLog | undefined
}

/** One free slot of a bounded concurrent-start gate. */
type ReleaseSlot = () => void

/** Bounded gate over concurrent cold starts, so one user cannot starve the others. */
class StartGate {
  private active = 0
  private readonly waiters: (() => void)[] = []
  private readonly limit: number

  /** @param limit - concurrent starts allowed; a non-positive value means unlimited. */
  constructor(limit: number) {
    this.limit = limit
  }

  /**
   * Wait for one start slot.
   * @returns idempotent release of the slot.
   */
  async acquire(): Promise<ReleaseSlot> {
    if (this.limit <= 0 || this.active < this.limit) {
      this.active += 1
      return this.createRelease()
    }
    await new Promise<void>(resolve => {
      this.waiters.push(resolve)
    })
    this.active += 1
    return this.createRelease()
  }

  /** Build the idempotent release callback of one acquired slot. */
  private createRelease(): ReleaseSlot {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
      const next = this.waiters.shift()
      if (next !== undefined) next()
    }
  }
}

/** Thrown when a closed union member is reached that the type system rules out. */
function assertNever(value: never): never {
  throw new Error(`unexpected runtime state ${String(value)}`)
}

/** Timer scheduler used in production; the interval never keeps the process alive. */
function createDefaultScheduler(): RuntimeScheduler {
  return {
    setInterval(callback, intervalMs) {
      const handle = setInterval(callback, intervalMs)
      handle.unref()
      return handle
    },
    clearInterval(handle) {
      clearInterval(handle as NodeJS.Timeout)
    },
  }
}

/**
 * Validate the lifecycle-relevant configuration before the registry opens.
 * @param config - runtime manager configuration.
 * @throws {RuntimeManagerError} when a required value is missing or nonsensical.
 */
function validateManagerConfig(config: RuntimeManagerConfig): void {
  const invalid = (message: string): never => {
    throw new RuntimeManagerError('RUNTIME_CONFIG_INVALID', message)
  }
  if (config.realm.trim() === '') invalid('runtime realm is not configured')
  if (config.spaceKeySecret === '') invalid('space key secret is not configured')
  if (config.root.trim() === '') invalid('runtime space root is not configured')
  if (config.dataDir.trim() === '') invalid('runtime data directory is not configured')
  if (!Number.isFinite(config.startTimeoutMs) || config.startTimeoutMs <= 0) invalid('start timeout must be positive')
  if (!Number.isFinite(config.idleSeconds) || config.idleSeconds < 0) invalid('idle seconds must not be negative')
  if (!Number.isFinite(config.reapIntervalMs) || config.reapIntervalMs < 0) invalid('reap interval must not be negative')
}

/** Per-user runtime manager; obtain one through {@link createRuntimeManager}. */
class PlatformRuntimeManager implements RuntimeManager {
  private readonly config: RuntimeManagerConfig
  private readonly registry: RuntimeRegistry
  private readonly backend: RuntimeBackend
  private readonly now: () => number
  private readonly log: RuntimeLog
  private readonly runtimeAuth: RuntimeAssertionFacts | null
  private readonly publicOrigin: string
  private readonly publicAuthority: string
  private readonly inspectIntervalMs: number
  private readonly timers: RuntimeScheduler
  private readonly startGate: StartGate
  private readonly locks = new Map<string, Promise<void>>()
  private readonly targets = new Map<string, RuntimeTarget>()
  private readonly inspectedAt = new Map<string, number>()
  private readonly leases = new Map<string, number>()
  private readonly startedHere = new Set<string>()
  private reaperHandle: unknown = null
  private closed = false

  /** @param parts - resolved collaborators; use the factory instead of calling this. */
  constructor(parts: {
    readonly config: RuntimeManagerConfig
    readonly registry: RuntimeRegistry
    readonly backend: RuntimeBackend
    readonly runtimeAuth: RuntimeAssertionFacts | null
    readonly publicOrigin: string
    readonly publicAuthority: string
    readonly inspectIntervalMs: number
    readonly timers: RuntimeScheduler
    readonly log: RuntimeLog
    readonly now: () => number
  }) {
    this.config = parts.config
    this.registry = parts.registry
    this.backend = parts.backend
    this.runtimeAuth = parts.runtimeAuth
    this.publicOrigin = parts.publicOrigin
    this.publicAuthority = parts.publicAuthority
    this.inspectIntervalMs = parts.inspectIntervalMs
    this.timers = parts.timers
    this.log = parts.log
    this.now = parts.now
    this.startGate = new StartGate(parts.config.maxConcurrentStarts)
  }

  /** @inheritDoc */
  async ensure(userId: string): Promise<RuntimeEnsureResult> {
    this.assertOpen()
    assertUserId(userId)
    return await this.runSerialized(userId, () => this.ensureExclusive(userId, false))
  }

  /** @inheritDoc */
  async retry(userId: string): Promise<RuntimeEnsureResult> {
    this.assertOpen()
    assertUserId(userId)
    return await this.runSerialized(userId, () => this.ensureExclusive(userId, true))
  }

  /** @inheritDoc */
  async status(userId: string): Promise<RuntimeStatusView> {
    this.assertOpen()
    assertUserId(userId)
    return await this.runSerialized(userId, () => this.statusExclusive(userId))
  }

  /** @inheritDoc */
  touch(userId: string): void {
    this.assertOpen()
    assertUserId(userId)
    const record = this.registry.find(this.config.realm, userId)
    if (record === undefined) return
    this.registry.touch(record.id, this.now())
  }

  /** @inheritDoc */
  lease(userId: string): () => void {
    this.assertOpen()
    assertUserId(userId)
    this.leases.set(userId, (this.leases.get(userId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.leases.get(userId) ?? 0) - 1
      if (remaining <= 0) this.leases.delete(userId)
      else this.leases.set(userId, remaining)
    }
  }

  /** @inheritDoc */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.reaperHandle !== null) {
      this.timers.clearInterval(this.reaperHandle)
      this.reaperHandle = null
    }
    this.leases.clear()
    await this.drainLocks()
    for (const record of this.registry.list()) {
      if (!this.startedHere.has(record.userId)) continue
      if (record.state !== 'READY' && record.state !== 'STARTING') continue
      if (this.config.kind !== 'process') continue
      if (record.runtimeId !== null) {
        try {
          await this.backend.stop(record.runtimeId)
        } catch (error) {
          this.logEvent('runtime.stop_failed', record.userId, runtimeErrorCode(error), record.generation)
        }
      }
      this.registry.update(record.id, {
        state: 'STOPPED',
        desiredState: 'STOPPED',
        runtimeId: null,
        lastErrorCode: null,
        updatedAt: this.now(),
      })
    }
    this.targets.clear()
    this.inspectedAt.clear()
    this.startedHere.clear()
    try {
      await this.backend.close()
    } catch (error) {
      this.logEvent('runtime.backend_close_failed', '', runtimeErrorCode(error))
    }
    this.registry.close()
  }

  /**
   * Reconcile persisted READY/STARTING records with the running backend state.
   *
   * A supervisor restart adopts instances that are still running and answering
   * their probe, and marks every other record FAILED for an explicit retry. This
   * is what prevents the supervisor from starting a second instance for a user.
   */
  async reconcile(): Promise<void> {
    for (const record of this.registry.list()) {
      if (record.state !== 'READY' && record.state !== 'STARTING') continue
      if (record.runtimeId === null) {
        this.markFailed(record, 'RUNTIME_BACKEND_ERROR')
        this.logEvent('runtime.reconcile_failed', record.userId, 'RUNTIME_BACKEND_ERROR', record.generation)
        continue
      }
      const inspection = await this.inspectRuntime(record.runtimeId)
      const nowMs = this.now()
      if (inspection !== 'error' && inspection.running && inspection.host !== null && inspection.port !== null) {
        const adopted = this.registry.update(record.id, { state: 'READY', updatedAt: nowMs })
        this.targets.set(adopted.userId, {
          host: inspection.host,
          port: inspection.port,
          generation: adopted.generation,
        })
        this.inspectedAt.set(adopted.userId, nowMs)
        this.logEvent('runtime.adopted', adopted.userId, undefined, adopted.generation)
        continue
      }
      const code: RuntimeErrorCode = inspection === 'error' ? 'RUNTIME_BACKEND_ERROR' : 'RUNTIME_EXITED'
      this.markFailed(record, code)
      this.logEvent('runtime.reconcile_failed', record.userId, code, record.generation)
    }
  }

  /** Start the idle reaper; disabled when reclamation or a positive interval is not configured. */
  startReaper(): void {
    if (this.config.reapIntervalMs <= 0 || this.config.idleSeconds <= 0) return
    this.reaperHandle = this.timers.setInterval(() => {
      void this.reapOnce().catch(error => {
        this.logEvent('runtime.reaper_failed', '', runtimeErrorCode(error))
      })
    }, this.config.reapIntervalMs)
  }

  /**
   * Bring one user to READY or to a retryable FAILED result.
   * @param userId - internal user id.
   * @param explicitRetry - whether a FAILED record may start again.
   * @returns the anonymous lifecycle result.
   */
  private async ensureExclusive(userId: string, explicitRetry: boolean): Promise<RuntimeEnsureResult> {
    this.assertOpen()
    const nowMs = this.now()
    const record = this.loadOrCreateRecord(userId, nowMs)
    this.registry.touch(record.id, nowMs)
    const space = this.resolveSpace(record)
    switch (record.state) {
      case 'READY':
        return await this.ensureReady(record)
      case 'FAILED':
        if (!explicitRetry) return this.failedResult(record)
        return await this.startRuntime(record, space)
      case 'UNALLOCATED':
      case 'PROVISIONING':
      case 'STARTING':
      case 'STOPPING':
      case 'STOPPED':
        return await this.startRuntime(record, space)
      default:
        return assertNever(record.state)
    }
  }

  /**
   * Return a READY runtime, first proving it still runs within the inspection window.
   * @param record - persisted READY record.
   * @returns the ready result, or a retryable FAILED result after an unexpected exit.
   */
  private async ensureReady(record: RuntimeRecord): Promise<RuntimeEnsureResult> {
    const nowMs = this.now()
    const cached = this.targets.get(record.userId)
    const inspectedAt = this.inspectedAt.get(record.userId) ?? 0
    if (cached !== undefined && this.inspectIntervalMs > 0 && nowMs - inspectedAt < this.inspectIntervalMs) {
      return this.readyResult(record, cached)
    }
    const inspection = await this.inspectRuntime(record.runtimeId)
    this.inspectedAt.set(record.userId, nowMs)
    if (inspection === 'error') {
      if (cached !== undefined) return this.readyResult(record, cached)
      const failed = this.markFailed(record, 'RUNTIME_BACKEND_ERROR')
      return this.failedResult(failed)
    }
    if (!inspection.running || inspection.host === null || inspection.port === null) {
      const failed = this.markFailed(record, 'RUNTIME_EXITED')
      this.logEvent('runtime.exited', record.userId, 'RUNTIME_EXITED', record.generation)
      return this.failedResult(failed)
    }
    const target: RuntimeTarget = {
      host: inspection.host,
      port: inspection.port,
      generation: record.generation,
    }
    this.targets.set(record.userId, target)
    return this.readyResult(record, target)
  }

  /**
   * Read one user's status without starting anything, reconciling exit and adoption.
   * @param userId - internal user id.
   * @returns the anonymous lifecycle view.
   */
  private async statusExclusive(userId: string): Promise<RuntimeStatusView> {
    const record = this.registry.find(this.config.realm, userId)
    if (record === undefined) {
      return { state: 'UNALLOCATED', generation: 0, retryable: false, errorCode: null }
    }
    if (record.state !== 'READY' && record.state !== 'STARTING') return this.statusView(record)
    const inspection = await this.inspectRuntime(record.runtimeId)
    const nowMs = this.now()
    if (inspection === 'error') {
      if (record.state === 'READY') return this.statusView(record)
      return this.statusView(this.markFailed(record, 'RUNTIME_BACKEND_ERROR'))
    }
    if (inspection.running && inspection.host !== null && inspection.port !== null) {
      const adopted = this.registry.update(record.id, { state: 'READY', updatedAt: nowMs })
      this.targets.set(userId, {
        host: inspection.host,
        port: inspection.port,
        generation: adopted.generation,
      })
      this.inspectedAt.set(userId, nowMs)
      return this.statusView(adopted)
    }
    return this.statusView(this.markFailed(record, 'RUNTIME_EXITED'))
  }

  /**
   * Start a new generation for one user after reclaiming any stale instance.
   * @param record - persisted record in a startable state.
   * @param space - resolved space directories.
   * @returns the READY result, or a retryable FAILED result.
   */
  private async startRuntime(record: RuntimeRecord, space: RuntimeSpacePaths): Promise<RuntimeEnsureResult> {
    const release = await this.startGate.acquire()
    try {
      try {
        await this.reclaimPrevious(record)
      } catch (error) {
        const code = runtimeErrorCode(error)
        const failed = this.registry.update(record.id, {
          state: 'FAILED',
          lastErrorCode: code,
          updatedAt: this.now(),
        })
        this.logEvent('runtime.reclaim_failed', record.userId, code, record.generation)
        return this.failedResult(failed)
      }
      await ensureRuntimeSpaceDirs(space)
      const provisioning = this.registry.update(record.id, {
        state: 'PROVISIONING',
        desiredState: 'RUNNING',
        lastErrorCode: null,
        updatedAt: this.now(),
      })
      const generation = provisioning.generation + 1
      const starting = this.registry.update(record.id, {
        state: 'STARTING',
        generation,
        desiredState: 'RUNNING',
        lastErrorCode: null,
        updatedAt: this.now(),
      })
      let spec: RuntimeStartSpec
      try {
        spec = this.buildStartSpec(starting, space)
      } catch (error) {
        const code = runtimeErrorCode(error)
        const failed = this.registry.update(starting.id, {
          state: 'FAILED',
          lastErrorCode: code,
          updatedAt: this.now(),
        })
        this.logEvent('runtime.start_failed', starting.userId, code, generation)
        return this.failedResult(failed)
      }
      let instance: RuntimeInstance
      try {
        instance = await this.backend.start(spec)
      } catch (error) {
        const code = runtimeErrorCode(error)
        const failed = this.registry.update(starting.id, {
          state: 'FAILED',
          lastErrorCode: code,
          updatedAt: this.now(),
        })
        this.logEvent('runtime.start_failed', starting.userId, code, generation)
        return this.failedResult(failed)
      }
      const readyAt = this.now()
      const ready = this.registry.update(starting.id, {
        state: 'READY',
        runtimeId: instance.runtimeId,
        imageDigest: instance.imageDigest,
        lastErrorCode: null,
        lastActivityAt: readyAt,
        updatedAt: readyAt,
      })
      const target: RuntimeTarget = {
        host: instance.host,
        port: instance.port,
        generation: ready.generation,
      }
      this.targets.set(ready.userId, target)
      this.inspectedAt.set(ready.userId, readyAt)
      this.startedHere.add(ready.userId)
      this.logEvent('runtime.ready', ready.userId, undefined, ready.generation)
      return this.readyResult(ready, target)
    } finally {
      release()
    }
  }

  /**
   * Stop a leftover backend instance before a new generation starts.
   * @param record - persisted record that may still reference a running instance.
   * @throws {RuntimeManagerError} when the stale instance survives the stop attempt.
   */
  private async reclaimPrevious(record: RuntimeRecord): Promise<void> {
    if (record.runtimeId === null) return
    const inspection = await this.backend.inspect(record.runtimeId)
    if (!inspection.running) return
    await this.backend.stop(record.runtimeId)
    const after = await this.backend.inspect(record.runtimeId)
    if (after.running) {
      throw new RuntimeManagerError(
        'RUNTIME_INSTANCE_CONFLICT',
        'the previous runtime for this user is still running',
      )
    }
  }

  /**
   * Idle reclamation tick: reconcile exits, then stop runtimes idle past `idleSeconds`.
   */
  private async reapOnce(): Promise<void> {
    if (this.closed) return
    const userIds = new Set(this.registry.list().map(record => record.userId))
    for (const userId of userIds) {
      if (this.closed) return
      await this.runSerialized(userId, () => this.reapUser(userId))
    }
  }

  /**
   * Reconcile and reclaim one user's runtime.
   * @param userId - internal user id.
   */
  private async reapUser(userId: string): Promise<void> {
    const record = this.registry.find(this.config.realm, userId)
    if (record === undefined) return
    if (record.state !== 'READY' && record.state !== 'STARTING') return
    if (record.state === 'STARTING' && record.runtimeId === null) {
      this.markFailed(record, 'RUNTIME_BACKEND_ERROR')
      return
    }
    const inspection = await this.inspectRuntime(record.runtimeId)
    if (inspection === 'error') return
    const nowMs = this.now()
    if (!inspection.running || inspection.host === null || inspection.port === null) {
      this.markFailed(record, 'RUNTIME_EXITED')
      this.logEvent('runtime.exited', userId, 'RUNTIME_EXITED', record.generation)
      return
    }
    const ready = record.state === 'READY' ? record : this.registry.update(record.id, { state: 'READY', updatedAt: nowMs })
    this.targets.set(userId, {
      host: inspection.host,
      port: inspection.port,
      generation: ready.generation,
    })
    this.inspectedAt.set(userId, nowMs)
    if ((this.leases.get(userId) ?? 0) > 0) return
    if (this.config.idleSeconds <= 0) return
    const activity = ready.lastActivityAt ?? ready.updatedAt
    if (nowMs - activity <= this.config.idleSeconds * 1000) return
    await this.stopForIdle(ready)
  }

  /**
   * Stop one idle runtime, keeping its space directories and registry row.
   * @param record - READY record whose idle window elapsed.
   */
  private async stopForIdle(record: RuntimeRecord): Promise<void> {
    this.registry.update(record.id, {
      state: 'STOPPING',
      desiredState: 'STOPPED',
      updatedAt: this.now(),
    })
    try {
      if (record.runtimeId !== null) await this.backend.stop(record.runtimeId)
    } catch (error) {
      const code = runtimeErrorCode(error)
      this.registry.update(record.id, { state: 'FAILED', lastErrorCode: code, updatedAt: this.now() })
      this.logEvent('runtime.idle_stop_failed', record.userId, code, record.generation)
      return
    }
    this.registry.update(record.id, {
      state: 'STOPPED',
      desiredState: 'STOPPED',
      runtimeId: null,
      lastErrorCode: null,
      updatedAt: this.now(),
    })
    this.targets.delete(record.userId)
    this.inspectedAt.delete(record.userId)
    this.logEvent('runtime.reaped', record.userId, undefined, record.generation)
  }

  /**
   * Register a backend-reported unexpected exit.
   * @param runtimeId - instance the backend observed exiting.
   */
  private handleBackendExit(runtimeId: string): void {
    void this.recordBackendExit(runtimeId).catch(error => {
      this.logEvent('runtime.exit_handler_failed', '', runtimeErrorCode(error))
    })
  }

  /**
   * Persist an unexpected exit as FAILED so the next `retry` can start a new generation.
   * @param runtimeId - instance the backend observed exiting.
   */
  private async recordBackendExit(runtimeId: string): Promise<void> {
    const record = this.registry.findByRuntimeId(runtimeId)
    if (record === undefined) return
    await this.runSerialized(record.userId, async () => {
      const current = this.registry.find(this.config.realm, record.userId)
      if (current === undefined || current.runtimeId !== runtimeId) return
      if (current.state !== 'READY' && current.state !== 'STARTING') return
      this.markFailed(current, 'RUNTIME_EXITED')
      this.logEvent('runtime.exited', current.userId, 'RUNTIME_EXITED', current.generation)
    })
  }

  /**
   * Build the per-user backend start specification.
   * @param record - STARTING record whose generation is being launched.
   * @param space - resolved space directories.
   * @returns the backend start specification.
   * @throws {RuntimeManagerError} when assertion facts or the public origin are missing.
   */
  private buildStartSpec(record: RuntimeRecord, space: RuntimeSpacePaths): RuntimeStartSpec {
    if (this.runtimeAuth === null) {
      throw new RuntimeManagerError('RUNTIME_CONFIG_INVALID', 'runtime assertion facts are not configured')
    }
    if (this.publicOrigin === '') {
      throw new RuntimeManagerError('RUNTIME_CONFIG_INVALID', 'public origin is not configured')
    }
    return {
      realm: this.config.realm,
      userId: record.userId,
      spaceKey: record.spaceKey,
      generation: record.generation,
      space,
      patchFile: this.config.patchFile,
      runtimeAuth: this.runtimeAuth,
      publicOrigin: this.publicOrigin,
      publicAuthority: this.publicAuthority,
      startTimeoutMs: this.config.startTimeoutMs,
      onExit: runtimeId => {
        this.handleBackendExit(runtimeId)
      },
    }
  }

  /**
   * Inspect one runtime without letting a backend failure crash the supervisor.
   * @param runtimeId - persisted instance identifier, or null.
   * @returns the inspection, or `error` when the backend could not answer.
   */
  private async inspectRuntime(runtimeId: string | null): Promise<RuntimeInspection | 'error'> {
    if (runtimeId === null) return { running: false, host: null, port: null }
    try {
      return await this.backend.inspect(runtimeId)
    } catch {
      // A transient backend failure is not proof of exit; the caller decides.
      return 'error'
    }
  }

  /**
   * Persist one failure state and drop cached connection facts.
   * @param record - record to mark FAILED.
   * @param code - stable error code.
   * @returns the updated record.
   */
  private markFailed(record: RuntimeRecord, code: RuntimeErrorCode): RuntimeRecord {
    this.targets.delete(record.userId)
    this.inspectedAt.delete(record.userId)
    return this.registry.update(record.id, {
      state: 'FAILED',
      lastErrorCode: code,
      updatedAt: this.now(),
    })
  }

  /**
   * Find or allocate one user's record.
   * @param userId - internal user id.
   * @param nowMs - epoch milliseconds of this operation.
   * @returns the existing or freshly created record.
   */
  private loadOrCreateRecord(userId: string, nowMs: number): RuntimeRecord {
    const existing = this.registry.find(this.config.realm, userId)
    if (existing !== undefined) return existing
    const spaceKey = computeSpaceKey(this.config.spaceKeySecret, this.config.realm, userId)
    try {
      return this.registry.create({ realm: this.config.realm, userId, spaceKey, now: nowMs })
    } catch (error) {
      const raced = this.registry.find(this.config.realm, userId)
      if (raced !== undefined) return raced
      throw error
    }
  }

  /**
   * Resolve one record's directories, proving they stay inside the space root.
   * @param record - persisted record.
   * @returns the resolved space paths.
   */
  private resolveSpace(record: RuntimeRecord): RuntimeSpacePaths {
    return resolveRuntimeSpaceByKey({
      root: this.config.root,
      realm: this.config.realm,
      userId: record.userId,
      spaceKey: record.spaceKey,
    })
  }

  /**
   * Serialize lifecycle work for one user while other users proceed independently.
   * @param userId - internal user id.
   * @param task - operation to run under the user's lock.
   * @returns the task result.
   */
  private runSerialized<T>(userId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(userId) ?? Promise.resolve()
    const result = previous.then(task)
    const guard = result.then(
      () => undefined,
      () => undefined,
    )
    this.locks.set(userId, guard)
    void guard.then(() => {
      if (this.locks.get(userId) === guard) this.locks.delete(userId)
    })
    return result
  }

  /** Wait for every lifecycle operation currently queued to settle. */
  private async drainLocks(): Promise<void> {
    for (let round = 0; round < 100; round += 1) {
      const pending = [...this.locks.values()]
      if (pending.length === 0) return
      await Promise.allSettled(pending)
    }
  }

  /**
   * Emit one structured supervisor log line.
   * @param event - stable event name.
   * @param userId - user whose runtime the event belongs to; hashed before logging.
   * @param code - stable error or result code, when the event has one.
   * @param generation - generation the event belongs to, when it has one.
   */
  private logEvent(event: string, userId: string, code?: string, generation?: number): void {
    this.log({
      event,
      userRef: hashUserRef(this.config.realm, userId),
      code,
      generation,
    })
  }

  /**
   * Build the anonymous status view of one record.
   * @param record - persisted record.
   * @returns the status view.
   */
  private statusView(record: RuntimeRecord): RuntimeStatusView {
    return {
      state: record.state,
      generation: record.generation,
      retryable: record.state === 'FAILED',
      errorCode: record.state === 'FAILED' ? (record.lastErrorCode ?? 'RUNTIME_BACKEND_ERROR') : null,
    }
  }

  /**
   * Build the READY ensure result.
   * @param record - persisted record.
   * @param target - private runtime endpoint.
   * @returns the ensure result.
   */
  private readyResult(record: RuntimeRecord, target: RuntimeTarget): RuntimeEnsureResult {
    return {
      state: 'READY',
      generation: record.generation,
      retryable: false,
      errorCode: null,
      target: { host: target.host, port: target.port, generation: record.generation },
    }
  }

  /**
   * Build the FAILED ensure result.
   * @param record - persisted FAILED record.
   * @returns the ensure result.
   */
  private failedResult(record: RuntimeRecord): RuntimeEnsureResult {
    return {
      state: 'FAILED',
      generation: record.generation,
      retryable: true,
      errorCode: record.lastErrorCode ?? 'RUNTIME_BACKEND_ERROR',
    }
  }

  /** Refuse lifecycle work after {@link PlatformRuntimeManager.close}. */
  private assertOpen(): void {
    if (this.closed) {
      throw new RuntimeManagerError('RUNTIME_MANAGER_CLOSED', 'runtime manager is closed')
    }
  }
}

/**
 * Create the platform's runtime manager and supervisor.
 *
 * The returned manager is already reconciled against the durable registry: a
 * restarted supervisor adopts runtimes that still run and marks stale READY
 * records FAILED so the gateway can offer an explicit retry.
 * @param config - runtime configuration plus platform data directory and realm.
 * @param options - injectable backend, clock, timers, port allocator, spawn, and Docker executor.
 * @returns the ready runtime manager.
 * @throws {RuntimeManagerError} when the lifecycle configuration is invalid.
 */
export async function createRuntimeManager(
  config: RuntimeManagerConfig,
  options: RuntimeManagerOptions = {},
): Promise<RuntimeManager> {
  validateManagerConfig(config)
  const now = options.now ?? Date.now
  const registry = RuntimeRegistry.open(join(options.dataDir ?? config.dataDir, 'runtime.sqlite'), { now })
  const runtimeAuth = options.runtimeAuth ?? null
  const publicOrigin = options.publicOrigin ?? ''
  const publicAuthority = options.publicAuthority ?? config.publicAuthority
  let backend = options.backend
  if (backend === undefined) {
    if (runtimeAuth === null) {
      registry.close()
      throw new RuntimeManagerError('RUNTIME_CONFIG_INVALID', 'runtime assertion facts are not configured')
    }
    if (publicOrigin === '') {
      registry.close()
      throw new RuntimeManagerError('RUNTIME_CONFIG_INVALID', 'public origin is not configured')
    }
    backend =
      config.kind === 'container'
        ? createDockerBackend(config, {
            executor: options.dockerExecutor,
            probe: options.probe,
            now,
            sleep: options.sleep,
          })
        : createProcessBackend(config, {
            spawn: options.spawn,
            portAllocator: options.portAllocator,
            probe: options.probe,
            now,
            sleep: options.sleep,
          })
  }
  const manager = new PlatformRuntimeManager({
    config,
    registry,
    backend,
    runtimeAuth,
    publicOrigin,
    publicAuthority,
    inspectIntervalMs: options.inspectIntervalMs ?? DEFAULT_INSPECT_INTERVAL_MS,
    timers: options.timers ?? createDefaultScheduler(),
    log: options.log ?? stderrRuntimeLog,
    now,
  })
  try {
    await manager.reconcile()
  } catch (error) {
    await backend.close().catch(() => {
      // Cleanup after a failed reconciliation must not mask the original failure.
    })
    registry.close()
    throw error
  }
  manager.startReaper()
  return manager
}
