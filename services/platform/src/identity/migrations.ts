/**
 * Versioned DDL migrations for the identity SQLite database.
 *
 * The identity database never uses an ORM `create_all`: every schema change is a
 * numbered migration recorded in `schema_migrations` and applied inside its own
 * transaction, so an existing deployment only gains the migrations it lacks.
 *
 * @module @deepseek-ai/dsh-platform-services/identity/migrations
 */

import type { SyncDatabase } from '../storage/database.ts'

/** One numbered identity schema migration. */
export interface IdentityMigration {
  /** Monotonic migration number; applied versions are never rewritten. */
  readonly version: number
  /** DDL executed exactly once inside the migration transaction. */
  readonly statements: string
}

/** Identity schema version 1: users, sessions, and OAuth login transactions. */
export const IDENTITY_MIGRATIONS: readonly IdentityMigration[] = [
  {
    version: 1,
    statements: `
      CREATE TABLE dsh_users (
        id TEXT PRIMARY KEY,
        external_subject TEXT NOT NULL UNIQUE,
        uid TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        email TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        permission_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT NOT NULL
      );
      CREATE INDEX idx_dsh_users_subject ON dsh_users(external_subject);
      CREATE INDEX idx_dsh_users_uid ON dsh_users(uid);

      CREATE TABLE dsh_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES dsh_users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        csrf_token_hash TEXT NOT NULL,
        permission_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        absolute_expires_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX idx_dsh_sessions_token_hash ON dsh_sessions(token_hash);
      CREATE INDEX idx_dsh_sessions_user_id ON dsh_sessions(user_id);
      CREATE INDEX idx_dsh_sessions_expires_at ON dsh_sessions(expires_at);

      CREATE TABLE dsh_oauth_states (
        id TEXT PRIMARY KEY,
        state_hash TEXT NOT NULL UNIQUE,
        browser_nonce_hash TEXT NOT NULL,
        return_to TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE INDEX idx_dsh_oauth_states_state_hash ON dsh_oauth_states(state_hash);
      CREATE INDEX idx_dsh_oauth_states_expires_at ON dsh_oauth_states(expires_at);
    `,
  },
  {
    version: 2,
    statements: `
      CREATE TABLE dsh_audit_events (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        user_id TEXT,
        subject TEXT,
        client_address TEXT,
        detail TEXT
      );
      CREATE INDEX idx_dsh_audit_events_at ON dsh_audit_events(at);
      CREATE INDEX idx_dsh_audit_events_user_id ON dsh_audit_events(user_id);
    `,
  },
]

/**
 * Apply every migration the database does not record yet.
 * @param database - open metadata database handle.
 * @param appliedAt - ISO timestamp recorded for migrations applied by this call.
 * @returns the migration versions this call applied.
 */
export function migrateIdentityDatabase(
  database: SyncDatabase,
  appliedAt: string,
): readonly number[] {
  database.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  )
  const applied = new Set<number>()
  for (const row of database.prepare('SELECT version FROM schema_migrations').all()) {
    const version = row['version']
    if (typeof version === 'number') applied.add(version)
    else if (typeof version === 'bigint') applied.add(Number(version))
    else throw new Error('identity schema_migrations.version is not an integer')
  }
  const appliedNow: number[] = []
  for (const migration of IDENTITY_MIGRATIONS) {
    if (applied.has(migration.version)) continue
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(migration.statements)
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, appliedAt)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    appliedNow.push(migration.version)
  }
  return appliedNow
}
