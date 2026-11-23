/**
 * Administrative user and session controls: disable/enable/revoke-all effects on
 * authentication and live sessions.
 *
 * @module @deepseek-ai/dsh-platform-services/tests/admin.users.spec
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPlatformConfig, type PlatformConfig } from '../src/config.ts'
import { createIdentityService, findPlatformUserBySubject } from '../src/identity/index.ts'
import { disableUser, enableUser, revokeAllUserSessions, UserAdminError } from '../src/admin/users.ts'
import type { IdentityService, PlatformHttpResult, PlatformUser } from '../src/contracts.ts'

/** Temporary directories created by the suite. */
let temporaryDirs: string[]
/** Platform configuration. */
let config: PlatformConfig
/** Identity service writing the test database. */
let identity: IdentityService
/** The account under test. */
let user: PlatformUser

/**
 * Create one temporary directory and register it for cleanup.
 * @returns the absolute directory path.
 */
async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-admin-users-'))
  temporaryDirs.push(dir)
  return dir
}

/**
 * Log in once through the identity surface.
 * @returns the login result and the raw session token it set.
 */
async function login(): Promise<{ result: PlatformHttpResult; token: string }> {
  const result = await identity.handle({
    method: 'GET',
    url: new URL('http://platform.invalid/auth/login?return_to=%2F'),
    headers: {},
    cookies: {},
  })
  if (result === undefined) throw new Error('identity did not handle the login request')
  const cookie = result.cookies?.find(entry => entry.name === config.identity.sessionCookieName)
  if (cookie === undefined) throw new Error('login set no session cookie')
  return { result, token: cookie.value }
}

beforeEach(async () => {
  temporaryDirs = []
  const dataDir = await makeDir()
  config = createPlatformConfig({
    dataDir,
    runtime: { root: join(dataDir, 'spaces'), spaceKeySecret: 'admin-space-key-0123456789abcdef' },
    identity: {
      mode: 'mock',
      appEnv: 'testing',
      mock: { subject: 'w3-admin-user', uid: 'admin-001', displayName: 'Admin Test', email: '' },
    },
  })
  identity = await createIdentityService(config.identity)
  await login()
  const resolved = findPlatformUserBySubject(config.identity, 'w3-admin-user')
  if (resolved === undefined) throw new Error('test user was not created')
  user = resolved
})

afterEach(async () => {
  await identity.close().catch(() => undefined)
  await Promise.all(temporaryDirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

describe('administrative user controls', () => {
  it('requires exactly one selector and explicit confirmation', async () => {
    await expect(disableUser({ identity: config.identity, confirm: true }))
      .rejects.toMatchObject({ code: 'admin-target-required' })
    await expect(disableUser({ identity: config.identity, subject: user.subject, confirm: false }))
      .rejects.toMatchObject({ code: 'admin-confirm-required' })
    await expect(disableUser({ identity: config.identity, subject: 'w3-unknown', confirm: true }))
      .rejects.toMatchObject({ code: 'admin-user-unknown' })
  })

  it('disables an account: live sessions stop authenticating and later logins are refused', async () => {
    const first = await login()
    expect((await identity.authenticate(first.token)).ok).toBe(true)
    const report = await disableUser({ identity: config.identity, subject: user.subject, confirm: true })
    expect(report.status).toBe('disabled')
    expect(report.sessionsRevoked).toBeGreaterThanOrEqual(1)
    expect(report.permissionVersion).toBeGreaterThan(1)
    const lookup = await identity.authenticate(first.token)
    expect(lookup.ok).toBe(false)
    const retry = await identity.handle({
      method: 'GET',
      url: new URL('http://platform.invalid/auth/login?return_to=%2F'),
      headers: {},
      cookies: {},
    })
    expect(retry?.status).toBe(403)
  })

  it('re-enables an account; the user logs in again and old sessions stay revoked', async () => {
    const before = await login()
    await disableUser({ identity: config.identity, subject: user.subject, confirm: true })
    const enabled = await enableUser({ identity: config.identity, subject: user.subject, confirm: true })
    expect(enabled.status).toBe('active')
    expect((await identity.authenticate(before.token)).ok).toBe(false)
    const after = await login()
    expect((await identity.authenticate(after.token)).ok).toBe(true)
  })

  it('revokes every session without disabling the account', async () => {
    const first = await login()
    const second = await login()
    const report = await revokeAllUserSessions({ identity: config.identity, userId: user.id, confirm: true })
    expect(report.status).toBe('active')
    expect(report.sessionsRevoked).toBeGreaterThanOrEqual(2)
    expect((await identity.authenticate(first.token)).ok).toBe(false)
    expect((await identity.authenticate(second.token)).ok).toBe(false)
    const fresh = await login()
    expect((await identity.authenticate(fresh.token)).ok).toBe(true)
  })

  it('reports a typed error with a stable code', async () => {
    try {
      await revokeAllUserSessions({ identity: config.identity, subject: 'w3-unknown', confirm: true })
      expect.unreachable('unknown user must be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(UserAdminError)
      expect((error as UserAdminError).code).toBe('admin-user-unknown')
    }
  })
})
