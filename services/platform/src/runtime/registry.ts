/**
 * SQLite registry of per-user runtime instances.
 *
 * One row per `(realm, user_id)`. The supervisor owns every state transition and
 * every `generation` increment; the gateway only reads the anonymous status view
 * the manager derives from this record.
 *
 * @module @deepseek-ai/dsh-platform-services/runtime/registry
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { RuntimeState } from '../contracts.ts'
import { migrateRuntimeRegistry } from './migrations.ts'

/** Whether a record should currently be running. */
export type RuntimeDesiredState = 'RUNNING' | 'STOPPED'

/** One persisted runtime instance, as the supervisor sees it. */
export interface RuntimeRecord {
  /** Stable row id (UUID). */
  readonly id: string
  /** Deployment realm the user belongs to. */
  readonly realm: string
  /** Internal user id; never a browser-supplied value. */
  readonly userId: string
  /** Opaque HMAC space key naming the user's directory and container. */
  readonly spaceKey: string
  /** Monotonic allocation generation; incremented on every start attempt. */
  readonly generation: number
  /** Lifecycle state; see {@link RuntimeState}. */
  readonly state: RuntimeState
  /** Whether the user still expects a running runtime. */
  readonly desiredState: RuntimeDesiredState
  /** Backend instance identifier (`proc-...` or the container name), when allocated. */
  readonly runtimeId: string | null
  /** Immutable image identity last launched, when the backend reports one. */
  readonly imageDigest: string | null
  /** Stable error code of the last failure, when the record is FAILED. */
  readonly lastErrorCode: string | null
  /** Epoch milliseconds of the last recorded user activity. */
  readonly lastActivityAt: number | null
  /** Epoch milliseconds of first allocation. */
  readonly createdAt: number
  /** Epoch milliseconds of the last registry write. */
  readonly updatedAt: number
}

/** Partial registry write; omitted fields keep their current value. */
export interface RuntimeRecordPatch {
  readonly generation?: number | undefined
  readonly state?: RuntimeState | undefined
  readonly desiredState?: RuntimeDesiredState | undefined
  readonly runtimeId?: string | null | undefined
  readonly imageDigest?: string | null | undefined
  readonly lastErrorCode?: string | null | undefined
  readonly lastActivityAt?: number | null | undefined
  readonly updatedAt?: number | undefined
}

/** Input for allocating one record. */
export interface RuntimeRecordInput {
  readonly realm: string
  readonly userId: string
  readonly spaceKey: string
  /** Epoch milliseconds used as `created_at` and `updated_at`. */
  readonly now: number
}

/** Every lifecycle state, used to validate persisted text. */
const RUNTIME_STATES: readonly RuntimeState[] = [
  'UNALLOCATED',
  'PROVISIONING',
  'STARTING',
  'READY',
  'STOPPING',
  'STOPPED',
  'FAILED',
]

/**
 * Read one required text column.
 * @param row - database row.
 * @param column - column name.
 * @returns the stored text.
 */
function readText(row: Record<string, unknown>, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') throw new Error(`runtime registry column ${column} is not text`)
  return value
}

/**
 * Read one nullable text column.
 * @param row - database row.
 * @param column - column name.
 * @returns the stored text, or null.
 */
function readNullableText(row: Record<string, unknown>, column: string): string | null {
  const value = row[column]
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`runtime registry column ${column} is not text`)
  return value
}

/**
 * Read one required integer column.
 * @param row - database row.
 * @param column - column name.
 * @returns the stored integer.
 */
function readInteger(row: Record<string, unknown>, column: string): number {
  const value = row[column]
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  throw new Error(`runtime registry column ${column} is not an integer`)
}

/**
 * Read one nullable integer column.
 * @param row - database row.
 * @param column - column name.
 * @returns the stored integer, or null.
 */
function readNullableInteger(row: Record<string, unknown>, column: string): number | null {
  if (row[column] === null) return null
  return readInteger(row, column)
}

/**
 * Validate one persisted lifecycle state.
 * @param value - stored text.
 * @returns the matching state.
 */
function parseState(value: string): RuntimeState {
  for (const state of RUNTIME_STATES) {
    if (state === value) return state
  }
  throw new Error(`runtime registry holds an unknown state ${JSON.stringify(value)}`)
}

/**
 * Validate one persisted desired state.
 * @param value - stored text.
 * @returns the matching desired state.
 */
function parseDesiredState(value: string): RuntimeDesiredState {
  if (value === 'RUNNING' || value === 'STOPPED') return value
  throw new Error(`runtime registry holds an unknown desired state ${JSON.stringify(value)}`)
}

/**
 * Pick a patch value, falling back when the patch omitted the field.
 * @param value - patch value, possibly undefined.
 * @param fallback - current value.
 * @returns the patch value or the fallback.
 */
function pick<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value
}

/** Convert one database row into a record. */
function toRecord(row: Record<string, unknown>): RuntimeRecord {
  return {
    id: readText(row, 'id'),
    realm: readText(row, 'realm'),
    userId: readText(row, 'user_id'),
    spaceKey: readText(row, 'space_key'),
    generation: readInteger(row, 'generation'),
    state: parseState(readText(row, 'state')),
    desiredState: parseDesiredState(readText(row, 'desired_state')),
    runtimeId: readNullableText(row, 'runtime_id'),
    imageDigest: readNullableText(row, 'image_digest'),
    lastErrorCode: readNullableText(row, 'last_error_code'),
    lastActivityAt: readNullableInteger(row, 'last_activity_at'),
    createdAt: readInteger(row, 'created_at'),
    updatedAt: readInteger(row, 'updated_at'),
  }
}

