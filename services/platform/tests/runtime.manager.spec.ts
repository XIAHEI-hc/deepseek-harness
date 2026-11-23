/**
 * Runtime manager: idempotent ensure, generation, failures, exits, reconciliation,
 * leases, idle reclamation, and close.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPlatformConfig } from '../src/config.ts'
import type { RuntimeEnsureResult, RuntimeManager, RuntimeTarget } from '../src/contracts.ts'
import {
  createRuntimeManager,
  ensureRuntimeSpaceDirs,
  resolveRuntimeSpace,
  RuntimeBackendError,
  RuntimeManagerError,
  RuntimeRegistry,
  type RuntimeBackend,
  type RuntimeInspection,
  type RuntimeInstance,
  type RuntimeManagerConfig,
  type RuntimeScheduler,
  type RuntimeSpacePaths,
  type RuntimeStartSpec,
  type SpawnedProcess,
  type SpawnOptionsLike,
} from '../src/runtime/index.ts'

const SECRET = 'manager-test-secret-0123456789abcdef'
const REALM = 'test-realm'
const USER_A = 'user-a'
const USER_B = 'user-b'
const temporaryDirectories: string[] = []
const openManagers: RuntimeManager[] = []

/** Controllable clock for idle and registry timestamps. */
class TestClock {
  time = 1_000_000

  /** @returns current epoch milliseconds. */
  readonly now = (): number => this.time

  /**
   * Move the clock forward.
   * @param milliseconds - amount to advance.
   */
  advance(milliseconds: number): void {
    this.time += milliseconds
  }
}

/** Scheduler that records callbacks so tests drive reclamation explicitly. */
class TestScheduler implements RuntimeScheduler {
  readonly callbacks: (() => void)[] = []
  readonly cleared: unknown[] = []

  /** @inheritDoc */
  setInterval(callback: () => void, _intervalMs: number): unknown {
    this.callbacks.push(callback)
    return this.callbacks.length
  }

  /** @inheritDoc */
  clearInterval(handle: unknown): void {
    this.cleared.push(handle)
  }
}

/** Scripted runtime backend; no process or container is ever launched. */
class FakeBackend implements RuntimeBackend {
  readonly startCalls: RuntimeStartSpec[] = []
  readonly stopCalls: string[] = []
  readonly instances = new Map<string, { host: string; port: number; running: boolean }>()
  startBehavior: 'success' | 'fail' | 'deferred' = 'success'
  startErrorCode: 'RUNTIME_START_TIMEOUT' | 'RUNTIME_EXITED' = 'RUNTIME_START_TIMEOUT'
  surviveStop = false
  failInspect = false
  closed = false
  inspectCalls = 0
  private counter = 0
  private readonly pendingStarts = new Map<string, () => void>()

  /** @inheritDoc */
  async start(spec: RuntimeStartSpec): Promise<RuntimeInstance> {
    this.startCalls.push(spec)
    if (this.startBehavior === 'fail') throw new RuntimeBackendError(this.startErrorCode, 'scripted start failure')
    if (this.startBehavior === 'deferred') {
      await new Promise<void>(resolve => {
        this.pendingStarts.set(spec.userId, resolve)
      })
    }
    const runtimeId = `fake-${spec.userId}-${String(this.counter)}`
    this.counter += 1
    const instance = { host: '127.0.0.1', port: 39_000 + this.counter, running: true }
    this.instances.set(runtimeId, instance)
    return { runtimeId, host: instance.host, port: instance.port, imageDigest: null }
  }

  /** @inheritDoc */
  async stop(runtimeId: string): Promise<void> {
    this.stopCalls.push(runtimeId)
    if (this.surviveStop) return
    const instance = this.instances.get(runtimeId)
    if (instance !== undefined) instance.running = false
  }

  /** @inheritDoc */
  async inspect(runtimeId: string): Promise<RuntimeInspection> {
    this.inspectCalls += 1
    if (this.failInspect) throw new Error('backend unavailable')
    const instance = this.instances.get(runtimeId)
    if (instance === undefined || !instance.running) return { running: false, host: null, port: null }
    return { running: true, host: instance.host, port: instance.port }
  }

  /** @inheritDoc */
  async close(): Promise<void> {
    this.closed = true
  }

  /**
   * Release one deferred start.
   * @param userId - user whose start is blocked.
   */
  releaseStart(userId: string): void {
    this.pendingStarts.get(userId)?.()
    this.pendingStarts.delete(userId)
  }

