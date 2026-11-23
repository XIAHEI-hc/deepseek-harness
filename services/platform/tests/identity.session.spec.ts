/**
 * Session lifecycle, account-state checks, CSRF verification, internal
 * introspection, and versioned SQLite migrations.
 *
 * Covers AUTH-01 (401 codes), AUTH-02 (absolute expiry), AUTH-21/22 (CSRF and
 * revocation), AUTH-23 (disabled account and moved permission version), and the
 * storage requirements of the identity database.
 */
import type { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { digest, toIso } from '../src/identity/security.ts'
import {
  cleanupIdentityTests,
  countRows,
  createTestIdentity,
  errorCodeOf,
  jsonObject,
  newBrowser,
  openIdentityDatabase,
  registerCleanup,
  requireResult,
  startIdentity,
  TestClock,
  userOf,
  type TestIdentityFixture,
} from './identity.testkit.ts'

afterEach(cleanupIdentityTests)

/**
 * Open the fixture database for assertions.
 * @param fixture - fixture owning the database.
 * @returns the open database, registered for cleanup.
 */
function openDatabase(fixture: TestIdentityFixture): DatabaseSync {
  const database = openIdentityDatabase(fixture.dataDir)
  registerCleanup(() => {
    database.close()
  })
  return database
}

/**
 * Read one session row by its raw token.
 * @param database - open identity database.
 * @param token - raw session cookie token.
 * @returns the stored row.
 */
function sessionRow(database: DatabaseSync, token: string): Record<string, unknown> {
  const row = database.prepare('SELECT * FROM dsh_sessions WHERE token_hash = ?').get(digest(token))
  if (row === undefined) throw new Error('expected the session row to exist')
  return row
}

describe('session lifecycle', () => {
  it('refreshes the idle expiry on activity at most once per minute', async () => {
    const clock = new TestClock()
    const fixture = createTestIdentity({
      idleTimeoutMs: 10 * 60_000,
      absoluteTimeoutMs: 60 * 60_000,
    })
    const { service } = await startIdentity(fixture, { clock })
    const browser = newBrowser(fixture, service)
    requireResult(await browser.get('/auth/login'))
    const token = browser.cookieValue(fixture.config.sessionCookieName) ?? ''
    const database = openDatabase(fixture)

    const start = clock.read()
    const initial = sessionRow(database, token)
    expect(initial['last_seen_at']).toBe(toIso(start))
    expect(initial['expires_at']).toBe(toIso(start + fixture.config.idleTimeoutMs))
    expect(initial['absolute_expires_at']).toBe(toIso(start + fixture.config.absoluteTimeoutMs))

    clock.advance(30_000)
    expect(requireResult(await browser.get('/auth/me')).status).toBe(200)
    expect(sessionRow(database, token)['expires_at']).toBe(initial['expires_at'])

    clock.advance(60_000)
    expect(requireResult(await browser.get('/auth/me')).status).toBe(200)
    const refreshed = sessionRow(database, token)
    expect(refreshed['last_seen_at']).toBe(toIso(start + 90_000))
    expect(refreshed['expires_at']).toBe(
      toIso(start + 90_000 + fixture.config.idleTimeoutMs),
    )

    clock.advance(fixture.config.idleTimeoutMs)
    const expired = requireResult(await browser.get('/auth/me'))
    expect(expired.status).toBe(401)
    expect(errorCodeOf(expired)).toBe('session-expired')
    expect(sessionRow(database, token)['revoked_at']).not.toBeNull()
  })

  it('never extends the idle expiry past the absolute expiry', async () => {
    const clock = new TestClock()
    const fixture = createTestIdentity({
      idleTimeoutMs: 60 * 60_000,
      absoluteTimeoutMs: 20 * 60_000,
    })
    const { service } = await startIdentity(fixture, { clock })
    const browser = newBrowser(fixture, service)
    requireResult(await browser.get('/auth/login'))
    const token = browser.cookieValue(fixture.config.sessionCookieName) ?? ''
    const database = openDatabase(fixture)
    const start = clock.read()

    clock.advance(15 * 60_000)
    expect(requireResult(await browser.get('/auth/me')).status).toBe(200)
    expect(sessionRow(database, token)['expires_at']).toBe(
      toIso(start + fixture.config.absoluteTimeoutMs),
    )

    clock.advance(6 * 60_000)
    const expired = requireResult(await browser.get('/auth/me'))
    expect(expired.status).toBe(401)
    expect(errorCodeOf(expired)).toBe('session-expired')
  })

  it('AUTH-23 rejects a session when the account is disabled', async () => {
    const fixture = createTestIdentity()
    const { service } = await startIdentity(fixture)
    const browser = newBrowser(fixture, service)
    requireResult(await browser.get('/auth/login'))
    const token = browser.cookieValue(fixture.config.sessionCookieName) ?? ''
    const me = requireResult(await browser.get('/auth/me'))
    const userId = userOf(me).id
    const database = openDatabase(fixture)

    database.prepare('UPDATE dsh_users SET status = ? WHERE id = ?').run('disabled', userId)
    const rejected = requireResult(await browser.get('/auth/me'))
    expect(rejected.status).toBe(401)
    expect(errorCodeOf(rejected)).toBe('account-disabled')
    expect(sessionRow(database, token)['revoked_at']).not.toBeNull()

    const relogin = requireResult(await browser.get('/auth/login'))
    expect(relogin.status).toBe(403)
    expect(errorCodeOf(relogin)).toBe('account-disabled')
    expect(countRows(database, 'dsh_sessions')).toBe(1)
  })

  it('AUTH-23 rejects a session when the user permission version moves', async () => {
    const fixture = createTestIdentity()
    const { service } = await startIdentity(fixture)
    const browser = newBrowser(fixture, service)
    requireResult(await browser.get('/auth/login'))
    const me = requireResult(await browser.get('/auth/me'))
    const database = openDatabase(fixture)

    database
      .prepare('UPDATE dsh_users SET permission_version = 2 WHERE id = ?')
      .run(userOf(me).id)
    const rejected = requireResult(await browser.get('/auth/me'))
    expect(rejected.status).toBe(401)
    expect(errorCodeOf(rejected)).toBe('account-disabled')
  })

  it('AUTH-21 verifies CSRF through the header, cookie, and stored hash', async () => {
    const fixture = createTestIdentity()
    const { service } = await startIdentity(fixture)
    const browser = newBrowser(fixture, service)
    requireResult(await browser.get('/auth/login'))
    const token = browser.cookieValue(fixture.config.sessionCookieName) ?? ''
    const csrf = browser.cookieValue(fixture.config.csrfCookieName) ?? ''

    const noSession = await service.authenticate(undefined)
    expect(noSession).toEqual({ ok: false, code: 'no-session' })
    const invalid = await service.authenticate('not-a-session-token')
    expect(invalid).toEqual({ ok: false, code: 'session-invalid' })

    const lookup = await service.authenticate(token)
    if (!lookup.ok) throw new Error('expected a valid session')
    const session = lookup.session
    expect(service.verifyCsrf(session, csrf, csrf)).toBe(true)
    expect(service.verifyCsrf(session, csrf, `${csrf}-tampered`)).toBe(false)
    expect(service.verifyCsrf(session, `${csrf}-tampered`, csrf)).toBe(false)
    expect(service.verifyCsrf(session, undefined, csrf)).toBe(false)
    expect(service.verifyCsrf(session, '', '')).toBe(false)

    const otherBrowser = newBrowser(fixture, service)
    requireResult(await otherBrowser.get('/auth/login'))
    const otherCsrf = otherBrowser.cookieValue(fixture.config.csrfCookieName) ?? ''
    expect(otherCsrf).not.toBe(csrf)
    browser.setCookie({ name: fixture.config.csrfCookieName, value: otherCsrf, path: '/' })
    const crossSession = requireResult(
      await browser.post('/auth/logout', { headers: { 'x-csrf-token': otherCsrf } }),
    )
    expect(crossSession.status).toBe(403)
    expect(errorCodeOf(crossSession)).toBe('csrf-invalid')
    browser.setCookie({ name: fixture.config.csrfCookieName, value: csrf, path: '/' })

    requireResult(await browser.post('/auth/logout', { headers: { 'x-csrf-token': csrf } }))
    expect(service.verifyCsrf(session, csrf, csrf)).toBe(false)
    const revoked = await service.authenticate(token)
    expect(revoked.ok).toBe(false)
    if (revoked.ok) throw new Error('expected the session to be revoked')
    expect(revoked.code).toBe('session-revoked')
  })

  it('AUTH-22 revokes every session of the user on logout-all after confirmation', async () => {
    const fixture = createTestIdentity()
    const { service } = await startIdentity(fixture)
    const first = newBrowser(fixture, service)
    const second = newBrowser(fixture, service)
    requireResult(await first.get('/auth/login'))
    requireResult(await second.get('/auth/login'))
    const csrf = first.cookieValue(fixture.config.csrfCookieName) ?? ''

    const missingConfirmation = requireResult(
      await first.post('/auth/logout-all', { headers: { 'x-csrf-token': csrf } }),
    )
    expect(missingConfirmation.status).toBe(400)

    const withoutCsrf = requireResult(
      await first.post('/auth/logout-all', { headers: { 'x-dsh-confirm': 'logout-all' } }),
    )
    expect(withoutCsrf.status).toBe(403)
    expect(errorCodeOf(withoutCsrf)).toBe('csrf-invalid')

    const loggedOutAll = requireResult(
      await first.post('/auth/logout-all', {
        headers: { 'x-csrf-token': csrf, 'x-dsh-confirm': 'logout-all' },
      }),
    )
    expect(loggedOutAll.status).toBe(200)
    expect(jsonObject(loggedOutAll)['ok']).toBe(true)
    expect(requireResult(await first.get('/auth/me')).status).toBe(401)
    expect(requireResult(await second.get('/auth/me')).status).toBe(401)
    const database = openDatabase(fixture)
    expect(countRows(database, 'dsh_sessions')).toBe(2)
    expect(countRows(database, 'dsh_users')).toBe(1)
  })

  it('introspects a session for the internal service key only', async () => {
    const fixture = createTestIdentity()
    const { service } = await startIdentity(fixture)
    const browser = newBrowser(fixture, service)
    requireResult(await browser.get('/auth/login'))
    const token = browser.cookieValue(fixture.config.sessionCookieName) ?? ''
    const key = fixture.config.internalApiKey

    const introspected = requireResult(
      await browser.post('/internal/introspect', {
        headers: { 'x-dsh-internal-key': key },
        body: JSON.stringify({ session_token: token }),
      }),
    )
    expect(introspected.status).toBe(200)
    const body = jsonObject(introspected)
    expect(body['active']).toBe(true)
    expect(String(body['sessionId'])).toMatch(/^[0-9a-f-]{36}$/)
    expect(body['permissionVersion']).toBe(1)
    expect(toIso(Date.parse(String(body['expiresAt'])))).toBe(body['expiresAt'])
    expect(toIso(Date.parse(String(body['absoluteExpiresAt'])))).toBe(body['absoluteExpiresAt'])
    const me = requireResult(await browser.get('/auth/me'))
    expect(userOf(introspected).id).toBe(userOf(me).id)

    const wrongKey = requireResult(
      await browser.post('/internal/introspect', {
        headers: { 'x-dsh-internal-key': 'wrong-internal-key' },
        body: JSON.stringify({ session_token: token }),
      }),
    )
    expect(wrongKey.status).toBe(403)
    expect(errorCodeOf(wrongKey)).toBe('internal-unauthorized')

    const missingKey = requireResult(
      await browser.post('/internal/introspect', {
        body: JSON.stringify({ session_token: token }),
      }),
    )
    expect(missingKey.status).toBe(403)
    expect(errorCodeOf(missingKey)).toBe('internal-unauthorized')

    const invalidToken = requireResult(
      await browser.post('/internal/introspect', {
        headers: { 'x-dsh-internal-key': key },
        body: JSON.stringify({ session_token: 'forged-session-token' }),
      }),
    )
    expect(invalidToken.status).toBe(401)
    expect(errorCodeOf(invalidToken)).toBe('session-invalid')

    const missingBody = requireResult(
      await browser.post('/internal/introspect', { headers: { 'x-dsh-internal-key': key } }),
    )
    expect(missingBody.status).toBe(400)
    expect(errorCodeOf(missingBody)).toBe('session-invalid')
  })

  it('hides the introspection endpoint when no internal service key is configured', async () => {
    const fixture = createTestIdentity({ internalApiKey: '' })
    const { service } = await startIdentity(fixture)
    const browser = newBrowser(fixture, service)
    requireResult(await browser.get('/auth/login'))
    const token = browser.cookieValue(fixture.config.sessionCookieName) ?? ''
    const result = requireResult(
      await browser.post('/internal/introspect', {
        headers: { 'x-dsh-internal-key': 'anything' },
        body: JSON.stringify({ session_token: token }),
      }),
    )
    expect(result.status).toBe(404)
    expect(errorCodeOf(result)).toBe('not-found')
  })

  it('applies the versioned schema once and keeps WAL, indexes, and unique keys', async () => {
    const fixture = createTestIdentity()
    const first = await startIdentity(fixture)
    const databasePath = join(fixture.dataDir, 'identity.sqlite')
    expect(existsSync(databasePath)).toBe(true)
    const database = openDatabase(fixture)

    const migrations = database
      .prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version')
      .all()
    expect(migrations.map(row => row['version'])).toEqual([1])
    const appliedAt = String(migrations[0]?.['applied_at'])
    expect(appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const indexNames = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map(row => String(row['name']))
    for (const index of [
      'idx_dsh_users_subject',
      'idx_dsh_users_uid',
      'idx_dsh_sessions_token_hash',
      'idx_dsh_sessions_user_id',
      'idx_dsh_sessions_expires_at',
      'idx_dsh_oauth_states_state_hash',
      'idx_dsh_oauth_states_expires_at',
    ]) {
      expect(indexNames).toContain(index)
    }

    const journal = database.prepare('PRAGMA journal_mode').get()
    expect(String(journal?.['journal_mode']).toLowerCase()).toBe('wal')

    const usersSql = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'dsh_users'").get()
    expect(String(usersSql?.['sql'])).toContain('UNIQUE')
    const sessionsSql = database
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'dsh_sessions'")
      .get()
    expect(String(sessionsSql?.['sql'])).toContain('UNIQUE')

    const insertUser = database.prepare(
      `INSERT INTO dsh_users
        (id, external_subject, uid, display_name, email, status, permission_version, created_at, updated_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    insertUser.run(
      'user-unique-1',
      'subject-unique-1',
      'uid-unique-1',
      'Unique One',
      null,
      'active',
      1,
      appliedAt,
      appliedAt,
      appliedAt,
    )
    expect(() => {
      insertUser.run(
        'user-unique-2',
        'subject-unique-1',
        'uid-unique-2',
        'Unique Two',
        null,
        'active',
        1,
        appliedAt,
        appliedAt,
        appliedAt,
      )
    }).toThrow()

    await first.service.close()
    const second = await startIdentity(fixture)
    expect(second.service.mode).toBe('mock')
    const migrationsAfterRestart = database
      .prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version')
      .all()
    expect(migrationsAfterRestart).toHaveLength(1)
    expect(migrationsAfterRestart[0]?.['applied_at']).toBe(appliedAt)
    expect(countRows(database, 'dsh_users')).toBe(1)
  })
})
