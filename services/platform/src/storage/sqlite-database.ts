/**
 * SQLite implementation of the synchronous database facade.
 *
 * @module @deepseek-ai/dsh-platform-services/storage/sqlite-database
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SqlDialect, SqlValue, SyncDatabase, SyncStatement } from './database.ts'

/** @inheritDoc */
class SqliteStatement implements SyncStatement {
  private readonly statement: ReturnType<DatabaseSync['prepare']>

  /** @param statement - underlying node:sqlite statement. */
  constructor(statement: ReturnType<DatabaseSync['prepare']>) {
    this.statement = statement
  }

  /** @inheritDoc */
  run(...params: readonly SqlValue[]): { changes: number } {
    const result = this.statement.run(...params)
    return { changes: Number(result.changes) }
  }

  /** @inheritDoc */
  get(...params: readonly SqlValue[]): Record<string, unknown> | undefined {
    return this.statement.get(...params)
  }

  /** @inheritDoc */
  all(...params: readonly SqlValue[]): Record<string, unknown>[] {
    return this.statement.all(...params)
  }
}

/** @inheritDoc */
export class SqliteDatabase implements SyncDatabase {
  readonly dialect: SqlDialect = 'sqlite'
  private readonly database: DatabaseSync

  /**
   * Open a SQLite database and create its parent directory.
   * @param databasePath - absolute database file path.
   */
  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.database = new DatabaseSync(databasePath)
  }

  /** @inheritDoc */
  exec(sql: string): void {
    this.database.exec(sql)
  }

  /** @inheritDoc */
  prepare(sql: string): SyncStatement {
    return new SqliteStatement(this.database.prepare(sql))
  }

  /** @inheritDoc */
  close(): void {
    this.database.close()
  }
}