  /**
   * Simulate an unexpected instance exit.
   * @param runtimeId - instance that exits.
   */
  kill(runtimeId: string): void {
    const instance = this.instances.get(runtimeId)
    if (instance !== undefined) instance.running = false
  }

  /** @returns every known runtime id. */
  runtimeIds(): string[] {
    return [...this.instances.keys()]
  }
}

/** Minimal spawned child used to prove the manager-to-process-backend wiring. */
class ManagerChild implements SpawnedProcess {
  readonly pid = 5_151
  readonly stdout: NodeJS.ReadableStream | null = null
  readonly stderr: NodeJS.ReadableStream | null = null
  private readonly exitListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = []

  /** @inheritDoc */
  kill(signal?: NodeJS.Signals): boolean {
    for (const listener of [...this.exitListeners]) listener(0, signal ?? null)
    return true
  }

  /** @inheritDoc */
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.push(listener)
  }

  /** @inheritDoc */
  onError(_listener: (error: Error) => void): void {
    // The wiring test never reports a spawn failure.
  }
}

/** One manager harness with an isolated registry and scripted backend. */
interface Harness {
  readonly manager: RuntimeManager
  readonly backend: FakeBackend
  readonly clock: TestClock
  readonly scheduler: TestScheduler
  readonly config: RuntimeManagerConfig
  readonly platformDataDir: string
  readonly runtimeDataDir: string
}

/** Overrides accepted by {@link makeHarness}. */
interface HarnessOptions {
  readonly kind?: 'process' | 'container'
  readonly idleSeconds?: number
  readonly reapIntervalMs?: number
  readonly inspectIntervalMs?: number
  readonly backend?: FakeBackend
  readonly clock?: TestClock
  readonly maxConcurrentStarts?: number
}

/**
 * Create a tracked temporary directory.
 * @returns the absolute directory.
 */
async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-runtime-manager-'))
  temporaryDirectories.push(directory)
  return directory
}

/**
 * Build one manager over a temporary registry and a scripted backend.
 * @param options - backend kind, idle policy, and injection overrides.
 * @returns the harness.
 */
async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const platformDataDir = await makeTemporaryDirectory()
  const clock = options.clock ?? new TestClock()
  const scheduler = new TestScheduler()
  const backend = options.backend ?? new FakeBackend()
  const platform = createPlatformConfig({
    dataDir: platformDataDir,
    realm: REALM,
    runtime: {
      kind: options.kind ?? 'process',
      root: join(platformDataDir, 'spaces'),
      spaceKeySecret: SECRET,
      idleSeconds: options.idleSeconds ?? 60,
      reapIntervalMs: options.reapIntervalMs ?? 60_000,
      startTimeoutMs: 500,
      maxConcurrentStarts: options.maxConcurrentStarts ?? 4,
      processCommand: ['node', 'bin.ts'],
      patchFile: join(platformDataDir, 'platform-runtime.patch.yml'),
      image: 'registry.example/dsh-runtime@sha256:deadbeef',
    },
  })
  const config: RuntimeManagerConfig = { ...platform.runtime, dataDir: platformDataDir, realm: REALM }
  const runtimeDataDir = join(platformDataDir, 'runtime')
  const manager = await createRuntimeManager(config, {
    backend,
    now: clock.now,
    timers: scheduler,
    inspectIntervalMs: options.inspectIntervalMs ?? 0,
    runtimeAuth: {
      publicKeyFile: join(platformDataDir, 'gateway-public.pem'),
      issuer: 'dsh-gateway',
      audience: 'dsh-web',
      keyId: 'dsh-gateway-key-v1',
      replayWindowSeconds: 60,
      maxLifetimeSeconds: 300,
    },
    publicOrigin: 'http://127.0.0.1:8080',
    publicAuthority: '127.0.0.1:8080',
    dataDir: runtimeDataDir,
    log: () => undefined,
  })
  openManagers.push(manager)
  return { manager, backend, clock, scheduler, config, platformDataDir, runtimeDataDir }
}

/**
 * Resolve one user's space for the harness configuration.
 * @param harness - manager harness.
 * @param userId - internal user id.
 * @returns the resolved space paths.
 */
