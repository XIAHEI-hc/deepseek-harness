/**
 * Opaque per-user space identities and directories.
 *
 * A user's runtime space is named by `HMAC-SHA256(spaceKeySecret, realm:userId)`
 * so neither a display name nor a browser-supplied value can influence where a
 * runtime writes. Every resolved path is proved to stay inside the configured
 * space root before it is used.
 *
 * @module @deepseek-ai/dsh-platform-services/runtime/space
 */

import { createHmac } from 'node:crypto'
import { chown, mkdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { RuntimeManagerError } from './errors.ts'

/** User ids the platform may allocate a runtime for: opaque, filesystem-safe, bounded. */
export const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/** Shape of a hex digest persisted as `space_key`. */
const SPACE_KEY_PATTERN = /^[0-9a-f]{64}$/

/** One user's resolved on-disk runtime space. */
export interface RuntimeSpacePaths {
  /** Configured root that holds every user's space directory. */
  readonly root: string
  /** Opaque HMAC digest naming this space. */
  readonly spaceKey: string
  /** Absolute space directory, a direct child of {@link RuntimeSpacePaths.root}. */
  readonly directory: string
  /** Harness home: `$DSH_HOME` of the runtime. */
  readonly dshHome: string
  /** User home: `$HOME`/`$USERPROFILE` of the runtime. */
  readonly home: string
  /** Shared agent configuration root: `$DSH_AGENTS_HOME` of the runtime. */
  readonly agentsHome: string
  /** Workspace root inside the user space. */
  readonly workspaces: string
  /** Default workspace used as the runtime process working directory. */
  readonly defaultWorkspace: string
  /** Upload staging directory. */
  readonly uploads: string
  /** Temporary directory: `$TMP`/`$TEMP` of the runtime. */
  readonly tmp: string
}

/**
 * Prove a value is a safe opaque user id.
 * @param userId - candidate internal user id.
 * @throws {RuntimeManagerError} when the value is not `[A-Za-z0-9_-]{1,128}`.
 */
export function assertUserId(userId: string): void {
  if (!USER_ID_PATTERN.test(userId)) {
    throw new RuntimeManagerError('RUNTIME_INVALID_USER', 'user id is not a safe opaque identifier')
  }
}

/**
 * Derive the opaque space key for one user.
 * @param spaceKeySecret - HMAC secret from the runtime configuration.
 * @param realm - deployment realm; a user in another realm gets another space.
 * @param userId - internal user id.
 * @returns the lowercase hex HMAC-SHA256 digest of `${realm}:${userId}`.
 * @throws {RuntimeManagerError} for an invalid user id or an empty secret.
 */
export function computeSpaceKey(spaceKeySecret: string, realm: string, userId: string): string {
  assertUserId(userId)
  if (spaceKeySecret === '') {
    throw new RuntimeManagerError('RUNTIME_CONFIG_INVALID', 'space key secret is not configured')
  }
  return createHmac('sha256', spaceKeySecret).update(`${realm}:${userId}`).digest('hex')
}

/**
 * Prove that a resolved path stays strictly inside a root directory.
 * @param root - configured root directory.
 * @param candidate - path to check, resolved lexically against the root.
 * @returns the resolved candidate path.
 * @throws {RuntimeManagerError} when the candidate is the root itself or escapes it.
 */
export function assertPathWithinRoot(root: string, candidate: string): string {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  const offset = relative(resolvedRoot, resolvedCandidate)
  if (offset === '' || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
    throw new RuntimeManagerError('RUNTIME_PATH_ESCAPE', 'runtime path leaves the configured space root')
  }
  return resolvedCandidate
}

/**
 * Build every path of one user's space from a persisted space key.
 * @param input - configured root, realm, user id, and persisted space key.
 * @returns the resolved space paths, each proved to stay inside `input.root`.
 * @throws {RuntimeManagerError} for an invalid user id or an unsafe space key.
 */
export function resolveRuntimeSpaceByKey(input: {
  readonly root: string
  readonly realm: string
  readonly userId: string
  readonly spaceKey: string
}): RuntimeSpacePaths {
  assertUserId(input.userId)
  if (!SPACE_KEY_PATTERN.test(input.spaceKey)) {
    throw new RuntimeManagerError('RUNTIME_PATH_ESCAPE', 'persisted space key is not an opaque HMAC digest')
  }
  const root = resolve(input.root)
  const directory = assertPathWithinRoot(root, join(root, input.spaceKey))
  return {
    root,
    spaceKey: input.spaceKey,
    directory,
    dshHome: assertPathWithinRoot(root, join(directory, 'dsh-home')),
    home: assertPathWithinRoot(root, join(directory, 'home')),
    agentsHome: assertPathWithinRoot(root, join(directory, 'agents-home')),
    workspaces: assertPathWithinRoot(root, join(directory, 'workspaces')),
    defaultWorkspace: assertPathWithinRoot(root, join(directory, 'workspaces', 'default')),
    uploads: assertPathWithinRoot(root, join(directory, 'uploads')),
    tmp: assertPathWithinRoot(root, join(directory, 'tmp')),
  }
}

/**
 * Derive and resolve one user's space without a persisted key.
 * @param input - configured root, realm, user id, and HMAC secret.
 * @returns the resolved space paths.
 * @throws {RuntimeManagerError} for an invalid user id, secret, or escaping path.
 */
export function resolveRuntimeSpace(input: {
  readonly root: string
  readonly realm: string
  readonly userId: string
  readonly spaceKeySecret: string
}): RuntimeSpacePaths {
  const spaceKey = computeSpaceKey(input.spaceKeySecret, input.realm, input.userId)
  return resolveRuntimeSpaceByKey({ root: input.root, realm: input.realm, userId: input.userId, spaceKey })
}

/** Ownership applied to freshly created space directories when the platform runs as root. */
export interface RuntimeSpaceOwnership {
  /** Numeric uid of the runtime container user. */
  readonly uid: number
  /** Numeric gid of the runtime container user. */
  readonly gid: number
}

/**
 * Create every directory of one user's space; existing directories are kept.
 * @param space - resolved space paths.
 * @param ownership - when set, every created space directory is chowned to the
 * runtime container user; the platform container runs as root while runtimes run
 * as an unprivileged uid, so their mounts must already belong to that uid.
 */
export async function ensureRuntimeSpaceDirs(
  space: RuntimeSpacePaths,
  ownership?: RuntimeSpaceOwnership,
): Promise<void> {
  const directories = [
    space.directory,
    space.dshHome,
    space.home,
    space.agentsHome,
    space.workspaces,
    space.defaultWorkspace,
    space.uploads,
    space.tmp,
  ]
  await Promise.all(directories.map(directory => mkdir(directory, { recursive: true })))
  if (ownership === undefined) return
  await Promise.all(directories.map(directory => chown(directory, ownership.uid, ownership.gid)))
}
