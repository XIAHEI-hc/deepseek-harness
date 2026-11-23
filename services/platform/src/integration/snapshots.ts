/**
 * Immutable input snapshots and their provenance.
 *
 * A snapshot is written once under the owning user's directory, hashed, and
 * recorded in the metadata store. Jobs receive copies staged under their own
 * scratch root and mount them read-only; no job ever receives a host path.
 *
 * @module @deepseek-ai/dsh-platform-services/integration/snapshots
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SnapshotPayload, SnapshotRecord, ResourceLocator } from './types.ts'
import type { HostAdapter, IntegrationActor } from './types.ts'
import type { IntegrationStore } from './store.ts'
import { ensureDirectory, newObjectId, readRegularFile, resolveWithin, sha256Hex, writeNewFile } from './files.ts'
import { IntegrationError } from './errors.ts'

/** Result returned by {@link SnapshotService.capture}. */
export interface CapturedSnapshot {
  readonly record: SnapshotRecord
  readonly bytes: Uint8Array
}

/** Creates and reads immutable resource snapshots. */
export class SnapshotService {
  private readonly store: IntegrationStore
  private readonly root: string
  private readonly now: () => number

  /**
   * @param store - metadata store.
   * @param root - snapshot root from configuration.
   * @param now - clock injection.
   */
  constructor(store: IntegrationStore, root: string, now: () => number = Date.now) {
    this.store = store
    this.root = root
    this.now = now
  }

  /**
   * Authorize, read, and persist one resource.
   * @param actor - validated session identity.
   * @param adapter - connector owning the resource.
   * @param locator - requested resource.
   * @returns the stored snapshot and its bytes.
   */
  async capture(actor: IntegrationActor, adapter: HostAdapter, locator: ResourceLocator): Promise<CapturedSnapshot> {
    const grant = await adapter.authorize(actor, locator, 'read')
    if (grant.ownerUserId !== actor.userId) {
      throw new IntegrationError('resource-forbidden', 'adapter issued a grant for a different actor', 403)
    }
    const payload: SnapshotPayload = await adapter.snapshot(actor, locator, grant)
    const sha256 = sha256Hex(payload.content)
    const id = newObjectId()
    ensureDirectory(this.root, actor.userId)
    const storageKey = `${actor.userId}/${id}.bin`
    const target = resolveWithin(this.root, actor.userId, `${id}.bin`)
    writeNewFile(target, payload.content)
    const record: SnapshotRecord = {
      id,
      ownerUserId: actor.userId,
      locator,
      sourceVersion: payload.sourceVersion,
      sha256,
      fetchedAt: new Date(this.now()).toISOString(),
      grantId: grant.grantId,
      policyEpoch: actor.permissionVersion,
      classification: payload.classification,
      contentType: payload.contentType,
      storageKey,
      size: payload.content.byteLength,
    }
    this.store.insertSnapshot(record)
    return { record, bytes: payload.content }
  }

  /**
   * Read one snapshot's bytes.
   * @param snapshot - stored snapshot record.
   * @returns the immutable bytes.
   * @throws {IntegrationError} when the stored file is missing or altered.
   */
  read(snapshot: SnapshotRecord): Uint8Array {
    const [owner, file] = snapshot.storageKey.split('/')
    if (owner === undefined || file === undefined) {
      throw new IntegrationError('storage-failed', 'snapshot storage key is malformed', 500)
    }
    if (owner !== snapshot.ownerUserId) {
      throw new IntegrationError('storage-failed', 'snapshot storage key does not match its owner', 500)
    }
    let bytes: Uint8Array
    try {
      bytes = readRegularFile(resolveWithin(this.root, owner, file), snapshot.size)
    } catch {
      throw new IntegrationError('storage-failed', 'snapshot bytes are unavailable', 500)
    }
    if (sha256Hex(bytes) !== snapshot.sha256) {
      throw new IntegrationError('storage-failed', 'snapshot hash no longer matches', 500)
    }
    return bytes
  }

  /**
   * Stage one snapshot as a read-only input file for a job.
   * @param snapshot - stored snapshot.
   * @param directory - job input directory.
   * @param index - stable ordinal used in the file name.
   * @returns the staged file name.
   */
  stage(snapshot: SnapshotRecord, directory: string, index: number): string {
    const bytes = this.read(snapshot)
    mkdirSync(directory, { recursive: true })
    const extension = extensionForContentType(snapshot.contentType)
    const name = `${String(index + 1).padStart(3, '0')}-${snapshot.locator.resourceId}.${extension}`
    writeNewFile(join(directory, name), bytes)
    return name
  }
}

/**
 * Pick a safe file extension from a snapshot content type.
 * @param contentType - adapter-reported media type.
 * @returns the extension without a leading dot.
 */
function extensionForContentType(contentType: string): string {
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (base === 'application/json' || base.endsWith('+json')) return 'json'
  if (base === 'text/csv') return 'csv'
  if (base === 'text/markdown') return 'md'
  if (base === 'text/html') return 'html'
  if (base.startsWith('text/')) return 'txt'
  if (base === 'image/png') return 'png'
  if (base === 'image/svg+xml') return 'svg'
  if (base === 'application/pdf') return 'pdf'
  return 'bin'
}
