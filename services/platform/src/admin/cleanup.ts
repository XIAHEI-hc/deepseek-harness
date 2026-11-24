/**
 * Administrative cleanup of expired identity rows.
 *
 * Expired sessions and consumed/expired login transactions are normally removed
 * lazily by lookups; a deployment that wants bounded table growth runs
 * `dsh-platform admin session cleanup` on a schedule. The command is a dry run
 * unless `--confirm` is passed, and every applied run appends an audit row.
 *
 * @module @deepseek-ai/dsh-platform-services/admin/cleanup
 */

import type { IdentityConfig } from '../config.ts'
import { withIdentityStore } from '../identity/lookup.ts'

/** One cleanup request. */
export interface IdentityCleanupRequest {
  /** Identity configuration of the deployment. */
  readonly identity: IdentityConfig
  /** Rows whose lifetime ended at least this many days ago are prunable. */
  readonly retentionDays: number
  /** Apply the deletion; false only counts. */
  readonly confirm: boolean
}

/** Outcome of one cleanup invocation. */
export interface IdentityCleanupReport {
  /** ISO cutoff; rows ending before it are prunable. */
  readonly cutoff: string
  /** Sessions matched by the cleanup predicate. */
  readonly sessions: number
  /** Login transactions matched by the cleanup predicate. */
  readonly oauthStates: number
  /** Whether the rows were deleted. */
  readonly applied: boolean
}

/**
 * Count or delete expired identity rows.
 * @param request - retention window and apply flag.
 * @returns the matched/deleted counts.
 * @throws {Error} when the retention window is not a positive integer.
 */
export async function runIdentityCleanup(request: IdentityCleanupRequest): Promise<IdentityCleanupReport> {
  if (!Number.isInteger(request.retentionDays) || request.retentionDays < 1) {
    throw new Error('--retention-days must be a positive integer')
  }
  const cutoff = new Date(Date.now() - request.retentionDays * 24 * 60 * 60 * 1000).toISOString()
  return withIdentityStore(request.identity, (store) => {
    const counts = request.confirm ? store.pruneExpiredState(cutoff) : store.countPrunableState(cutoff)
    if (request.confirm) {
      store.appendAudit({
        action: 'admin.session.cleanup',
        outcome: 'success',
        detail: { cutoff, retentionDays: request.retentionDays, sessions: counts.sessions, oauthStates: counts.oauthStates },
      }, new Date().toISOString())
    }
    return { cutoff, sessions: counts.sessions, oauthStates: counts.oauthStates, applied: request.confirm }
  })
}
