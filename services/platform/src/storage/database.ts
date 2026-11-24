/**
 * Synchronous database facade shared by the identity store and its migrations.
 *
 * The platform's identity code performs short synchronous statements inside an
 * HTTP request. SQLite provides that natively; the PostgreSQL adapter preserves
 * the same call shape through a worker-thread bridge so no call site needs an
 * async rewrite.
 *
 * @module @deepseek-ai/dsh-platform-services/storage/database
 */

/** Values accepted as prepared-statement parameters. */
export type SqlValue = string | number | bigint | null | Uint8Array

/** One result row keyed by column name. */
export type SqlRow = Record<string, unknown>

/** One prepared statement. */
export interface SyncStatement {
  /**
   * Execute a statement that does not return rows.
   * @param params - positional parameters.
   * @returns the number of affected rows.
   */
  run(...params: readonly SqlValue[]): { changes: number }
  /**
   * Execute a statement and return its first row.
   * @param params - positional parameters.
   * @returns the row, or undefined when the statement produced none.
   */
  get(...params: readonly SqlValue[]): SqlRow | undefined
  /**
   * Execute a statement and return every row.
   * @param params - positional parameters.
   * @returns the result rows.
   */
  all(...params: readonly SqlValue[]): SqlRow[]
}

/** Database backend dialect; SQL that differs between backends is selected by it. */
export type SqlDialect = 'sqlite' | 'postgres'

/** Synchronous database handle. */
export interface SyncDatabase {
  /** Backend dialect. */
  readonly dialect: SqlDialect
  /**
   * Execute one or more statements without parameters.
   * @param sql - SQL text.
   */
  exec(sql: string): void
  /**
   * Prepare one statement.
   * @param sql - SQL text using `?` placeholders.
   * @returns the prepared statement.
   */
  prepare(sql: string): SyncStatement
  /** Release the handle and its worker. */
  close(): void
}
