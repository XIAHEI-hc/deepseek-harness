/**
 * Synchronous PostgreSQL facade over the `pg` driver.
 *
 * The identity store issues short blocking statements from synchronous code, so
 * this adapter runs a dedicated worker thread that owns the async `pg` pool and
 * answers each statement through a SharedArrayBuffer. The main thread blocks in
 * `Atomics.wait` only for the duration of one statement, mirroring SQLite's
 * synchronous call shape. Statements are serialized because the main thread can
 * issue exactly one at a time.
 *
 * @module @deepseek-ai/dsh-platform-services/storage/postgres-database
 */

import { Worker } from 'node:worker_threads'
import type { SqlDialect, SqlValue, SyncDatabase, SyncStatement } from './database.ts'

/** Bytes reserved for the request/response JSON payload. */
const PAYLOAD_BYTES = 32 * 1024 * 1024
/** Milliseconds a statement may take before the bridge fails the call. */
const CALL_TIMEOUT_MS = 30_000
/** Milliseconds allowed for the worker to connect its pool. */
const START_TIMEOUT_MS = 15_000

/** Translating `?` placeholders to PostgreSQL's `$n`. */
function toPostgresSql(sql: string): string {
  let index = 0
  let result = ''
  for (const character of sql) {
    if (character === '?') {
      index += 1
      result += `$${String(index)}`
    } else {
      result += character
    }
  }
  return result
}

/** @inheritDoc */
class PostgresStatement implements SyncStatement {
  private readonly database: PostgresDatabase
  private readonly sql: string

  /** @param database - owning bridge; @param sql - statement text with `?`. */
  constructor(database: PostgresDatabase, sql: string) {
    this.database = database
    this.sql = sql
  }

  /** @inheritDoc */
  run(...params: readonly SqlValue[]): { changes: number } {
    return { changes: this.database.execute(this.sql, params).changes }
  }

  /** @inheritDoc */
  get(...params: readonly SqlValue[]): Record<string, unknown> | undefined {
    return this.database.execute(this.sql, params).rows[0]
  }

  /** @inheritDoc */
  all(...params: readonly SqlValue[]): Record<string, unknown>[] {
    return this.database.execute(this.sql, params).rows
  }
}

/** One bridge call result. */
interface BridgeResult {
  rows: Record<string, unknown>[]
  changes: number
}

/** Wire response from the worker. */
interface WorkerResponse {
  ok: boolean
  rows?: Record<string, unknown>[]
  changes?: number
  error?: string
}

/** @inheritDoc */
export class PostgresDatabase implements SyncDatabase {
  readonly dialect: SqlDialect = 'postgres'
  private readonly control: Int32Array
  private readonly payload: Uint8Array
  private readonly worker: Worker
  private closed = false

  /**
   * Open the bridge and wait until the worker's pool is ready.
   * @param connectionString - PostgreSQL connection URL.
   * @throws when the bridge or the initial connection fails.
   */
  constructor(connectionString: string) {
    const buffer = new SharedArrayBuffer(PAYLOAD_BYTES + 16)
    this.control = new Int32Array(buffer, 0, 4)
    this.payload = new Uint8Array(buffer, 16)
    this.worker = new Worker(new URL('./postgres-worker.mjs', import.meta.url), {
      workerData: { connectionString, buffer },
    })
    this.worker.unref()
    const deadline = Date.now() + START_TIMEOUT_MS
    let readiness = Atomics.load(this.control, 1)
    while (readiness === 0) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('postgres bridge did not become ready')
      Atomics.wait(this.control, 1, 0, remaining)
      readiness = Atomics.load(this.control, 1)
    }
    if (readiness === 2) {
      const length = new DataView(this.payload.buffer, this.payload.byteOffset).getUint32(0, true)
      const message = Buffer.from(this.payload.subarray(4, 4 + length)).toString('utf8')
      throw new Error(message === '' ? 'postgres bridge failed to connect' : message)
    }
  }

  /**
   * Run one SQL statement through the bridge.
   * @param sql - statement text with `?` placeholders.
   * @param params - positional parameters.
   * @returns the rows and affected-row count.
   */
  execute(sql: string, params: readonly SqlValue[]): BridgeResult {
    if (this.closed) throw new Error('postgres database is closed')
    if (sql.trimStart().toUpperCase().startsWith('PRAGMA ')) return { rows: [], changes: 0 }
    const normalized = sql.replace(/^\s*BEGIN\s+IMMEDIATE\b/i, 'BEGIN')
    const request = JSON.stringify({ sql: toPostgresSql(normalized), params })
    const encoded = Buffer.from(request, 'utf8')
    if (encoded.length + 4 > this.payload.length) throw new Error('postgres bridge payload is too large')
    const view = new DataView(this.payload.buffer, this.payload.byteOffset)
    view.setUint32(0, encoded.length, true)
    this.payload.set(encoded, 4)
    Atomics.store(this.control, 0, 1)
    Atomics.notify(this.control, 0)
    const outcome = Atomics.wait(this.control, 0, 1, CALL_TIMEOUT_MS)
    if (outcome === 'timed-out') throw new Error('postgres statement timed out')
    const state = Atomics.load(this.control, 0)
    const length = view.getUint32(0, true)
    const text = Buffer.from(this.payload.subarray(4, 4 + length)).toString('utf8')
    Atomics.store(this.control, 0, 0)
    Atomics.notify(this.control, 0)
    if (state === 3) {
      const failure = JSON.parse(text) as WorkerResponse
      throw new Error(failure.error ?? 'postgres statement failed')
    }
    const response = JSON.parse(text) as WorkerResponse
    return { rows: response.rows ?? [], changes: response.changes ?? 0 }
  }

  /** @inheritDoc */
  exec(sql: string): void {
    this.execute(sql, [])
  }

  /** @inheritDoc */
  prepare(sql: string): SyncStatement {
    return new PostgresStatement(this, sql)
  }

  /** @inheritDoc */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.worker.terminate().catch(() => {
      // Terminating an already stopped worker must not mask the close path.
    })
  }
}
