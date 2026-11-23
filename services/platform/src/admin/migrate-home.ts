/**
 * One-shot legacy-home migration.
 *
 * A deployment that ran the previous single-user DSH keeps a private home outside
 * any platform space. This command attributes that data to exactly one DSH user,
 * resolved from the stable W3 subject (or the internal user id an operator read
 * from the identity database) — it never transfers history automatically to the
 * first login. The default mode is a dry run that only prints what would be
 * copied; `--confirm` performs the copy and writes a manifest.
 *
 * @module @deepseek-ai/dsh-platform-services/admin/migrate-home
 */

import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { cp } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { IdentityConfig, RuntimeConfig } from '../config.ts'
import type { PlatformUser } from '../contracts.ts'
import { findPlatformUserById, findPlatformUserBySubject } from '../identity/lookup.ts'
import { resolveRuntimeSpace } from '../runtime/space.ts'

/** Stable failure codes of the migration command. */
export type MigrationFailureCode =
  /** The source path is missing, not a directory, or overlaps managed platform data. */
  | 'migration-source-invalid'
  /** Neither a stable W3 subject nor an internal user id selected a target. */
  | 'migration-target-required'
  /** The subject or user id does not resolve to a platform user. */
  | 'migration-user-unknown'
  /** Destination entries already exist and `--overwrite` was not given. */
  | 'migration-conflicts'

/** Typed refusal of the migration command. */
export class MigrationError extends Error {
  /** Stable machine code safe to compare and print. */
  readonly code: MigrationFailureCode

  /**
   * @param code - stable machine code.
   * @param message - operator-actionable description without file contents.
   */
  constructor(code: MigrationFailureCode, message: string) {
    super(message)
    this.name = 'MigrationError'
    this.code = code
  }
}

/** One top-level entry of the legacy home. */
export interface MigrateHomeEntry {
  /** Entry name relative to the legacy home root. */
  readonly name: string
  /** Entry kind as observed by `lstat`. */
  readonly kind: 'directory' | 'file' | 'symlink'
}

/** Plan and outcome of one migration invocation. */
export interface MigrateHomeReport {
  /** True when nothing was written (the default without `--confirm`). */
  readonly dryRun: boolean
  /** Platform user that receives the data. */
  readonly user: PlatformUser
  /** Absolute legacy home path. */
  readonly source: string
  /** Absolute destination `$DSH_HOME` inside the user's space. */
  readonly targetDshHome: string
  /** Top-level entries discovered in the legacy home. */
  readonly entries: readonly MigrateHomeEntry[]
  /** Destination entry names that already exist. */
  readonly conflicts: readonly string[]
  /** Entry names copied in this invocation. */
  readonly copied: readonly string[]
  /** Entry names skipped because they are symbolic links. */
  readonly skippedSymlinks: readonly string[]
  /** Manifest written after a confirmed copy. */
  readonly manifestFile?: string | undefined
}

/** Inputs of one migration invocation. */
export interface MigrateHomeOptions {
  /** Identity and runtime configuration of this deployment. */
  readonly platform: {
    readonly identity: IdentityConfig
    readonly runtime: RuntimeConfig
    readonly realm: string
    readonly dataDir: string
  }
  /** Absolute legacy DSH home to attribute. */
  readonly from: string
  /** Stable W3 subject of the owning user; exclusive with `userId`. */
  readonly subject?: string | undefined
  /** Internal user id of the owning user; exclusive with `subject`. */
  readonly userId?: string | undefined
  /** Perform the copy; false prints the plan only. */
  readonly confirm: boolean
  /** Replace conflicting destination entries. */
  readonly overwrite: boolean
}

/**
 * Check whether one resolved path is the same as or inside another.
 * @param parent - directory path.
 * @param candidate - path to check.
 * @returns true when candidate is parent or below it.
 */
function isWithin(parent: string, candidate: string): boolean {
  const base = resolve(parent)
  const target = resolve(candidate)
  return target === base || target.startsWith(`${base}${sep}`)
}

/**
 * Resolve the owning platform user from the request.
 * @param platform - identity configuration of this deployment.
 * @param options - request naming a subject or user id.
 * @returns the resolved platform user.
 * @throws {MigrationError} when the selector is missing or unknown.
 */
function resolveOwner(platform: MigrateHomeOptions['platform'], options: MigrateHomeOptions): PlatformUser {
  const bySubject = options.subject !== undefined && options.subject !== ''
  const byUser = options.userId !== undefined && options.userId !== ''
  if (bySubject === byUser) {
    throw new MigrationError('migration-target-required', 'pass exactly one of --subject <w3-subject> or --user <internal-user-id>')
  }
  const user = bySubject
    ? findPlatformUserBySubject(platform.identity, options.subject ?? '')
    : findPlatformUserById(platform.identity, options.userId ?? '')
  if (user === undefined) {
    throw new MigrationError('migration-user-unknown', bySubject
      ? 'no platform user has that stable W3 subject; the user must log in once before migrating its data'
      : 'no platform user has that internal user id')
  }
  return user
}

