/**
 * Platform identity and personal-runtime state machine.
 *
 * One controller instance belongs to the plugin body: it owns the initial
 * `/auth/me` read, the runtime status checks and their polling, sign-out, and
 * the local clearing a 401 requires. Both UI surfaces read its snapshot through
 * the injected hook compartment.
 */
import {
  fetchPlatformIdentity, fetchRuntimeStatus, logoutAllPlatform, logoutPlatform, redirectToLogin, redirectToLoginRoot,
  retryRuntimeStatus, wakeRuntimeStatus, type PlatformTransport, type RuntimeStatusResponse,
} from './api.ts'
import type { PlatformIdentitySnapshot, PlatformUser, RuntimePhase, RuntimeView } from './contract.ts'

/** Delay between personal-runtime status checks while it starts. */
export const RUNTIME_POLL_INTERVAL_MS = 2_000

/** Status checks allowed before the overlay offers a recheck instead of waiting. */
export const RUNTIME_POLL_LIMIT = 60

/** Timer face the controller uses; tests drive polling without real waits. */
export interface PlatformTimers {
  /** @param callback - poll callback. @param milliseconds - delay before it runs. @returns timer handle. */
  setTimeout(callback: () => void, milliseconds: number): unknown
  /** @param handle - timer handle returned by {@link PlatformTimers.setTimeout}. */
  clearTimeout(handle: unknown): void
}

/** Timer face bound to the page's own timers. */
export const browserTimers: PlatformTimers = {
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: (handle) => { globalThis.clearTimeout(handle as number) },
}

/** The plugin body's state handle; `getSnapshot`/`subscribe` are the observable contract. */
export interface PlatformIdentityController {
  /** Read the current snapshot (stable reference until a fact changes). */
  getSnapshot(): PlatformIdentitySnapshot
  /** Subscribe to snapshot changes. @param listener - change callback. @returns unsubscribe. */
  subscribe(listener: () => void): () => void
  /** Read the platform identity and, once known, the personal runtime. */
  start(): void
  /** Retry a failed runtime or recheck an unreachable runtime surface. */
  retryRuntime(): void
  /**
   * Revoke the browser session and clear local state.
   * @returns `'ok'` when sign-in navigation was requested, `'failed'` otherwise.
   */
  logout(): Promise<'ok' | 'failed'>
  /**
   * Revoke every browser session of this identity (including this browser) and
   * clear local state.
   * @returns `'ok'` when sign-in navigation was requested, `'failed'` otherwise.
   */
  logoutAll(): Promise<'ok' | 'failed'>
  /** Stop polling and drop listeners. */
  dispose(): void
}

/**
 * Create the controller for one plugin body.
 * @param transport - platform transport the controller reads and mutates.
 * @param timers - timer face for runtime polling; the page's own timers by default.
 * @returns the controller publishing identity and runtime state.
 */
