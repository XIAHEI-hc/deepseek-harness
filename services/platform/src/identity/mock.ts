/**
 * Development-only Mock identity.
 *
 * The identity is read exclusively from server-side configuration; no browser
 * query parameter or header can select a different account, and the factory
 * refuses Mock mode in production before this module is reachable.
 *
 * @module @deepseek-ai/dsh-platform-services/identity/mock
 */

import type { IdentityConfig } from '../config.ts'
import { IdentityError } from './errors.ts'
import { syncUser } from './security.ts'
import type { IdentityStore, UserRow } from './store.ts'

/**
 * Create or refresh the single configured Mock identity.
 * @param config - identity configuration carrying the Mock identity.
 * @param store - identity store.
 * @param nowMs - current epoch milliseconds.
 * @returns the persisted Mock user row.
 * @throws {IdentityError} `mock-disabled` when Mock authentication is not allowed.
 */
export function syncMockUser(
  config: IdentityConfig,
  store: IdentityStore,
  nowMs: number,
): UserRow {
  if (config.mode !== 'mock' || config.appEnv === 'production') {
    throw new IdentityError('mock-disabled', 403, 'Mock authentication is disabled')
  }
  return syncUser(
    store,
    {
      subject: config.mock.subject,
      uid: config.mock.uid,
      displayName: config.mock.displayName,
      email: config.mock.email === '' ? null : config.mock.email,
    },
    nowMs,
  )
}
