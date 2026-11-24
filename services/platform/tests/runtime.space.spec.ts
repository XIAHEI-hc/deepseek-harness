/**
 * Space-key derivation, opaque-directory layout, and path-containment refusal.
 */

import { createHmac } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertPathWithinRoot,
  assertUserId,
  computeSpaceKey,
  ensureRuntimeSpaceDirs,
  resolveRuntimeSpace,
  resolveRuntimeSpaceByKey,
  RuntimeManagerError,
} from '../src/runtime/index.ts'

const SECRET = 'space-key-secret-0123456789abcdef0123456789'
const RELEM = 'test-realm'
const USER = 'user-0123_ABC'
const temporaryDirectories: string[] = []

/**
 * Create one tracked temporary directory.
 * @returns the absolute directory.
 */
async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-runtime-space-'))
  temporaryDirectories.push(directory)
  return directory
}

/**
 * Run one operation expected to raise a typed manager error.
 * @param operation - operation to run.
 * @param code - expected stable code.
 */
function expectRuntimeError(operation: () => unknown, code: string): void {
  let raised: unknown
  try {
    operation()
  } catch (error) {
    raised = error
  }
  expect(raised).toBeInstanceOf(RuntimeManagerError)
  if (!(raised instanceof RuntimeManagerError)) throw new Error('expected a RuntimeManagerError')
  expect(raised.code).toBe(code)
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('space key derivation', () => {
  it('derives the HMAC-SHA256 digest of realm:userId as a stable hex key', () => {
    const expected = createHmac('sha256', SECRET).update(`${RELEM}:${USER}`).digest('hex')
    const key = computeSpaceKey(SECRET, RELEM, USER)
    expect(key).toBe(expected)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(computeSpaceKey(SECRET, RELEM, USER)).toBe(key)
  })

  it('derives a different space for another realm, user, or secret', () => {
    const key = computeSpaceKey(SECRET, RELEM, USER)
    expect(computeSpaceKey(SECRET, 'other-realm', USER)).not.toBe(key)
    expect(computeSpaceKey(SECRET, RELEM, 'another-user')).not.toBe(key)
    expect(computeSpaceKey(`${SECRET}-other`, RELEM, USER)).not.toBe(key)
  })

  it('refuses user ids that could name a path or a foreign object', () => {
    for (const userId of ['', '..', '../evil', 'a/b', 'a\\b', 'user name', 'üser', 'x'.repeat(129), '-'.repeat(129)]) {
      expectRuntimeError(() => {
        assertUserId(userId)
      }, 'RUNTIME_INVALID_USER')
    }
    expect(() => {
      assertUserId('Abc_123-xyz')
    }).not.toThrow()
  })

  it('refuses a missing space key secret', () => {
    expectRuntimeError(() => computeSpaceKey('', RELEM, USER), 'RUNTIME_CONFIG_INVALID')
  })
})

describe('space directory layout', () => {
  it('puts every directory under the opaque space key below the configured root', async () => {
    const root = await makeTemporaryDirectory()
    const space = resolveRuntimeSpace({ root, realm: RELEM, userId: USER, spaceKeySecret: SECRET })
    expect(space.directory).toBe(resolve(join(root, space.spaceKey)))
    expect(space.dshHome).toBe(join(space.directory, 'dsh-home'))
    expect(space.home).toBe(join(space.directory, 'home'))
    expect(space.agentsHome).toBe(join(space.directory, 'agents-home'))
    expect(space.workspaces).toBe(join(space.directory, 'workspaces'))
    expect(space.defaultWorkspace).toBe(join(space.directory, 'workspaces', 'default'))
    expect(space.uploads).toBe(join(space.directory, 'uploads'))
    expect(space.tmp).toBe(join(space.directory, 'tmp'))
    for (const directory of [
      space.directory,
      space.dshHome,
      space.home,
      space.agentsHome,
      space.workspaces,
      space.defaultWorkspace,
      space.uploads,
      space.tmp,
    ]) {
      expect(directory.startsWith(`${resolve(root)}${sep}`)).toBe(true)
    }
    await ensureRuntimeSpaceDirs(space)
    for (const directory of [space.dshHome, space.home, space.agentsHome, space.defaultWorkspace, space.uploads, space.tmp]) {
      expect((await stat(directory)).isDirectory()).toBe(true)
    }
  })

  it('refuses a path that leaves the configured space root', async () => {
    const root = await makeTemporaryDirectory()
    expectRuntimeError(() => assertPathWithinRoot(root, root), 'RUNTIME_PATH_ESCAPE')
    expectRuntimeError(() => assertPathWithinRoot(root, join(root, '..', 'escape')), 'RUNTIME_PATH_ESCAPE')
    expectRuntimeError(() => assertPathWithinRoot(root, resolve(root, '..', 'escape', 'nested')), 'RUNTIME_PATH_ESCAPE')
    expect(assertPathWithinRoot(root, join(root, 'space'))).toBe(resolve(join(root, 'space')))
  })

  it('refuses a tampered persisted space key before touching the filesystem', async () => {
    const root = await makeTemporaryDirectory()
    for (const spaceKey of ['../../escape', 'not-a-digest', '', 'A'.repeat(64)]) {
      expectRuntimeError(
        () => resolveRuntimeSpaceByKey({ root, realm: RELEM, userId: USER, spaceKey }),
        'RUNTIME_PATH_ESCAPE',
      )
    }
  })
})