/** Versioned registry over one SQLite file. */
export class RuntimeRegistry {
  private readonly database: DatabaseSync
  private readonly now: () => number
  private closed = false

  /** @param database - open database with migrations applied; @param now - clock used for `updated_at`. */
  private constructor(database: DatabaseSync, now: () => number) {
    this.database = database
    this.now = now
  }

  /**
   * Open (creating when absent) the registry database and apply pending migrations.
   * @param file - absolute path of `runtime.sqlite`.
   * @param options - clock override used for `updated_at`.
   * @returns the open registry.
   */
  static open(file: string, options: { readonly now?: (() => number) | undefined } = {}): RuntimeRegistry {
    mkdirSync(dirname(file), { recursive: true })
    const database = new DatabaseSync(file)
    database.exec('PRAGMA journal_mode = WAL')
    database.exec('PRAGMA busy_timeout = 5000')
    database.exec('PRAGMA foreign_keys = OFF')
    migrateRuntimeRegistry(database)
    return new RuntimeRegistry(database, options.now ?? Date.now)
  }

  /**
   * Find one user's record.
   * @param realm - deployment realm.
   * @param userId - internal user id.
   * @returns the record, or undefined when the user was never allocated.
   */
  find(realm: string, userId: string): RuntimeRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM dsh_runtime_instances WHERE realm = ? AND user_id = ?')
      .get(realm, userId)
    return row === undefined ? undefined : toRecord(row)
  }

  /**
   * Find one record by its row id.
   * @param id - row id.
   * @returns the record, or undefined.
   */
  findById(id: string): RuntimeRecord | undefined {
    const row = this.database.prepare('SELECT * FROM dsh_runtime_instances WHERE id = ?').get(id)
    return row === undefined ? undefined : toRecord(row)
  }

  /**
   * Find one record by its backend instance id.
   * @param runtimeId - backend instance identifier.
   * @returns the record, or undefined when the backend is unknown.
   */
  findByRuntimeId(runtimeId: string): RuntimeRecord | undefined {
    const row = this.database.prepare('SELECT * FROM dsh_runtime_instances WHERE runtime_id = ?').get(runtimeId)
    return row === undefined ? undefined : toRecord(row)
  }

  /**
   * List every record, oldest allocation first.
   * @returns all records.
   */
  list(): RuntimeRecord[] {
    const rows = this.database
      .prepare('SELECT * FROM dsh_runtime_instances ORDER BY created_at ASC, id ASC')
      .all()
    return rows.map(row => toRecord(row))
  }

  /**
   * Allocate one record in UNALLOCATED state, generation zero.
   * @param input - realm, user id, space key, and creation time.
   * @returns the created record.
   * @throws when the user or space key already has a record.
   */
  create(input: RuntimeRecordInput): RuntimeRecord {
    const id = randomUUID()
    this.database
      .prepare(
        `INSERT INTO dsh_runtime_instances
          (id, realm, user_id, space_key, generation, state, desired_state, runtime_id, image_digest, last_error_code, last_activity_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, 'UNALLOCATED', 'RUNNING', NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(id, input.realm, input.userId, input.spaceKey, input.now, input.now)
    const created = this.findById(id)
    if (created === undefined) throw new Error('runtime registry insert did not persist')
    return created
  }

  /**
   * Apply one partial update, refreshing `updated_at`.
   * @param id - row id.
   * @param patch - fields to replace; omitted fields keep their current value.
   * @returns the updated record.
   * @throws when the row no longer exists.
   */
  update(id: string, patch: RuntimeRecordPatch): RuntimeRecord {
    const current = this.findById(id)
    if (current === undefined) throw new Error('runtime registry row disappeared during update')
    const next: RuntimeRecord = {
      ...current,
      generation: pick(patch.generation, current.generation),
      state: pick(patch.state, current.state),
      desiredState: pick(patch.desiredState, current.desiredState),
      runtimeId: pick(patch.runtimeId, current.runtimeId),
      imageDigest: pick(patch.imageDigest, current.imageDigest),
      lastErrorCode: pick(patch.lastErrorCode, current.lastErrorCode),
      lastActivityAt: pick(patch.lastActivityAt, current.lastActivityAt),
      updatedAt: pick(patch.updatedAt, this.now()),
    }
    this.database
      .prepare(
        `UPDATE dsh_runtime_instances SET
          generation = ?, state = ?, desired_state = ?, runtime_id = ?, image_digest = ?,
          last_error_code = ?, last_activity_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.generation,
        next.state,
        next.desiredState,
        next.runtimeId,
        next.imageDigest,
        next.lastErrorCode,
        next.lastActivityAt,
        next.updatedAt,
        next.id,
      )
    return next
  }

  /**
   * Record user activity for idle reclamation.
   * @param id - row id.
   * @param at - epoch milliseconds of the activity.
   * @returns the updated record, or undefined when the row no longer exists.
   */
  touch(id: string, at: number): RuntimeRecord | undefined {
    if (this.findById(id) === undefined) return undefined
    return this.update(id, { lastActivityAt: at, updatedAt: at })
  }

  /** Release the database handle; further calls are refused. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }

  /** @returns whether {@link RuntimeRegistry.close} ran. */
  get isClosed(): boolean {
    return this.closed
  }
}
