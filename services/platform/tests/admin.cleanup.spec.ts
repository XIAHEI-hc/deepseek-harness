/**
 * Administrative cleanup of expired sessions and login transactions.
 *
 * @module @deepseek-ai/dsh-platform-services/tests/admin.cleanup.spec
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPlatformConfig, type PlatformConfig } from '../src/config.ts'
import { createIdentityService } from '../src/identity/index.ts'
import { openIdentityDatabase, countRows } from './identity.testkit.ts'
import { runIdentityCleanup } from '../src/admin/cleanup.ts'
import type { IdentityService } from '../src/contracts.ts'

/** Temporary directory created by the suite. */
let dataDir: string
/** Platform configuration. */
let config: PlatformConfig
/** Identity service writing the test database. */
let identity: IdentityService

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'dsh-admin-cleanup-'))
  config = createPlatformConfig({
    dataDir,
    identity: {
      mode: 'mock',
      appEnv: 'testing',
      mock: { subject: 'w3-cleanup-user', uid: 'cleanup-001', displayName: 'Cleanup Test', email: '' },
    },
  })
  identity = await createIdentityService(config.identity)
  const login = await identity.handle({
    method: 'GET',
    url: new URL('http://platform.invalid/auth/login?return_to=%2F'),
    headers: {},
    cookies: {},
    clientAddress: '127.0.0.1',
  })
  expect(login?.status).toBe(302)
  const database = openIdentityDatabase(dataDir)
  try {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    database.prepare('UPDATE dsh_sessions SET expires_at = ?, absolute_expires_at = ?').run(old, old)
    database
      .prepare(
        `INSERT INTO dsh_oauth_states (id, state_hash, browser_nonce_hash, return_to, created_at, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('state-old', 'hash-old', 'nonce-old', '/', old, old, old)
  } finally {
    database.close()
  }
})

afterEach(async () => {
  await identity.close()
  await rm(dataDir, { recursive: true, force: true })
})

describe('identity cleanup', () => {
  it('counts expired rows as a dry run without deleting them', async () => {
    const report = await runIdentityCleanup({ identity: config.identity, retentionDays: 7, confirm: false })
    expect(report.applied).toBe(false)
    expect(report.sessions).toBeGreaterThanOrEqual(1)
    expect(report.oauthStates).toBe(1)
    const database = openIdentityDatabase(dataDir)
    try {
      expect(countRows(database, 'dsh_sessions')).toBeGreaterThanOrEqual(1)
      expect(countRows(database, 'dsh_oauth_states')).toBe(1)
    } finally {
      database.close()
    }
  })

  it('deletes expired rows and records an audit event on confirmation', async () => {
    const report = await runIdentityCleanup({ identity: config.identity, retentionDays: 7, confirm: true })
    expect(report.applied).toBe(true)
    expect(report.sessions).toBeGreaterThanOrEqual(1)
    expect(report.oauthStates).toBe(1)
    const database = openIdentityDatabase(dataDir)
    try {
      expect(countRows(database, 'dsh_sessions')).toBe(0)
      expect(countRows(database, 'dsh_oauth_states')).toBe(0)
      const audit = database.prepare("SELECT detail FROM dsh_audit_events WHERE action = 'admin.session.cleanup'").get()
      expect(String(audit?.['detail'])).toContain('"oauthStates":1')
    } finally {
      database.close()
    }
  })

  it('refuses a non-positive retention window', async () => {
    await expect(runIdentityCleanup({ identity: config.identity, retentionDays: 0, confirm: false })).rejects.toThrow(/positive integer/)
  })
})
