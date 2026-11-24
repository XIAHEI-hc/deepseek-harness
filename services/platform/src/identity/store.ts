/**
 * SQLite persistence for the identity service: users, sessions, and OAuth login
 * transactions.
 *
 * Timestamps are stored as ISO-8601 UTC text so lexical comparison is equivalent
 * to chronological comparison; epoch-millisecond conversion belongs to the
 * callers. The store performs no policy decisions: every lifetime, revocation,
 * and permission rule is applied by the security helpers or the HTTP surface.
 *
 * @module @deepseek-ai/dsh-platform-services/identity/store
 */

import { randomUUID } from 'node:crypto'
import { migrateIdentityDatabase } from './migrations.ts'
import type { SqlRow, SyncDatabase } from '../storage/database.ts'

/** One audit event the identity surface appends. */
export interface AuditEventInput {
  /** Stable action name such as `login` or `admin.user.disable`. */
  readonly action: string
  /** Stable outcome name such as `success`, `denied`, or `error`. */
  readonly outcome: string
  /** Affected platform user, when the event resolves one. */
  readonly userId?: string | undefined
  /** Affected W3 subject, when the event resolves one. */
  readonly subject?: string | undefined
  /** Transport-observed client address. */
  readonly clientAddress?: string | undefined
  /** Additional JSON-safe facts for operators. */
  readonly detail?: Readonly<Record<string, unknown>> | undefined
}

/** One row of `dsh_audit_events`. */
export interface AuditRow {
  /** Audit row id. */
  readonly id: string
  /** ISO-8601 event timestamp. */
  readonly at: string
  /** Stable action name. */
  readonly action: string
  /** Stable outcome name. */
  readonly outcome: string
  /** Affected user id, or null. */
  readonly userId: string | null
  /** Affected W3 subject, or null. */
  readonly subject: string | null
  /** Client address, or null. */
  readonly clientAddress: string | null
  /** Additional facts, or null. */
  readonly detail: Record<string, unknown> | null
}

/**
 * Read one audit row from its SQLite representation.
 * @param row - raw `dsh_audit_events` row.
 * @returns the typed audit row.
 */
function toAuditRow(row: SqlRow): AuditRow {
  const detail = row['detail']
  return {
    id: textOf(row['id']),
    at: textOf(row['at']),
    action: textOf(row['action']),
    outcome: textOf(row['outcome']),
    userId: nullableTextOf(row['user_id']),
    subject: nullableTextOf(row['subject']),
    clientAddress: nullableTextOf(row['client_address']),
    detail: detail === null ? null : JSON.parse(textOf(detail)) as Record<string, unknown>,
  }
}

/**
 * Require a text SQLite value.
 * @param value - raw cell.
 * @returns the string.
 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  throw new Error('identity audit cell is not text')
}

/**
 * Read a numeric SQLite count.
 * @param value - raw cell.
 * @returns the integer count.
 */
function integerOf(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  throw new Error('identity count cell is not an integer')
}

/**
 * Read a nullable text SQLite value.
 * @param value - raw cell.
 * @returns the string, or null.
 */
function nullableTextOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** One row of `dsh_users`. */
export interface UserRow {
  /** Internal DSH user id (UUID); the primary key the gateway routes by. */
  readonly id: string
  /** Stable W3 subject (`uuid`, falling back to `sub`). */
  readonly subject: string
  /** W3 account identifier. */
  readonly uid: string
  /** Display name shown in the native DSH sidebar. */
  readonly displayName: string
  /** W3 email address, or null when W3 returned none. */
  readonly email: string | null
  /** `active` or `disabled`; any other value is treated as inactive. */
  readonly status: string
  /** Permission version a new session is minted with. */
  readonly permissionVersion: number
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string
  /** ISO-8601 timestamp of the last profile refresh. */
  readonly updatedAt: string
  /** ISO-8601 timestamp of the last successful login. */
  readonly lastLoginAt: string
}

/** One row of `dsh_sessions`. */
export interface SessionRow {
  /** Session id (UUID). */
  readonly id: string
  /** Owning user id. */
  readonly userId: string
  /** SHA-256 hex of the raw session cookie token; the raw token is never stored. */
  readonly tokenHash: string
  /** SHA-256 hex of the raw CSRF token. */
  readonly csrfTokenHash: string
  /** Permission version minted into this session. */
  readonly permissionVersion: number
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string
  /** ISO-8601 timestamp of the last activity refresh. */
  readonly lastSeenAt: string
  /** ISO-8601 idle expiry, refreshed by activity. */
  readonly expiresAt: string
  /** ISO-8601 absolute expiry, never moved. */
  readonly absoluteExpiresAt: string
  /** ISO-8601 revocation timestamp, or null while the session is live. */
  readonly revokedAt: string | null
}