function spaceFor(harness: Harness, userId: string): RuntimeSpacePaths {
  return resolveRuntimeSpace({ root: harness.config.root, realm: REALM, userId, spaceKeySecret: SECRET })
}

/**
 * Trigger the idle reaper and wait for its work on one user to settle.
 * @param harness - manager harness.
 * @param userId - user whose reclamation should settle.
 */
async function runReaper(harness: Harness, userId: string): Promise<void> {
  for (const callback of harness.scheduler.callbacks) callback()
  // The reaper serializes behind lifecycle work; a status call queues after it.
  await harness.manager.status(userId)
}

/**
 * Wait until a condition holds, polling on real timers.
 * @param predicate - condition to wait for.
 * @param timeoutMs - longest accepted wait.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not met in time')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/**
 * Prove one ensure result is READY with a private target.
 * @param result - ensure result.
 * @param generation - expected generation.
 */
function expectReady(result: RuntimeEnsureResult, generation: number): RuntimeTarget {
  expect(result.state).toBe('READY')
  expect(result.generation).toBe(generation)
  expect(result.retryable).toBe(false)
  expect(result.errorCode).toBeNull()
  const target = result.target
  if (target === undefined) throw new Error('expected a READY target')
  expect(target.generation).toBe(generation)
  expect(target.host).toBe('127.0.0.1')
  expect(target.port).toBeGreaterThan(0)
  return target
}

