/**
 * Open the identity metadata database named by the deployment configuration.
 *
 * @module @deepseek-ai/dsh-platform-services/storage/open
 */

import { join } from 'node:path'
import type { IdentityConfig } from '../config.ts'
import type { SyncDatabase } from './database.ts'
import { PostgresDatabase } from './postgres-database.ts'
import { SqliteDatabase } from './sqlite-database.ts'

/**
 * Open the configured identity database.
 * @param config - identity configuration.
 * @returns the open synchronous database handle.
 */
export function openIdentityDatabase(config: IdentityConfig): SyncDatabase {
  if (config.storage.kind === 'postgres') return new PostgresDatabase(config.storage.postgresUrl)
  return new SqliteDatabase(join(config.dataDir, 'identity.sqlite'))
}