/** One session joined with its owning user. */
export interface SessionWithUser {
  /** The session row. */
  readonly session: SessionRow
  /** The user row the session was minted for. */
  readonly user: UserRow
}

/** One row of `dsh_oauth_states`; the raw state and nonce are never stored. */
export interface LoginStateRow {
  /** Login transaction id (UUID). */
  readonly id: string
  /** SHA-256 hex of the raw OAuth state parameter. */
  readonly stateHash: string
  /** SHA-256 hex of the raw browser-binding nonce cookie. */
  readonly browserNonceHash: string
  /** Sanitized same-site path the callback redirects to. */
  readonly returnTo: string
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string
  /** ISO-8601 expiry of the login transaction. */
  readonly expiresAt: string
  /** ISO-8601 consumption timestamp, or null while unused. */
  readonly consumedAt: string | null
}

/**
 * Read one required text column.
 * @param row - SQLite result row.
 * @param column - column name.
 * @returns the text value.
 */
function readText(row: SqlRow, column: string): string {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`identity database column ${column} is not text`)
}

/**
 * Read one nullable text column.
 * @param row - SQLite result row.
 * @param column - column name.
 * @returns the text value, or null.
 */
function readNullableText(row: SqlRow, column: string): string | null {
  const value = row[column]
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  throw new Error(`identity database column ${column} is not text`)
}

/**
 * Read one required integer column.
 * @param row - SQLite result row.
 * @param column - column name.
 * @returns the integer value.
 */
function readInteger(row: SqlRow, column: string): number {
  const value = row[column]
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  throw new Error(`identity database column ${column} is not an integer`)
}

/**
 * Map a `dsh_users` row.
 * @param row - SQLite result row with the `dsh_users` columns.
 * @returns the typed user row.
 */
function toUserRow(row: SqlRow): UserRow {
  return {
    id: readText(row, 'id'),
    subject: readText(row, 'external_subject'),
    uid: readText(row, 'uid'),
    displayName: readText(row, 'display_name'),
    email: readNullableText(row, 'email'),
    status: readText(row, 'status'),
    permissionVersion: readInteger(row, 'permission_version'),
    createdAt: readText(row, 'created_at'),
    updatedAt: readText(row, 'updated_at'),
    lastLoginAt: readText(row, 'last_login_at'),
  }
}

/**
 * Map a `dsh_sessions` row.
 * @param row - SQLite result row with the `dsh_sessions` columns.
 * @returns the typed session row.
 */
function toSessionRow(row: SqlRow): SessionRow {
  return {
    id: readText(row, 'id'),
    userId: readText(row, 'user_id'),
    tokenHash: readText(row, 'token_hash'),
    csrfTokenHash: readText(row, 'csrf_token_hash'),
    permissionVersion: readInteger(row, 'permission_version'),
    createdAt: readText(row, 'created_at'),
    lastSeenAt: readText(row, 'last_seen_at'),
    expiresAt: readText(row, 'expires_at'),
    absoluteExpiresAt: readText(row, 'absolute_expires_at'),
    revokedAt: readNullableText(row, 'revoked_at'),
  }
}

const SESSION_WITH_USER_SELECT = `
  SELECT
    s.id AS session_id,
    s.user_id AS session_user_id,
    s.token_hash,
    s.csrf_token_hash,
    s.permission_version AS session_permission_version,
    s.created_at AS session_created_at,
    s.last_seen_at,
    s.expires_at,
    s.absolute_expires_at,
    s.revoked_at,
    u.id AS user_id,
    u.external_subject,
    u.uid AS user_uid,
    u.display_name,
    u.email,
    u.status,
    u.permission_version AS user_permission_version,
    u.created_at AS user_created_at,
    u.updated_at AS user_updated_at,
    u.last_login_at
  FROM dsh_sessions s
  JOIN dsh_users u ON u.id = s.user_id
`

/**
 * Map one joined session/user row.
 * @param row - SQLite result row from {@link SESSION_WITH_USER_SELECT}.
 * @returns the typed session and user rows.
 */
