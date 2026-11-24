/**
 * PostgreSQL identity backend integration tests.
 *
 * These tests run only when `DSH_TEST_POSTGRES_URL` names a reachable database;
 * the default suite keeps exercising the SQLite backend.
 *
 * @module @deepseek-ai/dsh-platform-services/tests/identity.postgres.spec
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPlatformConfig, type PlatformConfig } from '../src/config.ts'
import { createIdentityService } from '../src/identity/index.ts'
import { IdentityStore } from '../src/identity/store.ts'
import { openIdentityDatabase } from '../src/storage/open.ts'
import type { IdentityService } from '../src/contracts.ts'

const postgresUrl = process.env.DSH_TEST_POSTGRES_URL ?? ''

/** Parse `set-cookie` results into a cookie jar. */
function cookiesOf(result: Awaited<ReturnType<IdentityService['handle']>>): Record<string, string> {
  const jar: Record<string, string> = {}
  for (const cookie of result?.cookies ?? []) jar[cookie.name] = cookie.value
  return jar
}

describe.skipIf(postgresUrl === '')('identity over PostgreSQL', () => {
  let dataDir: string
  let config: PlatformConfig
  let identity: IdentityService
  let subject: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'dsh-pg-identity-'))
    subject = `pg-subject-${randomUUID()}`
    config = createPlatformConfig({
      dataDir,
      identity: {
        mode: 'mock',
        appEnv: 'testing',
        storage: { kind: 'postgres', postgresUrl },
        mock: { subject, uid: `pg-uid-${randomUUID()}`, displayName: 'PG User', email: 'pg@example.test' },
      },
    })
    identity = await createIdentityService(config.identity)
  })

  afterEach(async () => {
    await identity.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('logs in, resolves a session, and records the login audit row', async () => {
    const login = await identity.handle({
      method: 'GET',
      url: new URL('http://platform.invalid/auth/login?return_to=%2F'),
      headers: {},
      cookies: {},
      clientAddress: '127.0.0.1',
    })
    expect(login?.status).toBe(302)
    const jar = cookiesOf(login)
    const me = await identity.handle({
      method: 'GET',
      url: new URL('http://platform.invalid/auth/me'),
      headers: {},
      cookies: jar,
      clientAddress: '127.0.0.1',
    })
    expect(me?.status).toBe(200)
    const lookup = await identity.authenticate(jar['dsh_session'])
    expect(lookup.ok).toBe(true)
    if (!lookup.ok) return
    expect(lookup.session.user.displayName).toBe('PG User')

    const store = new IdentityStore(openIdentityDatabase(config.identity), new Date().toISOString())
    try {
      const events = store.listAudit(100, 0)
      expect(events.some(event => event.action === 'login' && event.outcome === 'success')).toBe(true)
    } finally {
      store.close()
    }
  })

  it('keeps a session after the service reopens', async () => {
    const login = await identity.handle({
      method: 'GET',
      url: new URL('http://platform.invalid/auth/login?return_to=%2F'),
      headers: {},
      cookies: {},
      clientAddress: '127.0.0.1',
    })
    const token = cookiesOf(login)['dsh_session']
    expect(token).toBeTypeOf('string')
    await identity.close()
    identity = await createIdentityService(config.identity)
    const lookup = await identity.authenticate(token)
    expect(lookup.ok).toBe(true)
  })

  it('invalidates the session after logout', async () => {
    const login = await identity.handle({
      method: 'GET',
      url: new URL('http://platform.invalid/auth/login?return_to=%2F'),
      headers: {},
      cookies: {},
      clientAddress: '127.0.0.1',
    })
    const jar = cookiesOf(login)
    const logout = await identity.handle({
      method: 'POST',
      url: new URL('http://platform.invalid/auth/logout'),
      headers: { 'x-csrf-token': jar['dsh_csrf'] },
      cookies: jar,
      clientAddress: '127.0.0.1',
    })
    expect(logout?.status).toBe(200)
    const lookup = await identity.authenticate(jar['dsh_session'])
    expect(lookup.ok).toBe(false)
  })
})
