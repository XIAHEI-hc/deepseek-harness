/**
 * Versioned schema migrations for the runtime registry database.
 *
 * The registry lives in its own SQLite file (`runtime.sqlite`) beside the
 * platform data directory, so identity and runtime migrations never depend on
 * each other. Applied versions are recorded in `schema_migrations`; a version is
 * applied at most once and every migration runs in one transaction.
 *
 * @module @deepseek-ai/dsh-platform-services/runtime/migrations
 */

import type { DatabaseSync } from 'node:sqlite'

/** One ordered registry migration. */
export interface RuntimeSchemaMigration {
  /** Monotonic schema version; also the primary key of `schema_migrations`. */
  readonly version: number
  /** Human-readable migration name stored beside the version. */
  readonly name: string
  /** DDL statements applied in order inside one transaction. */
  readonly statements: readonly string[]
}

/** Current registry schema version. */
export const RUNTIME_SCHEMA_VERSION = 1

/**
 * Ordered registry migrations, per the development pack's `dsh_runtime_instances`
 * table. Timestamps are epoch milliseconds; the table stays in one SQLite file.
 */
export const RUNTIME_SCHEMA_MIGRATIONS: readonly RuntimeSchemaMigration[] = [
  {
    version: 1,
    name: 'create_runtime_instances',
    statements: [
      `CREATE TABLE IF NOT EXISTS dsh_runtime_instances (
        id TEXT PRIMARY KEY,
        realm TEXT NOT NULL,
        user_id TEXT NOT NULL,
        space_key TEXT NOT NULL UNIQUE,
        generation INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL,
        desired_state TEXT NOT NULL,
        runtime_id TEXT,
        image_digest TEXT,
        last_error_code TEXT,
        last_activity_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(realm, user_id)
      )`,
      'CREATE INDEX IF NOT EXISTS idx_dsh_runtime_instances_state ON dsh_runtime_instances (state)',
      'CREATE INDEX IF NOT EXISTS idx_dsh_runtime_instances_runtime_id ON dsh_runtime_instances (runtime_id)',
    ],
  },
]

/**
 * Apply every pending registry migration and record it.
 * @param database - open registry database.
 * @returns the schema version after migration.
 * @throws when a migration statement fails; the failing version is rolled back.
 */
export function migrateRuntimeRegistry(database: DatabaseSync): number {
  database.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)',
  )
  let applied = 0
  const row = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()
  if (row !== undefined && typeof row.version === 'number') applied = row.version
  for (const migration of RUNTIME_SCHEMA_MIGRATIONS) {
    if (migration.version <= applied) continue
    database.exec('BEGIN')
    try {
      for (const statement of migration.statements) database.exec(statement)
      database
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, Date.now())
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    applied = migration.version
  }
  return applied
}