/**
 * Read and classify the legacy home's top-level entries.
 * @param source - resolved legacy home path.
 * @returns discovered entries sorted by name.
 * @throws {MigrationError} when the source is not a readable directory.
 */
async function readEntries(source: string): Promise<{ entries: MigrateHomeEntry[]; skippedSymlinks: string[] }> {
  let names: string[]
  try {
    names = await readdir(source)
  } catch (error) {
    throw new MigrationError('migration-source-invalid', `legacy home ${source} is not a readable directory: ${String(error)}`)
  }
  const entries: MigrateHomeEntry[] = []
  const skippedSymlinks: string[] = []
  for (const name of names.sort()) {
    const stats = await lstat(join(source, name))
    if (stats.isSymbolicLink()) {
      entries.push({ name, kind: 'symlink' })
      skippedSymlinks.push(name)
      continue
    }
    entries.push({ name, kind: stats.isDirectory() ? 'directory' : 'file' })
  }
  return { entries, skippedSymlinks }
}

/**
 * Migrate one legacy home into one user's DSH space.
 *
 * Validation happens before any write: the source must be a directory outside
 * the managed spaces and platform data, exactly one owner selector must resolve
 * to a known user, and conflicts must be resolved by `--overwrite`. Symbolic
 * links are never followed or copied. A confirmed copy writes a JSON manifest
 * under `<dataDir>/migrations/`.
 * @param options - source path, owner selector, and confirmation flags.
 * @returns the dry-run plan or the completed report.
 * @throws {MigrationError} when a validation or conflict rule fails.
 */
export async function migrateHome(options: MigrateHomeOptions): Promise<MigrateHomeReport> {
  const user = resolveOwner(options.platform, options)
  const source = resolve(options.from)
  let sourceStats
  try {
    sourceStats = await lstat(source)
  } catch (error) {
    throw new MigrationError('migration-source-invalid', `legacy home ${source} does not exist: ${String(error)}`)
  }
  if (!sourceStats.isDirectory()) {
    throw new MigrationError('migration-source-invalid', `legacy home ${source} is not a directory`)
  }
  if (isWithin(options.platform.runtime.root, source)) {
    throw new MigrationError('migration-source-invalid', 'the source is inside the managed runtime spaces and already belongs to a user')
  }
  if (isWithin(options.platform.dataDir, source) || isWithin(source, options.platform.dataDir)) {
    throw new MigrationError('migration-source-invalid', 'the source must not overlap the platform data directory')
  }
  const space = resolveRuntimeSpace({
    root: options.platform.runtime.root,
    realm: options.platform.realm,
    userId: user.id,
    spaceKeySecret: options.platform.runtime.spaceKeySecret,
  })
  if (isWithin(source, space.dshHome) || isWithin(space.dshHome, source)) {
    throw new MigrationError('migration-source-invalid', 'the source must not overlap the destination DSH home')
  }
  const { entries, skippedSymlinks } = await readEntries(source)
  let targetNames: string[] = []
  try {
    targetNames = await readdir(space.dshHome)
  } catch {
    // A missing destination home is created by the confirmed copy; a dry run
    // reports the plan without touching the user's space.
  }
  const targetSet = new Set(targetNames)
  const conflicts = entries.filter(entry => targetSet.has(entry.name)).map(entry => entry.name)
  if (!options.confirm) {
    return {
      dryRun: true,
      user,
      source,
      targetDshHome: space.dshHome,
      entries,
      conflicts,
      copied: [],
      skippedSymlinks,
    }
  }
  if (conflicts.length > 0 && !options.overwrite) {
    throw new MigrationError('migration-conflicts', `destination already has ${conflicts.join(', ')}; re-run with --overwrite to replace them`)
  }
  await mkdir(space.dshHome, { recursive: true })
  const copied: string[] = []
  for (const entry of entries) {
    if (entry.kind === 'symlink') continue
    const target = join(space.dshHome, entry.name)
    if (conflicts.includes(entry.name)) await rm(target, { recursive: true, force: true })
    await cp(join(source, entry.name), target, { recursive: true, preserveTimestamps: true, errorOnExist: false })
    copied.push(entry.name)
  }
  const migrationsDir = join(options.platform.dataDir, 'migrations')
  await mkdir(migrationsDir, { recursive: true })
  const manifestFile = join(migrationsDir, `migrate-home-${new Date().toISOString().replaceAll(':', '-')}.json`)
  await writeFile(manifestFile, `${JSON.stringify({
    command: 'migrate-home',
    user,
    source,
    targetDshHome: space.dshHome,
    entries,
    copied,
    skippedSymlinks,
    finishedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8')
  return {
    dryRun: false,
    user,
    source,
    targetDshHome: space.dshHome,
    entries,
    conflicts,
    copied,
    skippedSymlinks,
    manifestFile,
  }
}
