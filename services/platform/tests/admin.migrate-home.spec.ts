/**
 * Legacy single-user home migration review: owner resolution, dry-run safety,
 * conflict policy, data attribution, manifest, and path guards.
 *
 * @module @deepseek-ai/dsh-platform-services/tests/admin.migrate-home.spec
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPlatformConfig, type PlatformConfig } from '../src/config.ts'
import { createIdentityService, findPlatformUserBySubject } from '../src/identity/index.ts'
import type { PlatformUser } from '../src/contracts.ts'
import { migrateHome, MigrationError, type MigrateHomeOptions } from '../src/admin/migrate-home.ts'
import type { IdentityService } from '../src/contracts.ts'

/** All temporary directories created by the suite. */
let temporaryDirs: string[]
/** Platform configuration for the suite. */
let config: PlatformConfig
/** Identity service used to create the legacy owner. */
let identity: IdentityService
/** Legacy owner user. */
let owner: PlatformUser
/** Legacy home directory. */
let legacyHome: string

/**
 * Create one temporary directory and register it for cleanup.
 * @returns the absolute directory path.
 */
async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-migrate-home-'))
  temporaryDirs.push(dir)
  return dir
}

/**
 * Build one legacy home with sessions, skills, credentials, and a root file.
 * @param root - directory to populate.
 */
async function writeLegacyHome(root: string): Promise<void> {
  await mkdir(join(root, 'sessions', '2026'), { recursive: true })
  await writeFile(join(root, 'sessions', '2026', 'session-a.jsonl'), '{"type":"user"}\n')
  await mkdir(join(root, 'skills', 'my-skill'), { recursive: true })
  await writeFile(join(root, 'skills', 'my-skill', 'SKILL.md'), '# my skill\n')
  await writeFile(join(root, '.credentials.yaml'), 'deepseek:\n  apiKey: legacy\n')
  await writeFile(join(root, 'notes.txt'), 'legacy root file\n')
}

/** Options template pointing at the legacy home and owner. */
function options(overrides: Partial<MigrateHomeOptions> = {}): MigrateHomeOptions {
  return {
    platform: {
      identity: config.identity,
      runtime: config.runtime,
      realm: config.realm,
      dataDir: config.dataDir,
    },
    from: legacyHome,
    subject: owner.subject,
    confirm: false,
    overwrite: false,
    ...overrides,
  }
}

beforeEach(async () => {
  temporaryDirs = []
  const dataDir = await makeDir()
  config = createPlatformConfig({
    dataDir,
    runtime: { root: join(dataDir, 'spaces'), spaceKeySecret: 'migrate-space-key-0123456789abcdef' },
    identity: {
      mode: 'mock',
      appEnv: 'testing',
      mock: { subject: 'w3-legacy', uid: 'legacy-001', displayName: 'Legacy User', email: '' },
    },
  })
  identity = await createIdentityService(config.identity)
  const login = await identity.handle({
    method: 'GET',
    url: new URL('http://platform.invalid/auth/login?return_to=%2F'),
    headers: {},
    cookies: {},
  })
  expect(login?.status).toBe(302)
  await identity.close()
  const resolved = findPlatformUserBySubject(config.identity, 'w3-legacy')
  if (resolved === undefined) throw new Error('legacy owner was not created')
  owner = resolved
  legacyHome = await makeDir()
  await writeLegacyHome(legacyHome)
})

