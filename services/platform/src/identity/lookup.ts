/**
 * Read-only identity lookups for administrative commands.
 *
 * The identity service exposes session and CSRF resolution to the gateway; the
 * migration command additionally needs to map a stable W3 subject (or an
 * internal user id an operator read from the database) to the platform user that
 * owns a space. These helpers open the same database with the same migrations and
 * close it before returning, so a one-shot admin invocation never leaves a handle
 * behind.
 *
 * @module @deepseek-ai/dsh-platform-services/identity/lookup
 */

import type { IdentityConfig } from '../config.ts'
import type { PlatformUser } from '../contracts.ts'
import { toPlatformUser } from './security.ts'
import { IdentityStore } from './store.ts'
import { openIdentityDatabase } from '../storage/open.ts'

/**
 * Open the identity database, run one operation, and close it.
 *
 * Exposed for one-shot administrative commands that own a multi-statement change;
 * the identity service itself keeps one long-lived handle.
 * @param config - identity configuration naming the data directory.
 * @param lookup - operation to run against the open store.
 * @returns the operation result.
 */
export function withIdentityStore<T>(config: IdentityConfig, lookup: (store: IdentityStore) => T): T {
  const store = new IdentityStore(openIdentityDatabase(config), new Date().toISOString())
  try {
    return lookup(store)
  } finally {
    store.close()
  }
}

/**
 * Resolve the platform user whose stable W3 subject this is.
 * @param config - identity configuration.
 * @param subject - stable W3 subject (`uuid`/`sub`).
 * @returns the platform user, or undefined when no user has that subject.
 */
export function findPlatformUserBySubject(config: IdentityConfig, subject: string): PlatformUser | undefined {
  return withIdentityStore(config, (store) => {
    const row = store.findUserBySubject(subject)
    return row === undefined ? undefined : toPlatformUser(row)
  })
}

/**
 * Resolve the platform user by its internal DSH user id.
 * @param config - identity configuration.
 * @param userId - internal user id.
 * @returns the platform user, or undefined when no such user exists.
 */
export function findPlatformUserById(config: IdentityConfig, userId: string): PlatformUser | undefined {
  return withIdentityStore(config, (store) => {
    const row = store.findUserById(userId)
    return row === undefined ? undefined : toPlatformUser(row)
  })
}