function toSessionWithUser(row: SqlRow): SessionWithUser {
  return {
    session: {
      id: readText(row, 'session_id'),
      userId: readText(row, 'session_user_id'),
      tokenHash: readText(row, 'token_hash'),
      csrfTokenHash: readText(row, 'csrf_token_hash'),
      permissionVersion: readInteger(row, 'session_permission_version'),
      createdAt: readText(row, 'session_created_at'),
      lastSeenAt: readText(row, 'last_seen_at'),
      expiresAt: readText(row, 'expires_at'),
      absoluteExpiresAt: readText(row, 'absolute_expires_at'),
      revokedAt: readNullableText(row, 'revoked_at'),
    },
    user: {
      id: readText(row, 'user_id'),
      subject: readText(row, 'external_subject'),
      uid: readText(row, 'user_uid'),
      displayName: readText(row, 'display_name'),
      email: readNullableText(row, 'email'),
      status: readText(row, 'status'),
      permissionVersion: readInteger(row, 'user_permission_version'),
      createdAt: readText(row, 'user_created_at'),
      updatedAt: readText(row, 'user_updated_at'),
      lastLoginAt: readText(row, 'last_login_at'),
    },
  }
}

/**
 * Identity SQLite store.
 *
 * The connection is private to this service instance; every read and write is a
 * single synchronous statement or an explicit `BEGIN IMMEDIATE` transaction, so
 * concurrent callers cannot observe a half-written login or session.
 */
export class IdentityStore {
  /** Open metadata database handle. */
  private readonly database: SyncDatabase
  /** Whether {@link close} already ran. */
  private closed = false

  /**
   * Open the identity database and apply pending migrations.
   * @param database - opened metadata database; SQLite uses WAL and PostgreSQL keeps its own isolation.
   * @param appliedAt - ISO timestamp recorded for migrations applied on this open.
   * @throws when a migration fails; the database is closed on failure.
   */
  constructor(database: SyncDatabase, appliedAt: string) {
    this.database = database
    try {
      this.database.exec('PRAGMA journal_mode = WAL')
      this.database.exec('PRAGMA foreign_keys = ON')
      this.database.exec('PRAGMA busy_timeout = 5000')
      migrateIdentityDatabase(this.database, appliedAt)
    } catch (error) {
      this.database.close()
      throw error
    }
  }