afterEach(async () => {
  await Promise.all(
    openManagers.splice(0).map(async manager => {
      await manager.close().catch(() => undefined)
    }),
  )
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('runtime manager ensure', () => {
  it('allocates one space, starts once, and reports READY with a private target', async () => {
    const harness = await makeHarness()
    const result = await harness.manager.ensure(USER_A)
    expectReady(result, 1)
    expect(harness.backend.startCalls).toHaveLength(1)
    expect(harness.backend.startCalls[0]?.userId).toBe(USER_A)
    expect(harness.backend.startCalls[0]?.generation).toBe(1)
    expect(harness.backend.startCalls[0]?.space.spaceKey).toBe(harness.backend.startCalls[0]?.spaceKey)
    const space = spaceFor(harness, USER_A)
    expect((await stat(space.dshHome)).isDirectory()).toBe(true)
    expect((await stat(space.defaultWorkspace)).isDirectory()).toBe(true)
    const status = await harness.manager.status(USER_A)
    expect(status).toEqual({ state: 'READY', generation: 1, retryable: false, errorCode: null })
  })

  it('reports UNALLOCATED status without starting anything', async () => {
    const harness = await makeHarness()
    expect(await harness.manager.status(USER_A)).toEqual({
      state: 'UNALLOCATED',
      generation: 0,
      retryable: false,
      errorCode: null,
    })
    expect(harness.backend.startCalls).toHaveLength(0)
  })

  it('starts only once for ten concurrent ensures of one user', async () => {
    const harness = await makeHarness()
    const results = await Promise.all(Array.from({ length: 10 }, async () => await harness.manager.ensure(USER_A)))
    expect(harness.backend.startCalls).toHaveLength(1)
    for (const result of results) expectReady(result, 1)
    expect(new Set(results.map(result => result.target?.port)).size).toBe(1)
  })

  it('starts different users concurrently without blocking each other', async () => {
    const harness = await makeHarness()
    harness.backend.startBehavior = 'deferred'
    const first = harness.manager.ensure(USER_A)
    const second = harness.manager.ensure(USER_B)
    await waitFor(() => harness.backend.startCalls.length === 2)
    expect(new Set(harness.backend.startCalls.map(spec => spec.userId))).toEqual(new Set([USER_A, USER_B]))
    harness.backend.releaseStart(USER_A)
    harness.backend.releaseStart(USER_B)
    const [resultA, resultB] = await Promise.all([first, second])
    expectReady(resultA, 1)
    expectReady(resultB, 1)
    expect(resultA.target?.port).not.toBe(resultB.target?.port)
    expect(spaceFor(harness, USER_A).directory).not.toBe(spaceFor(harness, USER_B).directory)
  })

  it('bounds concurrent cold starts with maxConcurrentStarts', async () => {
    const harness = await makeHarness({ maxConcurrentStarts: 1 })
    harness.backend.startBehavior = 'deferred'
    const first = harness.manager.ensure(USER_A)
    await waitFor(() => harness.backend.startCalls.length === 1)
    const second = harness.manager.ensure(USER_B)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(harness.backend.startCalls).toHaveLength(1)
    harness.backend.releaseStart(USER_A)
    await waitFor(() => harness.backend.startCalls.length === 2)
    harness.backend.releaseStart(USER_B)
    const [resultA, resultB] = await Promise.all([first, second])
    expectReady(resultA, 1)
    expectReady(resultB, 1)
  })

  it('keeps one startup for two browsers of the same identity', async () => {
    const harness = await makeHarness()
    const first = await harness.manager.ensure(USER_A)
    const second = await harness.manager.ensure(USER_A)
    expectReady(first, 1)
    expectReady(second, 1)
    expect(harness.backend.startCalls).toHaveLength(1)
    expect(first.target).toEqual(second.target)
  })

  it('resets the idle activity timestamp on every ensure', async () => {
    const harness = await makeHarness({ idleSeconds: 1_000 })
    await harness.manager.ensure(USER_A)
    harness.clock.advance(900_000)
    await harness.manager.ensure(USER_A)
    harness.clock.advance(900_000)
    await runReaper(harness, USER_A)
    expect(harness.backend.stopCalls).toHaveLength(0)
    expect((await harness.manager.status(USER_A)).state).toBe('READY')
  })

  it('rejects unsafe user ids on every lifecycle entry point', async () => {
    const harness = await makeHarness()
    for (const userId of ['../escape', 'a/b', '', 'x'.repeat(129)]) {
      await expect(harness.manager.ensure(userId)).rejects.toMatchObject({ code: 'RUNTIME_INVALID_USER' })
      await expect(harness.manager.retry(userId)).rejects.toMatchObject({ code: 'RUNTIME_INVALID_USER' })
      await expect(harness.manager.status(userId)).rejects.toMatchObject({ code: 'RUNTIME_INVALID_USER' })
      expect(() => harness.manager.lease(userId)).toThrow(RuntimeManagerError)
      expect(() => harness.manager.touch(userId)).toThrow(RuntimeManagerError)
    }
    expect(harness.backend.startCalls).toHaveLength(0)
  })
})

describe('runtime manager generation and failure', () => {
  it('restarts a READY runtime as a new generation and stops the old instance', async () => {
    const harness = await makeHarness()
    const first = await harness.manager.ensure(USER_A)
    expectReady(first, 1)
    const firstRuntimeId = harness.backend.instances.keys().next().value
    if (firstRuntimeId === undefined) throw new Error('expected a started runtime instance')

    const restarted = await harness.manager.restart(USER_A)
    expectReady(restarted, 2)
    expect(harness.backend.stopCalls).toContain(firstRuntimeId)
    expect(harness.backend.startCalls).toHaveLength(2)
    const status = await harness.manager.status(USER_A)
    expect(status).toMatchObject({ state: 'READY', generation: 2, retryable: false })
  })

  it('restarts a user without an allocated runtime by starting one', async () => {
    const harness = await makeHarness()
    const started = await harness.manager.restart(USER_B)
    expectReady(started, 1)
    expect(harness.backend.stopCalls).toHaveLength(0)
  })

  it('reports a retryable FAILED result and does not restart on ensure', async () => {
    const harness = await makeHarness()
    harness.backend.startBehavior = 'fail'
    const failed = await harness.manager.ensure(USER_A)
    expect(failed.state).toBe('FAILED')
    expect(failed.generation).toBe(1)
    expect(failed.retryable).toBe(true)
    expect(failed.errorCode).toBe('RUNTIME_START_TIMEOUT')
    expect(failed.target).toBeUndefined()
    const again = await harness.manager.ensure(USER_A)
    expect(again.state).toBe('FAILED')
    expect(harness.backend.startCalls).toHaveLength(1)
    expect(await harness.manager.status(USER_A)).toEqual({
      state: 'FAILED',
      generation: 1,
      retryable: true,
      errorCode: 'RUNTIME_START_TIMEOUT',
    })
  })

  it('starts a new generation on explicit retry and grows generation across restarts', async () => {
    const harness = await makeHarness()
    harness.backend.startBehavior = 'fail'
    await harness.manager.ensure(USER_A)
    harness.backend.startBehavior = 'success'
    const retried = await harness.manager.retry(USER_A)
    expectReady(retried, 2)
    expect(harness.backend.startCalls).toHaveLength(2)
    harness.backend.kill(harness.backend.runtimeIds()[0] ?? '')
    await harness.manager.status(USER_A)
    const retriedAgain = await harness.manager.retry(USER_A)
    expectReady(retriedAgain, 3)
    expect(harness.backend.startCalls).toHaveLength(3)
  })

  it('detects an unexpected exit on status and ensure and recovers through retry', async () => {
    const harness = await makeHarness()
    const ready = await harness.manager.ensure(USER_A)
    expectReady(ready, 1)
    const runtimeId = harness.backend.runtimeIds()[0]
    if (runtimeId === undefined) throw new Error('expected a backend instance')
    harness.backend.kill(runtimeId)
    const exitedStatus = await harness.manager.status(USER_A)
    expect(exitedStatus).toEqual({
      state: 'FAILED',
      generation: 1,
      retryable: true,
      errorCode: 'RUNTIME_EXITED',
    })
    const exitedEnsure = await harness.manager.ensure(USER_A)
    expect(exitedEnsure.state).toBe('FAILED')
    expect(exitedEnsure.retryable).toBe(true)
    const recovered = await harness.manager.retry(USER_A)
    expectReady(recovered, 2)

    harness.backend.kill(harness.backend.runtimeIds()[1] ?? '')
    const exitedAgain = await harness.manager.ensure(USER_A)
    expect(exitedAgain.state).toBe('FAILED')
    expect(exitedAgain.errorCode).toBe('RUNTIME_EXITED')
    expectReady(await harness.manager.retry(USER_A), 3)
  })

  it('refuses to start a duplicate generation while an old instance still runs', async () => {
    const harness = await makeHarness()
    await harness.manager.ensure(USER_A)
    const runtimeId = harness.backend.runtimeIds()[0]
    if (runtimeId === undefined) throw new Error('expected a backend instance')
    // Force the persisted record back to FAILED while the backend instance survives.
    const registry = RuntimeRegistry.open(join(harness.runtimeDataDir, 'runtime.sqlite'))
    try {
      const record = registry.find(REALM, USER_A)
      if (record === undefined) throw new Error('expected a persisted record')
      registry.update(record.id, { state: 'FAILED', lastErrorCode: 'RUNTIME_EXITED' })
    } finally {
      registry.close()
    }
    harness.backend.surviveStop = true
    const conflicted = await harness.manager.retry(USER_A)
    expect(conflicted.state).toBe('FAILED')
    expect(conflicted.errorCode).toBe('RUNTIME_INSTANCE_CONFLICT')
    expect(harness.backend.startCalls).toHaveLength(1)
    expect(harness.backend.stopCalls).toHaveLength(1)
  })
})

describe('runtime manager restart reconciliation', () => {
  it('adopts a runtime that survived a supervisor restart instead of starting again', async () => {
    const first = await makeHarness({ kind: 'container' })
    const ready = await first.manager.ensure(USER_A)
    expectReady(ready, 1)
    const runtimeId = first.backend.runtimeIds()[0]
    if (runtimeId === undefined) throw new Error('expected a backend instance')
    const persisted = first.backend.instances.get(runtimeId)
    if (persisted === undefined) throw new Error('expected a persisted instance')
    expect(persisted.running).toBe(true)
    await first.manager.close()
    expect(persisted.running).toBe(true)

    const survivor = new FakeBackend()
    survivor.instances.set(runtimeId, persisted)
    const adopted = await createRuntimeManager(first.config, {
      backend: survivor,
      now: first.clock.now,
      timers: new TestScheduler(),
      inspectIntervalMs: 0,
      dataDir: first.runtimeDataDir,
      runtimeAuth: {
        publicKeyFile: join(first.platformDataDir, 'gateway-public.pem'),
        issuer: 'dsh-gateway',
        audience: 'dsh-web',
        keyId: 'dsh-gateway-key-v1',
        replayWindowSeconds: 60,
        maxLifetimeSeconds: 300,
      },
      publicOrigin: 'http://127.0.0.1:8080',
      publicAuthority: '127.0.0.1:8080',
      log: () => undefined,
    })
    openManagers.push(adopted)
    const adoptedStatus = await adopted.status(USER_A)
    expect(adoptedStatus).toEqual({ state: 'READY', generation: 1, retryable: false, errorCode: null })
    expectReady(await adopted.ensure(USER_A), 1)
    expect(survivor.startCalls).toHaveLength(0)
  })

  it('marks a stale READY record FAILED for an explicit retry', async () => {
    const first = await makeHarness({ kind: 'container' })
    await first.manager.ensure(USER_A)
    const runtimeId = first.backend.runtimeIds()[0]
    if (runtimeId === undefined) throw new Error('expected a backend instance')
    const persisted = first.backend.instances.get(runtimeId)
    if (persisted === undefined) throw new Error('expected a persisted instance')
    await first.manager.close()
    const survivor = new FakeBackend()
    survivor.instances.set(runtimeId, { ...persisted, running: false })
    const second = await createRuntimeManager(
      { ...first.config },
      {
        backend: survivor,
        now: first.clock.now,
        timers: new TestScheduler(),
        inspectIntervalMs: 0,
        dataDir: first.runtimeDataDir,
        runtimeAuth: {
          publicKeyFile: join(first.platformDataDir, 'gateway-public.pem'),
          issuer: 'dsh-gateway',
          audience: 'dsh-web',
          keyId: 'dsh-gateway-key-v1',
          replayWindowSeconds: 60,
          maxLifetimeSeconds: 300,
        },
        publicOrigin: 'http://127.0.0.1:8080',
        publicAuthority: '127.0.0.1:8080',
        log: () => undefined,
      },
    )
    openManagers.push(second)
    const status = await second.status(USER_A)
    expect(status).toEqual({ state: 'FAILED', generation: 1, retryable: true, errorCode: 'RUNTIME_EXITED' })
    expect(survivor.startCalls).toHaveLength(0)
    expectReady(await second.retry(USER_A), 2)
  })
})

describe('runtime manager idle reclamation and leases', () => {
  it('stops an idle runtime, keeps its data, and starts a new generation on the next visit', async () => {
    const harness = await makeHarness({ idleSeconds: 1, reapIntervalMs: 1_000 })
    expectReady(await harness.manager.ensure(USER_A), 1)
    const space = spaceFor(harness, USER_A)
    await writeFile(join(space.dshHome, 'session.json'), '{"kept":true}\n')
    harness.clock.advance(2_000)
    await runReaper(harness, USER_A)
    expect(harness.backend.stopCalls).toHaveLength(1)
    expect(await harness.manager.status(USER_A)).toEqual({
      state: 'STOPPED',
      generation: 1,
      retryable: false,
      errorCode: null,
    })
    expect((await stat(space.dshHome)).isDirectory()).toBe(true)
    expect(await readFile(join(space.dshHome, 'session.json'), 'utf8')).toBe('{"kept":true}\n')

    const restarted = await harness.manager.ensure(USER_A)
    const target = expectReady(restarted, 2)
    expect(target.port).toBeGreaterThan(0)
    expect(harness.backend.startCalls).toHaveLength(2)
    expect(await readFile(join(space.dshHome, 'session.json'), 'utf8')).toBe('{"kept":true}\n')
  })

  it('never reclaims while a lease is held and reclaims after it is released', async () => {
    const harness = await makeHarness({ idleSeconds: 1, reapIntervalMs: 1_000 })
    await harness.manager.ensure(USER_A)
    const release = harness.manager.lease(USER_A)
    harness.clock.advance(10_000)
    await runReaper(harness, USER_A)
    expect(harness.backend.stopCalls).toHaveLength(0)
    expect((await harness.manager.status(USER_A)).state).toBe('READY')
    release()
    release()
    harness.clock.advance(10_000)
    await runReaper(harness, USER_A)
    expect(harness.backend.stopCalls).toHaveLength(1)
    expect((await harness.manager.status(USER_A)).state).toBe('STOPPED')
  })

  it('reclaims a runtime whose user activity is older than the idle window', async () => {
    const harness = await makeHarness({ idleSeconds: 10, reapIntervalMs: 1_000 })
    await harness.manager.ensure(USER_A)
    harness.clock.advance(9_000)
    harness.manager.touch(USER_A)
    harness.clock.advance(9_000)
    await runReaper(harness, USER_A)
    expect(harness.backend.stopCalls).toHaveLength(0)
    harness.clock.advance(2_000)
    await runReaper(harness, USER_A)
    expect(harness.backend.stopCalls).toHaveLength(1)
    expect((await harness.manager.status(USER_A)).state).toBe('STOPPED')
  })

  it('marks an unexpectedly exited runtime FAILED during a reaper tick', async () => {
    const harness = await makeHarness({ idleSeconds: 600, reapIntervalMs: 1_000 })
    await harness.manager.ensure(USER_A)
    harness.backend.kill(harness.backend.runtimeIds()[0] ?? '')
    await runReaper(harness, USER_A)
    expect(await harness.manager.status(USER_A)).toEqual({
      state: 'FAILED',
      generation: 1,
      retryable: true,
      errorCode: 'RUNTIME_EXITED',
    })
    expect(harness.backend.stopCalls).toHaveLength(0)
    expectReady(await harness.manager.retry(USER_A), 2)
  })

  it('keeps READY when a reaper inspection cannot reach the backend', async () => {
    const harness = await makeHarness({ idleSeconds: 1, reapIntervalMs: 1_000 })
    await harness.manager.ensure(USER_A)
    harness.backend.failInspect = true
    harness.clock.advance(10_000)
    await runReaper(harness, USER_A)
    expect((await harness.manager.status(USER_A)).state).toBe('READY')
  })
})

describe('runtime manager close', () => {
  it('clears the reaper timer, stops its own process runtime, and persists STOPPED', async () => {
    const harness = await makeHarness({ kind: 'process', idleSeconds: 600, reapIntervalMs: 1_000 })
    const ready = await harness.manager.ensure(USER_A)
    expectReady(ready, 1)
    expect(harness.scheduler.callbacks).toHaveLength(1)
    await harness.manager.close()
    expect(harness.scheduler.cleared).toEqual([1])
    expect(harness.backend.stopCalls).toHaveLength(1)
    expect(harness.backend.closed).toBe(true)
    await expect(harness.manager.status(USER_A)).rejects.toMatchObject({ code: 'RUNTIME_MANAGER_CLOSED' })
    await expect(harness.manager.ensure(USER_A)).rejects.toMatchObject({ code: 'RUNTIME_MANAGER_CLOSED' })

    const registry = RuntimeRegistry.open(join(harness.runtimeDataDir, 'runtime.sqlite'))
    try {
      expect(registry.find(REALM, USER_A)).toMatchObject({
        state: 'STOPPED',
        desiredState: 'STOPPED',
        runtimeId: null,
      })
    } finally {
      registry.close()
    }
  })

  it('leaves container runtimes running so a restart can adopt them', async () => {
    const harness = await makeHarness({ kind: 'container', idleSeconds: 600, reapIntervalMs: 1_000 })
    await harness.manager.ensure(USER_A)
    await harness.manager.close()
    expect(harness.backend.stopCalls).toHaveLength(0)
    expect(harness.backend.closed).toBe(true)
    const registry = RuntimeRegistry.open(join(harness.runtimeDataDir, 'runtime.sqlite'))
    try {
      expect(registry.find(REALM, USER_A)).toMatchObject({ state: 'READY', desiredState: 'RUNNING' })
    } finally {
      registry.close()
    }
  })

  it('starts without a reaper timer when reclamation is disabled', async () => {
    const harness = await makeHarness({ idleSeconds: 0, reapIntervalMs: 0 })
    await harness.manager.ensure(USER_A)
    expect(harness.scheduler.callbacks).toHaveLength(0)
  })
})

describe('runtime manager with the real process backend', () => {
  it('stamps the fixed subject, generation, assertion facts, origin, and workspace on the spawned process', async () => {
    const platformDataDir = await makeTemporaryDirectory()
    const clock = new TestClock()
    const platform = createPlatformConfig({
      dataDir: platformDataDir,
      realm: REALM,
      runtime: {
        kind: 'process',
        root: join(platformDataDir, 'spaces'),
        spaceKeySecret: SECRET,
        processCommand: ['node', 'bin.ts'],
        patchFile: join(platformDataDir, 'platform-runtime.patch.yml'),
        startTimeoutMs: 500,
        maxConcurrentStarts: 2,
      },
    })
    const config: RuntimeManagerConfig = { ...platform.runtime, dataDir: platformDataDir, realm: REALM }
    const spawns: { args: readonly string[]; options: SpawnOptionsLike }[] = []
    const manager = await createRuntimeManager(config, {
      now: clock.now,
      timers: new TestScheduler(),
      inspectIntervalMs: 0,
      dataDir: join(platformDataDir, 'runtime'),
      runtimeAuth: {
        publicKeyFile: join(platformDataDir, 'public.pem'),
        issuer: 'dsh-gateway',
        audience: 'dsh-web',
        keyId: 'dsh-gateway-key-v1',
        replayWindowSeconds: 60,
        maxLifetimeSeconds: 300,
      },
      publicOrigin: 'https://platform.example',
      publicAuthority: 'platform.example',
      portAllocator: async () => 43_210,
      probe: async () => true,
      spawn: (_command, args, options) => {
        spawns.push({ args, options })
        return new ManagerChild()
      },
      log: () => undefined,
    })
    openManagers.push(manager)
    expectReady(await manager.ensure(USER_A), 1)
    const [spawned] = spawns
    if (spawned === undefined) throw new Error('expected a spawned runtime process')
    const space = resolveRuntimeSpace({
      root: config.root,
      realm: REALM,
      userId: USER_A,
      spaceKeySecret: SECRET,
    })
    expect(spawned.options.cwd).toBe(space.defaultWorkspace)
    expect(spawned.options.env.DSH_RUNTIME_SUBJECT).toBe(USER_A)
    expect(spawned.options.env.DSH_RUNTIME_GENERATION).toBe('1')
    expect(spawned.options.env.DSH_GATEWAY_PUBLIC_KEY_FILE).toBe(join(platformDataDir, 'public.pem'))
    expect(spawned.options.env.DSH_GATEWAY_ISSUER).toBe('dsh-gateway')
    expect(spawned.options.env.DSH_GATEWAY_AUDIENCE).toBe('dsh-web')
    expect(spawned.options.env.DSH_GATEWAY_KEY_ID).toBe('dsh-gateway-key-v1')
    expect(spawned.options.env.DSH_HOME).toBe(space.dshHome)
    expect(spawned.options.env.DEEPSEEK_API_KEY).toBeUndefined()
    expect(spawned.options.env.DSH_GATEWAY_PUBLIC_URL).toBeUndefined()
    expect(spawned.args).toContain('--public-url')
    expect(spawned.args[spawned.args.indexOf('--public-url') + 1]).toBe('https://platform.example')
    expect(spawned.args[spawned.args.indexOf('--trusted-host') + 1]).toBe('platform.example')
    expect(spawned.args[spawned.args.indexOf('--port') + 1]).toBe('43210')
  })

  it('refuses to build a real backend without assertion facts', async () => {
    const harness = await makeHarness()
    await expect(
      createRuntimeManager(harness.config, { dataDir: join(harness.platformDataDir, 'runtime-unconfigured') }),
    ).rejects.toMatchObject({ code: 'RUNTIME_CONFIG_INVALID' })
  })

  it('rejects runtime environment injection for the container backend', async () => {
    const dataDir = await makeTemporaryDirectory()
    const platform = createPlatformConfig({
      dataDir,
      realm: REALM,
      runtime: {
        kind: 'container',
        root: join(dataDir, 'spaces'),
        spaceKeySecret: SECRET,
        idleSeconds: 60,
        image: 'registry.example/dsh-runtime@sha256:deadbeef',
        patchFile: join(dataDir, 'platform-runtime.patch.yml'),
      },
    })
    const config = { ...platform.runtime, dataDir, realm: REALM }
    await expect(
      createRuntimeManager(config, { runtimeEnv: { DEEPSEEK_API_KEY: 'mock-key' } }),
    ).rejects.toMatchObject({ code: 'RUNTIME_CONFIG_INVALID' })
  })
})

describe('runtime manager space provisioning', () => {
  it('creates every documented space directory for each user', async () => {
    const harness = await makeHarness()
    await harness.manager.ensure(USER_A)
    await harness.manager.ensure(USER_B)
    const spaceA = spaceFor(harness, USER_A)
    const spaceB = spaceFor(harness, USER_B)
    await ensureRuntimeSpaceDirs(spaceA)
    for (const directory of [
      spaceA.dshHome,
      spaceA.home,
      spaceA.agentsHome,
      spaceA.workspaces,
      spaceA.defaultWorkspace,
      spaceA.uploads,
      spaceA.tmp,
      spaceB.dshHome,
      spaceB.tmp,
    ]) {
      expect((await stat(directory)).isDirectory()).toBe(true)
    }
    expect(spaceA.spaceKey).not.toBe(spaceB.spaceKey)
  })
})
