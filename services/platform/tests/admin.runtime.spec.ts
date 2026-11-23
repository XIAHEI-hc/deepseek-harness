/**
 * Administrative runtime-status reads: selector resolution and registry projection.
 *
 * @module @deepseek-ai/dsh-platform-services/tests/admin.runtime.spec
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPlatformConfig, type PlatformConfig } from '../src/config.ts'
import { createIdentityService, findPlatformUserBySubject } from '../src/identity/index.ts'
import { computeSpaceKey } from '../src/runtime/space.ts'
import { RuntimeRegistry } from '../src/runtime/registry.ts'
import { readRuntimeStatus } from '../src/admin/runtime.ts'
import type { IdentityService, PlatformUser } from '../src/contracts.ts'

/** Temporary directories created by the suite. */
let temporaryDirs: string[]
/** Platform configuration. */
let config: PlatformConfig
/** Identity service writing the test database. */
let identity: IdentityService
/** The account under test. */
let user: PlatformUser

beforeEach(async () => {
  temporaryDirs = []
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-admin-runtime-'))
  temporaryDirs.push(dataDir)
  config = createPlatformConfig({
    dataDir,
    runtime: { root: join(dataDir, 'spaces'), spaceKeySecret: 'runtime-status-space-key-0123456789abcdef' },
    identity: {
      mode: 'mock',
      appEnv: 'testing',
      mock: { subject: 'w3-runtime-user', uid: 'runtime-001', displayName: 'Runtime Test', email: '' },
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
  const resolved = findPlatformUserBySubject(config.identity, 'w3-runtime-user')
  if (resolved === undefined) throw new Error('test user was not created')
  user = resolved
  const registry = RuntimeRegistry.open(join(config.dataDir, 'runtime', 'runtime.sqlite'), { now: () => Date.now() })
  try {
    const created = registry.create({
      realm: config.realm,
      userId: user.id,
      spaceKey: computeSpaceKey(config.runtime.spaceKeySecret, config.realm, user.id),
      now: Date.now(),
    })
    registry.update(created.id, { state: 'READY', desiredState: 'RUNNING', generation: 3, runtimeId: 'proc-1234' })
  } finally {
    registry.close()
  }
})

afterEach(async () => {
  await identity.close()
  await Promise.all(temporaryDirs.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('admin runtime status', () => {
  it('reports one runtime selected by user id', async () => {
    const rows = await readRuntimeStatus({
      identity: config.identity,
      runtime: config.runtime,
      dataDir: config.dataDir,
      realm: config.realm,
      userId: user.id,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ userId: user.id, state: 'READY', desiredState: 'RUNNING', generation: 3, runtimeId: 'proc-1234' })
  })

  it('reports one runtime selected by W3 subject', async () => {
    const rows = await readRuntimeStatus({
      identity: config.identity,
      runtime: config.runtime,
      dataDir: config.dataDir,
      realm: config.realm,
      subject: user.subject,
    })
    expect(rows.map(row => row.userId)).toEqual([user.id])
  })

  it('lists every realm runtime for operators', async () => {
    const rows = await readRuntimeStatus({
      identity: config.identity,
      runtime: config.runtime,
      dataDir: config.dataDir,
      realm: config.realm,
      all: true,
    })
    expect(rows).toHaveLength(1)
  })

  it('refuses missing, ambiguous, and unknown selectors', async () => {
    const base = { identity: config.identity, runtime: config.runtime, dataDir: config.dataDir, realm: config.realm }
    await expect(readRuntimeStatus(base)).rejects.toThrow(/exactly one/)
    await expect(readRuntimeStatus({ ...base, userId: user.id, all: true })).rejects.toThrow(/exactly one/)
    await expect(readRuntimeStatus({ ...base, userId: 'missing-user' })).rejects.toThrow(/no platform user/)
  })
})
