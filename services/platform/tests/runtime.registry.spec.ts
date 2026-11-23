/**
 * Versioned runtime registry: schema, uniqueness, persistence, and migrations.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RUNTIME_SCHEMA_VERSION,
  RuntimeRegistry,
  migrateRuntimeRegistry,
} from '../src/runtime/index.ts'

const RELEM = 'test-realm'
const temporaryDirectories: string[] = []

/**
 * Create one tracked temporary directory.
 * @returns the absolute directory.
 */
async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-runtime-registry-'))
  temporaryDirectories.push(directory)
  return directory
}

/**
 * Create a registry in a fresh temporary directory.
 * @param now - fixed clock for deterministic timestamps.
 * @returns the registry and its database file.
 */
async function makeRegistry(now: () => number = () => 1_000): Promise<{ registry: RuntimeRegistry; file: string }> {
  const directory = await makeTemporaryDirectory()
  const file = join(directory, 'runtime.sqlite')
  return { registry: RuntimeRegistry.open(file, { now }), file }
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    // Windows keeps SQLite WAL side files mapped for a moment after close.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await rm(directory, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt === 19) throw error
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
  }
})

describe('runtime registry schema', () => {
  it('creates the documented columns, migration table, and schema version', async () => {
    const { registry, file } = await makeRegistry()
    registry.close()
    const database = new DatabaseSync(file)
    try {
      const columns = database.prepare('PRAGMA table_info(dsh_runtime_instances)').all()
      const names = columns.map(column => String(column.name)).sort()
      expect(names).toEqual(
        [
          'created_at',
          'desired_state',
          'generation',
          'id',
          'image_digest',
          'last_activity_at',
          'last_error_code',
          'realm',
          'runtime_id',
          'space_key',
          'state',
          'updated_at',
          'user_id',
        ].sort(),
      )
      const migrations = database.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()
      expect(migrations).toHaveLength(1)
      expect(migrations[0]?.version).toBe(RUNTIME_SCHEMA_VERSION)
      expect(typeof migrations[0]?.name).toBe('string')
    } finally {
      database.close()
    }
  })

  it('applies migrations once across repeated opens', async () => {
    const { registry, file } = await makeRegistry()
    registry.close()
    const first = new DatabaseSync(file)
    try {
      expect(migrateRuntimeRegistry(first)).toBe(RUNTIME_SCHEMA_VERSION)
      expect(migrateRuntimeRegistry(first)).toBe(RUNTIME_SCHEMA_VERSION)
      const rows = first.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()
      expect(rows?.count).toBe(1)
    } finally {
      first.close()
    }
    const reopened = RuntimeRegistry.open(file)
    reopened.close()
  })
})

describe('runtime registry records', () => {
  it('allocates one UNALLOCATED record with generation zero and stable timestamps', async () => {
    const { registry } = await makeRegistry(() => 4_242)
    const created = registry.create({ realm: RELEM, userId: 'user-a', spaceKey: 'a'.repeat(64), now: 4_242 })
    expect(created).toMatchObject({
      realm: RELEM,
      userId: 'user-a',
      spaceKey: 'a'.repeat(64),
      generation: 0,
      state: 'UNALLOCATED',
      desiredState: 'RUNNING',
      runtimeId: null,
      imageDigest: null,
      lastErrorCode: null,
      lastActivityAt: null,
      createdAt: 4_242,
      updatedAt: 4_242,
    })
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(registry.find(RELEM, 'user-a')).toEqual(created)
    expect(registry.findById(created.id)).toEqual(created)
    registry.close()
  })

  it('enforces one record per realm+user and a unique space key', async () => {
    const { registry } = await makeRegistry()
    registry.create({ realm: RELEM, userId: 'user-a', spaceKey: 'a'.repeat(64), now: 1 })
    expect(() => registry.create({ realm: RELEM, userId: 'user-a', spaceKey: 'b'.repeat(64), now: 1 })).toThrow()
    expect(() => registry.create({ realm: RELEM, userId: 'user-b', spaceKey: 'a'.repeat(64), now: 1 })).toThrow()
    expect(() => registry.create({ realm: 'other-realm', userId: 'user-a', spaceKey: 'c'.repeat(64), now: 1 })).not.toThrow()
    registry.close()
  })

  it('updates state, generation, runtime id, and activity in place', async () => {
    const { registry } = await makeRegistry(() => 7_777)
    const created = registry.create({ realm: RELEM, userId: 'user-a', spaceKey: 'a'.repeat(64), now: 1_000 })
    const updated = registry.update(created.id, {
      state: 'READY',
      generation: 3,
      runtimeId: 'proc-abc-10-20',
      imageDigest: 'sha256:deadbeef',
      lastActivityAt: 5_000,
    })
    expect(updated).toMatchObject({
      state: 'READY',
      generation: 3,
      runtimeId: 'proc-abc-10-20',
      imageDigest: 'sha256:deadbeef',
      lastActivityAt: 5_000,
      updatedAt: 7_777,
    })
    expect(registry.findByRuntimeId('proc-abc-10-20')?.id).toBe(created.id)
    const touched = registry.touch(created.id, 9_000)
    expect(touched?.lastActivityAt).toBe(9_000)
    expect(registry.touch('missing', 9_000)).toBeUndefined()
    registry.close()
  })

  it('persists records across a reopen', async () => {
    const first = await makeRegistry()
    const created = first.registry.create({ realm: RELEM, userId: 'user-a', spaceKey: 'a'.repeat(64), now: 1 })
    first.registry.update(created.id, { state: 'FAILED', lastErrorCode: 'RUNTIME_EXITED', generation: 2 })
    first.registry.close()
    const reopened = RuntimeRegistry.open(first.file)
    expect(reopened.list()).toHaveLength(1)
    expect(reopened.find(RELEM, 'user-a')).toMatchObject({
      state: 'FAILED',
      lastErrorCode: 'RUNTIME_EXITED',
      generation: 2,
    })
    reopened.close()
  })
})