afterEach(async () => {
  await identity.close().catch(() => undefined)
  await Promise.all(temporaryDirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

describe('migrateHome', () => {
  it('resolves the owner by stable W3 subject and prints a plan without writing', async () => {
    const report = await migrateHome(options())
    expect(report.dryRun).toBe(true)
    expect(report.user.id).toBe(owner.id)
    expect(report.user.subject).toBe('w3-legacy')
    expect(report.entries.map(entry => entry.name)).toEqual(['.credentials.yaml', 'notes.txt', 'sessions', 'skills'])
    expect(report.skippedSymlinks).toEqual([])
    expect(report.copied).toEqual([])
    expect(report.targetDshHome).not.toBe(legacyHome)
    await expect(stat(report.targetDshHome)).rejects.toThrow()
  })

  it('copies every entry into the owner space and writes a manifest when confirmed', async () => {
    const report = await migrateHome(options({ confirm: true }))
    expect(report.dryRun).toBe(false)
    expect(report.copied).toEqual(['.credentials.yaml', 'notes.txt', 'sessions', 'skills'])
    expect(await readFile(join(report.targetDshHome, 'sessions', '2026', 'session-a.jsonl'), 'utf8')).toBe('{"type":"user"}\n')
    expect(await readFile(join(report.targetDshHome, 'notes.txt'), 'utf8')).toBe('legacy root file\n')
    expect((await stat(join(report.targetDshHome, 'skills', 'my-skill'))).isDirectory()).toBe(true)
    if (report.manifestFile === undefined) throw new Error('manifest was not written')
    const manifest = JSON.parse(await readFile(report.manifestFile, 'utf8')) as { user: { id: string }; copied: string[] }
    expect(manifest.user.id).toBe(owner.id)
    expect(manifest.copied).toHaveLength(4)
    // The legacy home is left untouched so the operator can verify before deletion.
    expect((await stat(join(legacyHome, 'notes.txt'))).isFile()).toBe(true)
  })

  it('refuses to overwrite existing destination entries without --overwrite', async () => {
    await migrateHome(options({ confirm: true }))
    await expect(migrateHome(options({ confirm: true }))).rejects.toMatchObject({ code: 'migration-conflicts' })
    await expect(stat(config.runtime.root)).resolves.toBeTruthy()
  })

  it('replaces destination entries when --overwrite is confirmed', async () => {
    const first = await migrateHome(options({ confirm: true }))
    await writeFile(join(legacyHome, 'notes.txt'), 'updated notes\n')
    const second = await migrateHome(options({ confirm: true, overwrite: true }))
    expect(second.conflicts).toContain('notes.txt')
    expect(await readFile(join(first.targetDshHome, 'notes.txt'), 'utf8')).toBe('updated notes\n')
  })

  it('resolves the owner by internal user id as well', async () => {
    const report = await migrateHome(options({ subject: undefined, userId: owner.id }))
    expect(report.dryRun).toBe(true)
    expect(report.user.id).toBe(owner.id)
  })

  it('requires exactly one owner selector', async () => {
    await expect(migrateHome(options({ subject: undefined }))).rejects.toMatchObject({ code: 'migration-target-required' })
    await expect(migrateHome(options({ userId: owner.id }))).rejects.toMatchObject({ code: 'migration-target-required' })
  })

  it('refuses an unknown owner instead of transferring to the first login', async () => {
    await expect(migrateHome(options({ subject: 'w3-unknown' })))
      .rejects.toMatchObject({ code: 'migration-user-unknown' })
  })

  it('refuses a missing source and a source overlapping managed platform data', async () => {
    await expect(migrateHome(options({ from: join(legacyHome, 'missing') })))
      .rejects.toMatchObject({ code: 'migration-source-invalid' })
    const managed = join(config.runtime.root, 'deadbeef')
    await mkdir(managed, { recursive: true })
    await expect(migrateHome(options({ from: managed })))
      .rejects.toMatchObject({ code: 'migration-source-invalid' })
    await expect(migrateHome(options({ from: config.dataDir })))
      .rejects.toMatchObject({ code: 'migration-source-invalid' })
  })

  it('never copies symbolic links', async () => {
    if (process.platform === 'win32') return
    const { symlink } = await import('node:fs/promises')
    await symlink(join(legacyHome, 'notes.txt'), join(legacyHome, 'linked-notes'))
    const report = await migrateHome(options({ confirm: true }))
    expect(report.skippedSymlinks).toContain('linked-notes')
    expect(report.copied).not.toContain('linked-notes')
    await expect(stat(join(report.targetDshHome, 'linked-notes'))).rejects.toThrow()
  })

  it('reports typed migration errors with stable codes', async () => {
    try {
      await migrateHome(options({ subject: 'w3-unknown' }))
      expect.unreachable('unknown owner must be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError)
      expect((error as MigrationError).code).toBe('migration-user-unknown')
      expect((error as MigrationError).message).not.toContain('w3-unknown')
    }
  })
})