export function createPlatformIdentityController(
  transport: PlatformTransport,
  timers: PlatformTimers = browserTimers,
): PlatformIdentityController {
  let snapshot: PlatformIdentitySnapshot = { identity: { status: 'loading' }, runtime: { status: 'idle' } }
  const listeners = new Set<() => void>()
  let pollTimer: unknown
  let polls = 0
  let disposed = false
  // Read through a function so a mutation from another continuation (dispose)
  // is never treated as an unreachable branch by control-flow analysis.
  const disposedNow = (): boolean => disposed
  let redirecting = false
  let loadingIdentity = false
  let retryingRuntime = false

  const publish = (next: PlatformIdentitySnapshot): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  const setIdentity = (identity: PlatformIdentitySnapshot['identity']): void => {
    publish({ ...snapshot, identity })
  }
  const setRuntime = (runtime: RuntimeView): void => {
    publish({ ...snapshot, runtime })
  }
  const clearPoll = (): void => {
    if (pollTimer === undefined) return
    timers.clearTimeout(pollTimer)
    pollTimer = undefined
  }
  const handleUnauthorized = (): void => {
    clearPoll()
    polls = 0
    publish({ identity: { status: 'unauthorized' }, runtime: { status: 'idle' } })
    if (redirecting) return
    redirecting = true
    redirectToLogin(transport)
  }
  // A completed sign-out (this browser or every session) ends local state and
  // returns to the bare sign-in page, never to the page that 401'd.
  const settleRevoked = (): void => {
    clearPoll()
    polls = 0
    publish({ identity: { status: 'unauthorized' }, runtime: { status: 'idle' } })
    redirectToLoginRoot(transport)
  }
  const schedulePoll = (phase: RuntimePhase): void => {
    polls += 1
    if (polls > RUNTIME_POLL_LIMIT) {
      clearPoll()
      setRuntime({ status: 'unavailable' })
      return
    }
    setRuntime({ status: 'starting', phase })
    clearPoll()
    pollTimer = timers.setTimeout(() => {
      pollTimer = undefined
      void checkRuntime()
    }, RUNTIME_POLL_INTERVAL_MS)
  }
  const advanceRuntime = async (status: RuntimeStatusResponse, afterWake: boolean): Promise<void> => {
    if (disposedNow()) return
    switch (status.state) {
      case 'READY':
        clearPoll()
        polls = 0
        setRuntime({ status: 'ready' })
        return
      case 'FAILED':
        clearPoll()
        polls = 0
        setRuntime({
          status: 'failed',
          retryable: status.retryable,
          ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
        })
        return
      case 'STARTING':
      case 'PROVISIONING':
      case 'STOPPING':
        schedulePoll(status.state)
        return
      case 'UNALLOCATED':
      case 'STOPPED': {
        if (afterWake) {
          schedulePoll('PROVISIONING')
          return
        }
        const woken = await wakeRuntimeStatus(transport)
        if (disposedNow()) return
        if (woken.kind === 'unauthorized') {
          handleUnauthorized()
          return
        }
        if (woken.kind !== 'ok') {
          clearPoll()
          setRuntime({ status: 'unavailable' })
          return
        }
        await advanceRuntime(woken.value, true)
        return
      }
    }
  }
  const checkRuntime = async (): Promise<void> => {
    if (disposedNow()) return
    const response = await fetchRuntimeStatus(transport)
    if (disposedNow()) return
    if (response.kind === 'unauthorized') {
      handleUnauthorized()
      return
    }
    if (response.kind === 'forbidden') {
      clearPoll()
      publish({ identity: { status: 'disabled' }, runtime: { status: 'idle' } })
      return
    }
    if (response.kind !== 'ok') {
      clearPoll()
      setRuntime({ status: 'unavailable' })
      return
    }
    await advanceRuntime(response.value, false)
  }
  const loadIdentity = async (): Promise<void> => {
    if (disposedNow() || loadingIdentity) return
    loadingIdentity = true
    try {
      setIdentity({ status: 'loading' })
      const response = await fetchPlatformIdentity(transport)
      if (disposedNow()) return
      switch (response.kind) {
        case 'ok': {
          const user: PlatformUser = response.value.user
          publish({ identity: { status: 'ready', user }, runtime: { status: 'checking' } })
          polls = 0
          await checkRuntime()
          return
        }
        case 'unauthorized':
          handleUnauthorized()
          return
        case 'forbidden':
          publish({ identity: { status: 'disabled' }, runtime: { status: 'idle' } })
          return
        case 'missing':
        case 'unavailable':
          publish({ identity: { status: 'unavailable' }, runtime: { status: 'idle' } })
          return
      }
    } finally {
      loadingIdentity = false
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    start: () => { void loadIdentity() },
    retryRuntime: () => {
      if (disposedNow() || retryingRuntime) return
      retryingRuntime = true
      clearPoll()
      void (async () => {
        try {
          if (snapshot.runtime.status === 'failed') {
            const response = await retryRuntimeStatus(transport)
            if (disposedNow()) return
            if (response.kind === 'unauthorized') {
              handleUnauthorized()
              return
            }
            if (response.kind !== 'ok') {
              setRuntime({ status: 'unavailable' })
              return
            }
            polls = 0
            setRuntime({ status: 'checking' })
            await advanceRuntime(response.value, false)
            return
          }
          polls = 0
          setRuntime({ status: 'checking' })
          await checkRuntime()
        } finally {
          retryingRuntime = false
        }
      })()
    },
    logout: async () => {
      const response = await logoutPlatform(transport)
      if (disposedNow()) return 'failed'
      if (response.kind === 'ok' || response.kind === 'unauthorized') {
        settleRevoked()
        return 'ok'
      }
      return 'failed'
    },
    logoutAll: async () => {
      const response = await logoutAllPlatform(transport)
      if (disposedNow()) return 'failed'
      if (response.kind === 'ok' || response.kind === 'unauthorized') {
        settleRevoked()
        return 'ok'
      }
      return 'failed'
    },
    dispose: () => {
      disposed = true
      clearPoll()
      listeners.clear()
    },
  }
}
