/**
 * Read-only administrative view of the runtime registry.
 *
 * The supervisor records every per-user runtime in `runtime.sqlite`; operators
 * use `dsh-platform admin runtime status` to inspect state, generation, error
 * code, and activity without starting the platform process. The command reads
 * the same database file the supervisor writes, so it is safe while the platform
 * runs.
 *
 * @module @deepseek-ai/dsh-platform-services/admin/runtime
 */

import { join } from 'node:path'
import type { IdentityConfig, RuntimeConfig } from '../config.ts'
import { findPlatformUserById, findPlatformUserBySubject } from '../identity/lookup.ts'
import { RuntimeRegistry, type RuntimeRecord } from '../runtime/registry.ts'

/** One runtime-status request. */
export interface RuntimeStatusRequest {
  /** Identity configuration of the deployment, used to resolve a subject. */
  readonly identity: IdentityConfig
  /** Runtime configuration naming the spaces root and backend kind. */
  readonly runtime: RuntimeConfig
  /** Platform data directory; the registry lives in `runtime/` beneath it. */
  readonly dataDir: string
  /** Deployment realm the runtime rows belong to. */
  readonly realm: string
  /** Internal user id selector; exclusive with `subject` and `all`. */
  readonly userId?: string | undefined
  /** Stable W3 subject selector; exclusive with `userId` and `all`. */
  readonly subject?: string | undefined
  /** List every runtime row in the realm. */
  readonly all?: boolean | undefined
}

/** One reported runtime row. */
export interface RuntimeStatusRow {
  /** Internal user id. */
  readonly userId: string
  /** Lifecycle state. */
  readonly state: string
  /** Whether the user still expects a running runtime. */
  readonly desiredState: string
  /** Allocation generation. */
  readonly generation: number
  /** Backend instance identifier, when allocated. */
  readonly runtimeId: string | null
  /** Immutable image identity last launched, when reported. */
  readonly imageDigest: string | null
  /** Stable failure code of the last failure. */
  readonly lastErrorCode: string | null
  /** Epoch milliseconds of the last recorded user activity. */
  readonly lastActivityAt: number | null
  /** Epoch milliseconds of the last registry write. */
  readonly updatedAt: number
}

/**
 * Project one registry record for operator output.
 * @param record - stored runtime record.
 * @returns the reported row.
 */
function toStatusRow(record: RuntimeRecord): RuntimeStatusRow {
  return {
    userId: record.userId,
    state: record.state,
    desiredState: record.desiredState,
    generation: record.generation,
    runtimeId: record.runtimeId,
    imageDigest: record.imageDigest,
    lastErrorCode: record.lastErrorCode,
    lastActivityAt: record.lastActivityAt,
    updatedAt: record.updatedAt,
  }
}

/**
 * Resolve the selected user id from the request selectors.
 * @param request - status request.
 * @returns the selected user id, or undefined when listing every row.
 * @throws {Error} when the selector is missing, ambiguous, or unknown.
 */
function selectedUserId(request: RuntimeStatusRequest): string | undefined {
  const byUser = request.userId !== undefined && request.userId !== ''
  const bySubject = request.subject !== undefined && request.subject !== ''
  const selected = [byUser, bySubject, request.all === true].filter(Boolean).length
  if (selected === 0) throw new Error('pass exactly one of --user <id>, --subject <w3-subject>, or --all')
  if (selected > 1) throw new Error('pass exactly one of --user <id>, --subject <w3-subject>, or --all')
  if (request.all === true) return undefined
  const user = bySubject
    ? findPlatformUserBySubject(request.identity, request.subject ?? '')
    : findPlatformUserById(request.identity, request.userId ?? '')
  if (user === undefined) throw new Error('no platform user matches that selector')
  return user.id
}

/**
 * Read runtime status rows for the selected user or the whole realm.
 * @param request - selectors and configuration.
 * @returns matching runtime rows.
 * @throws {Error} when the selector is missing, ambiguous, or unknown.
 */
export async function readRuntimeStatus(request: RuntimeStatusRequest): Promise<readonly RuntimeStatusRow[]> {
  const userId = selectedUserId(request)
  const registry = RuntimeRegistry.open(join(request.dataDir, 'runtime', 'runtime.sqlite'), { now: () => Date.now() })
  try {
    const records = userId === undefined ? registry.list() : [registry.find(request.realm, userId)].filter((row): row is RuntimeRecord => row !== undefined)
    return records.filter(record => record.realm === request.realm).map(toStatusRow)
  } finally {
    registry.close()
  }
}