  /**
   * Run statements inside one exclusive transaction.
   * @param action - statements to execute; any throw rolls the transaction back.
   * @returns the value the action returned.
   */
  transaction<T>(action: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Insert one pending OAuth login transaction.
   * @param state - login transaction row; `consumedAt` must be null.
   */
  insertLoginState(state: LoginStateRow): void {
    this.database
      .prepare(
        `INSERT INTO dsh_oauth_states
          (id, state_hash, browser_nonce_hash, return_to, created_at, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        state.id,
        state.stateHash,
        state.browserNonceHash,
        state.returnTo,
        state.createdAt,
        state.expiresAt,
        state.consumedAt,
      )
  }

  /**
   * Atomically consume one login transaction bound to the browser nonce.
   * @param stateHash - SHA-256 hex of the raw state parameter.
   * @param browserNonceHash - SHA-256 hex of the browser nonce cookie.
   * @param nowIso - current time as ISO-8601 text.
   * @returns the consumed row, or undefined when unknown, expired, already used, or bound to another nonce.
   */
  consumeLoginState(
    stateHash: string,
    browserNonceHash: string,
    nowIso: string,
  ): LoginStateRow | undefined {
    const row = this.database
      .prepare(
        `UPDATE dsh_oauth_states
         SET consumed_at = ?
         WHERE state_hash = ? AND browser_nonce_hash = ? AND consumed_at IS NULL AND expires_at > ?
         RETURNING id, state_hash, browser_nonce_hash, return_to, created_at, expires_at, consumed_at`,
      )
      .get(nowIso, stateHash, browserNonceHash, nowIso)
    if (row === undefined) return undefined
    return {
      id: readText(row, 'id'),
      stateHash: readText(row, 'state_hash'),
      browserNonceHash: readText(row, 'browser_nonce_hash'),
      returnTo: readText(row, 'return_to'),
      createdAt: readText(row, 'created_at'),
      expiresAt: readText(row, 'expires_at'),
      consumedAt: readNullableText(row, 'consumed_at'),
    }
  }

  /**
   * Find a user by stable W3 subject.
   * @param subject - stable subject value.
   * @returns the user row, or undefined when unknown.
   */
  findUserBySubject(subject: string): UserRow | undefined {
    const row = this.database.prepare('SELECT * FROM dsh_users WHERE external_subject = ?').get(subject)
    return row === undefined ? undefined : toUserRow(row)
  }

  /**
   * Find a user by W3 account identifier.
   * @param uid - W3 account identifier.
   * @returns the user row, or undefined when unknown.
   */
  findUserByUid(uid: string): UserRow | undefined {
    const row = this.database.prepare('SELECT * FROM dsh_users WHERE uid = ?').get(uid)
    return row === undefined ? undefined : toUserRow(row)
  }

  /**
   * Find a user by internal DSH user id.
   * @param id - internal user id from `dsh_users.id`.
   * @returns the user row, or undefined when unknown.
   */
  findUserById(id: string): UserRow | undefined {
    const row = this.database.prepare('SELECT * FROM dsh_users WHERE id = ?').get(id)
    return row === undefined ? undefined : toUserRow(row)
  }

  /**
   * Insert one new user.
   * @param user - complete user row.
   */
  insertUser(user: UserRow): void {
    this.database
      .prepare(
        `INSERT INTO dsh_users
          (id, external_subject, uid, display_name, email, status, permission_version, created_at, updated_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        user.id,
        user.subject,
        user.uid,
        user.displayName,
        user.email,
        user.status,
        user.permissionVersion,
        user.createdAt,
        user.updatedAt,
        user.lastLoginAt,
      )
  }

  /**
   * Persist the profile facts refreshed on login.
   * @param user - user row carrying the new profile values and timestamps.
   */
  updateUserLogin(user: UserRow): void {
    this.database
      .prepare(
        `UPDATE dsh_users
         SET uid = ?, display_name = ?, email = ?, updated_at = ?, last_login_at = ?
         WHERE id = ?`,
      )
      .run(user.uid, user.displayName, user.email, user.updatedAt, user.lastLoginAt, user.id)
  }

  /**
   * Find a live-or-revoked session by its token hash, joined with its user.
   * @param tokenHash - SHA-256 hex of the raw session cookie token.
   * @returns the session and user rows, or undefined when the token is unknown.
   */
  findSessionByTokenHash(tokenHash: string): SessionWithUser | undefined {
    const row = this.database
      .prepare(`${SESSION_WITH_USER_SELECT} WHERE s.token_hash = ?`)
      .get(tokenHash)
    return row === undefined ? undefined : toSessionWithUser(row)
  }

  /**
   * Report whether a user still has one live browser session.
   * @param userId - owning internal user id.
   * @param atIso - current ISO instant.
   * @returns true when at least one session is unrevoked and unexpired.
   */
  hasLiveSession(userId: string, atIso: string): boolean {
    const row = this.database
      .prepare(
        `SELECT 1 AS live FROM dsh_sessions
         WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? AND absolute_expires_at > ?
         LIMIT 1`,
      )
      .get(userId, atIso, atIso)
    return row !== undefined
  }

  /**
   * Find one session by id.
   * @param id - session id.
   * @returns the session row, or undefined when unknown.
   */
  findSessionById(id: string): SessionRow | undefined {
    const row = this.database.prepare('SELECT * FROM dsh_sessions WHERE id = ?').get(id)
    return row === undefined ? undefined : toSessionRow(row)
  }

  /**
   * Insert one new session.
   * @param session - complete session row; `revokedAt` must be null.
   */
  insertSession(session: SessionRow): void {
    this.database
      .prepare(
        `INSERT INTO dsh_sessions
          (id, user_id, token_hash, csrf_token_hash, permission_version, created_at, last_seen_at, expires_at, absolute_expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.userId,
        session.tokenHash,
        session.csrfTokenHash,
        session.permissionVersion,
        session.createdAt,
        session.lastSeenAt,
        session.expiresAt,
        session.absoluteExpiresAt,
        session.revokedAt,
      )
  }

  /**
   * Refresh the activity timestamps of one session.
   * @param id - session id.
   * @param lastSeenAtIso - new last-activity ISO timestamp.
   * @param expiresAtIso - new idle-expiry ISO timestamp.
   */
  updateSessionActivity(id: string, lastSeenAtIso: string, expiresAtIso: string): void {
    this.database
      .prepare('UPDATE dsh_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .run(lastSeenAtIso, expiresAtIso, id)
  }

  /**
   * Revoke one session if it is still live.
   * @param id - session id.
   * @param revokedAtIso - revocation ISO timestamp.
   */
  revokeSession(id: string, revokedAtIso: string): void {
    this.database
      .prepare('UPDATE dsh_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(revokedAtIso, id)
  }

  /**
   * Revoke every live session of one user.
   * @param userId - owning user id.
   * @param revokedAtIso - revocation ISO timestamp.
   * @returns the number of sessions revoked by this call.
   */
  revokeUserSessions(userId: string, revokedAtIso: string): number {
    const result = this.database
      .prepare('UPDATE dsh_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(revokedAtIso, userId)
    return Number(result.changes)
  }

  /**
   * Set one user's account status.
   * @param id - internal user id.
   * @param status - new `dsh_users.status` value.
   * @param updatedAtIso - update timestamp.
   */
  setUserStatus(id: string, status: string, updatedAtIso: string): void {
    this.database
      .prepare('UPDATE dsh_users SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, updatedAtIso, id)
  }

  /**
   * Increment one user's permission version so every existing session becomes stale.
   * @param id - internal user id.
   * @param updatedAtIso - update timestamp.
   * @returns the new permission version.
   */
  bumpUserPermissionVersion(id: string, updatedAtIso: string): number {
    this.database
      .prepare('UPDATE dsh_users SET permission_version = permission_version + 1, updated_at = ? WHERE id = ?')
      .run(updatedAtIso, id)
    const row = this.findUserById(id)
    return row === undefined ? 0 : row.permissionVersion
  }

  /**
   * Append one audit event.
   * @param input - event facts.
   * @param atIso - event ISO timestamp.
   * @returns the generated audit row id.
   */
  appendAudit(input: AuditEventInput, atIso: string): string {
    const id = randomUUID()
    this.database
      .prepare(
        `INSERT INTO dsh_audit_events (id, at, action, outcome, user_id, subject, client_address, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        atIso,
        input.action,
        input.outcome,
        input.userId ?? null,
        input.subject ?? null,
        input.clientAddress ?? null,
        input.detail === undefined ? null : JSON.stringify(input.detail),
      )
    return id
  }

  /**
   * Read the newest audit events.
   * @param limit - maximum rows to return; clamped to 1..1000.
   * @param offset - rows to skip.
   * @returns audit rows newest first.
   */
  listAudit(limit = 100, offset = 0): AuditRow[] {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 1000)
    const boundedOffset = Math.max(Math.trunc(offset), 0)
    return this.database
      .prepare('SELECT * FROM dsh_audit_events ORDER BY at DESC, id DESC LIMIT ? OFFSET ?')
      .all(boundedLimit, boundedOffset)
      .map(row => toAuditRow(row))
  }

  /**
   * Count sessions and login transactions whose lifetime ended before a cutoff.
   * @param cutoffIso - rows expiring or revoked before this ISO instant are prunable.
   * @returns the prunable row counts.
   */
  countPrunableState(cutoffIso: string): { sessions: number; oauthStates: number } {
    const sessions = this.database
      .prepare(
        `SELECT COUNT(*) AS total FROM dsh_sessions
         WHERE (expires_at < ? AND absolute_expires_at < ?) OR (revoked_at IS NOT NULL AND revoked_at < ?)`,
      )
      .get(cutoffIso, cutoffIso, cutoffIso)
    const oauthStates = this.database
      .prepare(
        `SELECT COUNT(*) AS total FROM dsh_oauth_states
         WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)`,
      )
      .get(cutoffIso, cutoffIso)
    return { sessions: integerOf(sessions?.['total']), oauthStates: integerOf(oauthStates?.['total']) }
  }

  /**
   * Delete sessions and login transactions whose lifetime ended before a cutoff.
   * @param cutoffIso - rows expiring or revoked before this ISO instant are deleted.
   * @returns the deleted row counts.
   */
  pruneExpiredState(cutoffIso: string): { sessions: number; oauthStates: number } {
    const sessions = this.database
      .prepare(
        `DELETE FROM dsh_sessions
         WHERE (expires_at < ? AND absolute_expires_at < ?) OR (revoked_at IS NOT NULL AND revoked_at < ?)`,
      )
      .run(cutoffIso, cutoffIso, cutoffIso)
    const oauthStates = this.database
      .prepare(
        `DELETE FROM dsh_oauth_states
         WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)`,
      )
      .run(cutoffIso, cutoffIso)
    return { sessions: Number(sessions.changes), oauthStates: Number(oauthStates.changes) }
  }

  /** Release the SQLite handle; later calls are no-ops. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }
}
