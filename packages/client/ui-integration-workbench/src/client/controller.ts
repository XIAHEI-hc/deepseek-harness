/**
 * One-shot availability controller for the fusion workbench.
 *
 * The plugin body reads `/api/integration/status` once after boot. A deployment
 * without the fusion API (404 or transport failure) publishes `unavailable` and
 * the workbench renders nothing; a blocked service still publishes its status so
 * the panel can list missing prerequisites without exposing host paths.
 */
import { loadFusionStatus, type FusionStatus, type FusionTransport } from './api.ts'

/** What the shell knows about fusion availability. */
export type FusionAvailability =
  | { readonly status: 'loading' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'available'; readonly service: FusionStatus }

/** Observable plugin state. */
export interface FusionAvailabilityController {
  /** Read the current snapshot; the reference is stable until it changes. */
  getSnapshot(): FusionAvailability
  /**
   * Subscribe to changes.
   * @param listener - change callback.
   * @returns unsubscribe.
   */
  subscribe(listener: () => void): () => void
  /** Read the service status once. */
  start(): void
  /** Stop accepting results and drop listeners. */
  dispose(): void
}

/**
 * Create the availability controller for one plugin body.
 * @param transport - same-origin transport.
 * @returns the controller.
 */
export function createFusionAvailabilityController(transport: FusionTransport): FusionAvailabilityController {
  let snapshot: FusionAvailability = { status: 'loading' }
  const listeners = new Set<() => void>()
  let disposed = false

  const publish = (next: FusionAvailability): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start(): void {
      void loadFusionStatus(transport).then((status) => {
        if (disposed) return
        if (status === undefined || status.state === 'disabled') publish({ status: 'unavailable' })
        else publish({ status: 'available', service: status })
      }).catch(() => {
        if (!disposed) publish({ status: 'unavailable' })
      })
    },
    dispose(): void {
      disposed = true
      listeners.clear()
    },
  }
}
