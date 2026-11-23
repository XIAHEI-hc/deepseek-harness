/**
 * Durable fusion metadata: workspaces, snapshots, jobs, and artifacts.
 *
 * The store is a local SQLite database beside the platform's own runtime
 * registry. Every lookup is owner-scoped at the SQL predicate so a guessed id
 * cannot reveal another user's object.
 *
 * @module @deepseek-ai/dsh-platform-services/integration/store
 */

import type { SyncDatabase } from '../storage/database.ts'
import { SqliteDatabase } from '../storage/sqlite-database.ts'
import type {
  ArtifactRecord,
  JobLanguage,
  JobRecord,
  JobStatus,
  ResourceClassification,
  ResourceLocator,
  ResourceType,
  SnapshotRecord,
  WorkspaceRecord,
} from './types.ts'

/** One numbered fusion schema migration. */
interface FusionMigration {
  readonly version: number
  readonly statements: string
}

/** Fusion schema migrations, applied once per database. */
const FUSION_MIGRATIONS: readonly FusionMigration[] = [
  {
    version: 1,
    statements: `
      CREATE TABLE dsh_integration_workspaces (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_integration_workspaces_owner ON dsh_integration_workspaces(owner_user_id);

      CREATE TABLE dsh_integration_snapshots (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        system_id TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        resource_version TEXT,
        source_version TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        policy_epoch INTEGER NOT NULL,
        classification TEXT NOT NULL,
        content_type TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        size INTEGER NOT NULL
      );
      CREATE INDEX idx_integration_snapshots_owner ON dsh_integration_snapshots(owner_user_id);

      CREATE TABLE dsh_integration_jobs (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        input_snapshot_ids TEXT NOT NULL,
        language TEXT NOT NULL,
        script_sha256 TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        error_code TEXT
      );
      CREATE INDEX idx_integration_jobs_owner ON dsh_integration_jobs(owner_user_id);
      CREATE INDEX idx_integration_jobs_workspace ON dsh_integration_jobs(workspace_id);

      CREATE TABLE dsh_integration_artifacts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        download_scope TEXT NOT NULL
      );
      CREATE INDEX idx_integration_artifacts_owner ON dsh_integration_artifacts(owner_user_id);
      CREATE INDEX idx_integration_artifacts_job ON dsh_integration_artifacts(job_id);
    `,
  },
]

/**
 * Read one required text column.
 * @param row - database row.
 * @param column - column name.
 * @returns the stored text.
 */
function text(row: Record<string, unknown>, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') throw new Error(`integration column ${column} is not text`)
  return value
}

/**
 * Read one nullable text column.
 * @param row - database row.
 * @param column - column name.
 * @returns the stored text or null.
 */
function nullableText(row: Record<string, unknown>, column: string): string | null {
  const value = row[column]
  if (value === null) return null
  if (typeof value !== 'string') throw new Error(`integration column ${column} is not text`)
  return value
}

/**
 * Read one required integer column.
 * @param row - database row.
 * @param column - column name.
 * @returns the stored integer.
 */
function integer(row: Record<string, unknown>, column: string): number {
  const value = row[column]
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  throw new Error(`integration column ${column} is not an integer`)
}

/**
 * Parse a persisted resource type.
 * @param value - stored text.
 * @returns the resource type.
 */
function parseResourceType(value: string): ResourceType {
  if (value === 'api' || value === 'source' || value === 'dataset' || value === 'log' || value === 'artifact') return value
  throw new Error(`integration snapshot holds an unknown resource type ${JSON.stringify(value)}`)
}

/**
 * Parse a persisted classification.
 * @param value - stored text.
 * @returns the classification.
 */
function parseClassification(value: string): ResourceClassification {
  if (value === 'public' || value === 'internal' || value === 'confidential') return value
  throw new Error(`integration snapshot holds an unknown classification ${JSON.stringify(value)}`)
}

/**
 * Parse a persisted job status.
 * @param value - stored text.
 * @returns the status.
 */
function parseJobStatus(value: string): JobStatus {
  if (value === 'queued' || value === 'running' || value === 'succeeded' || value === 'failed' || value === 'cancelled') {
    return value
  }
  throw new Error(`integration job holds an unknown status ${JSON.stringify(value)}`)
}

/**
 * Parse a persisted job language.
 * @param value - stored text.
 * @returns the language.
 */
function parseJobLanguage(value: string): JobLanguage {
  if (value === 'shell' || value === 'python') return value
  throw new Error(`integration job holds an unknown language ${JSON.stringify(value)}`)
}

/**
 * Parse a persisted snapshot id array.
 * @param value - JSON text.
 * @returns the ids.
 */
function parseIdArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed)) throw new Error('integration job input_snapshot_ids is not an array')
  const ids: string[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'string') throw new Error('integration job input_snapshot_ids contains a non-string')
    ids.push(entry)
  }
  return ids
}

/**
 * Convert one workspace row.
 * @param row - database row.
 * @returns the workspace record.
 */
function toWorkspace(row: Record<string, unknown>): WorkspaceRecord {
  return {
    id: text(row, 'id'),
    ownerUserId: text(row, 'owner_user_id'),
    name: text(row, 'name'),
    createdAt: text(row, 'created_at'),
  }
}

/**
 * Convert one snapshot row.
 * @param row - database row.
 * @returns the snapshot record.
 */
function toSnapshot(row: Record<string, unknown>): SnapshotRecord {
  const version = nullableText(row, 'resource_version')
  const locator: ResourceLocator = {
    systemId: text(row, 'system_id'),
    resourceType: parseResourceType(text(row, 'resource_type')),
    resourceId: text(row, 'resource_id'),
    ...(version === null ? {} : { version }),
  }
  return {
    id: text(row, 'id'),
    ownerUserId: text(row, 'owner_user_id'),
    locator,
    sourceVersion: text(row, 'source_version'),
    sha256: text(row, 'sha256'),
    fetchedAt: text(row, 'fetched_at'),
    grantId: text(row, 'grant_id'),
    policyEpoch: integer(row, 'policy_epoch'),
    classification: parseClassification(text(row, 'classification')),
    contentType: text(row, 'content_type'),
    storageKey: text(row, 'storage_key'),
    size: integer(row, 'size'),
  }
}

/**
 * Convert one job row.
 * @param row - database row.
 * @returns the job record.
 */
function toJob(row: Record<string, unknown>): JobRecord {
  return {
    id: text(row, 'id'),
    ownerUserId: text(row, 'owner_user_id'),
    sessionId: text(row, 'session_id'),
    workspaceId: text(row, 'workspace_id'),
    inputSnapshotIds: parseIdArray(text(row, 'input_snapshot_ids')),
    language: parseJobLanguage(text(row, 'language')),
    scriptSha256: text(row, 'script_sha256'),
    status: parseJobStatus(text(row, 'status')),
    createdAt: text(row, 'created_at'),
    startedAt: nullableText(row, 'started_at'),
    finishedAt: nullableText(row, 'finished_at'),
    errorCode: nullableText(row, 'error_code'),
  }
}

/**
 * Convert one artifact row.
 * @param row - database row.
 * @returns the artifact record.
 */
function toArtifact(row: Record<string, unknown>): ArtifactRecord {
  const scope = text(row, 'download_scope')
  if (scope !== 'owner') throw new Error('integration artifact holds an unknown download scope')
  return {
    id: text(row, 'id'),
    jobId: text(row, 'job_id'),
    workspaceId: text(row, 'workspace_id'),
    ownerUserId: text(row, 'owner_user_id'),
    relativePath: text(row, 'relative_path'),
    sha256: text(row, 'sha256'),
    mime: text(row, 'mime'),
    size: integer(row, 'size'),
    createdAt: text(row, 'created_at'),
    downloadScope: scope,
  }
}

/** One partial job update; omitted fields keep their stored value. */
export interface JobPatch {
  readonly status?: JobStatus | undefined
  readonly startedAt?: string | null | undefined
  readonly finishedAt?: string | null | undefined
  readonly errorCode?: string | null | undefined
}

/** Owner-scoped metadata store. */
export class IntegrationStore {
  private readonly database: SyncDatabase
  private closed = false

  /** @param database - open database with migrations applied. */
  private constructor(database: SyncDatabase) {
    this.database = database
  }

  /**
   * Open (creating when absent) the metadata database and apply migrations.
   * @param file - absolute database file path.
   * @returns the open store.
   */
  static open(file: string): IntegrationStore {
    const database = new SqliteDatabase(file)
    database.exec('PRAGMA journal_mode = WAL')
    database.exec('PRAGMA busy_timeout = 5000')
    database.exec('PRAGMA foreign_keys = OFF')
    database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
    const applied = new Set<number>()
    for (const row of database.prepare('SELECT version FROM schema_migrations').all()) {
      const version = row['version']
      if (typeof version === 'number') applied.add(version)
      else if (typeof version === 'bigint') applied.add(Number(version))
      else throw new Error('integration schema_migrations.version is not an integer')
    }
    for (const migration of FUSION_MIGRATIONS) {
      if (applied.has(migration.version)) continue
      database.exec('BEGIN IMMEDIATE')
      try {
        database.exec(migration.statements)
        database
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(migration.version, new Date().toISOString())
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    }
    return new IntegrationStore(database)
  }

  /**
   * Insert one workspace.
   * @param workspace - complete workspace record.
   */
  insertWorkspace(workspace: WorkspaceRecord): void {
    this.database
      .prepare('INSERT INTO dsh_integration_workspaces (id, owner_user_id, name, created_at) VALUES (?, ?, ?, ?)')
      .run(workspace.id, workspace.ownerUserId, workspace.name, workspace.createdAt)
  }

  /**
   * List one owner's workspaces.
   * @param ownerUserId - internal user id.
   * @returns workspaces ordered by creation time.
   */
  listWorkspaces(ownerUserId: string): WorkspaceRecord[] {
    return this.database
      .prepare('SELECT * FROM dsh_integration_workspaces WHERE owner_user_id = ? ORDER BY created_at ASC, id ASC')
      .all(ownerUserId)
      .map(row => toWorkspace(row))
  }

  /**
   * Find one owner-scoped workspace.
   * @param id - workspace id.
   * @param ownerUserId - internal user id.
   * @returns the workspace, or undefined.
   */
  findWorkspace(id: string, ownerUserId: string): WorkspaceRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM dsh_integration_workspaces WHERE id = ? AND owner_user_id = ?')
      .get(id, ownerUserId)
    return row === undefined ? undefined : toWorkspace(row)
  }

  /**
   * Insert one snapshot.
   * @param snapshot - complete snapshot record.
   */
  insertSnapshot(snapshot: SnapshotRecord): void {
    this.database
      .prepare(
        `INSERT INTO dsh_integration_snapshots
          (id, owner_user_id, system_id, resource_type, resource_id, resource_version, source_version,
           sha256, fetched_at, grant_id, policy_epoch, classification, content_type, storage_key, size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.id,
        snapshot.ownerUserId,
        snapshot.locator.systemId,
        snapshot.locator.resourceType,
        snapshot.locator.resourceId,
        snapshot.locator.version ?? null,
        snapshot.sourceVersion,
        snapshot.sha256,
        snapshot.fetchedAt,
        snapshot.grantId,
        snapshot.policyEpoch,
        snapshot.classification,
        snapshot.contentType,
        snapshot.storageKey,
        snapshot.size,
      )
  }

  /**
   * Find one owner-scoped snapshot.
   * @param id - snapshot id.
   * @param ownerUserId - internal user id.
   * @returns the snapshot, or undefined.
   */
  findSnapshot(id: string, ownerUserId: string): SnapshotRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM dsh_integration_snapshots WHERE id = ? AND owner_user_id = ?')
      .get(id, ownerUserId)
    return row === undefined ? undefined : toSnapshot(row)
  }

  /**
   * Find several owner-scoped snapshots in one call.
   * @param ids - snapshot ids.
   * @param ownerUserId - internal user id.
   * @returns snapshots in the requested order; missing ids are absent.
   */
  findSnapshots(ids: readonly string[], ownerUserId: string): SnapshotRecord[] {
    const found = new Map<string, SnapshotRecord>()
    for (const id of ids) {
      const snapshot = this.findSnapshot(id, ownerUserId)
      if (snapshot !== undefined) found.set(id, snapshot)
    }
    return ids.flatMap(id => {
      const snapshot = found.get(id)
      return snapshot === undefined ? [] : [snapshot]
    })
  }

  /**
   * Insert one job.
   * @param job - complete job record.
   */
  insertJob(job: JobRecord): void {
    this.database
      .prepare(
        `INSERT INTO dsh_integration_jobs
          (id, owner_user_id, session_id, workspace_id, input_snapshot_ids, language, script_sha256,
           status, created_at, started_at, finished_at, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.ownerUserId,
        job.sessionId,
        job.workspaceId,
        JSON.stringify(job.inputSnapshotIds),
        job.language,
        job.scriptSha256,
        job.status,
        job.createdAt,
        job.startedAt,
        job.finishedAt,
        job.errorCode,
      )
  }

  /**
   * Apply one partial job update.
   * @param id - job id.
   * @param patch - fields to replace.
   * @returns the updated job, or undefined when it disappeared.
   */
  updateJob(id: string, patch: JobPatch): JobRecord | undefined {
    const current = this.findJob(id, null)
    if (current === undefined) return undefined
    const next: JobRecord = {
      ...current,
      status: patch.status === undefined ? current.status : patch.status,
      startedAt: patch.startedAt === undefined ? current.startedAt : patch.startedAt,
      finishedAt: patch.finishedAt === undefined ? current.finishedAt : patch.finishedAt,
      errorCode: patch.errorCode === undefined ? current.errorCode : patch.errorCode,
    }
    this.database
      .prepare(
        `UPDATE dsh_integration_jobs SET status = ?, started_at = ?, finished_at = ?, error_code = ? WHERE id = ?`,
      )
      .run(next.status, next.startedAt, next.finishedAt, next.errorCode, next.id)
    return next
  }

  /**
   * Find one job, optionally owner-scoped.
   * @param id - job id.
   * @param ownerUserId - internal user id, or null for internal updates.
   * @returns the job, or undefined.
   */
  findJob(id: string, ownerUserId: string | null): JobRecord | undefined {
    const row = ownerUserId === null
      ? this.database.prepare('SELECT * FROM dsh_integration_jobs WHERE id = ?').get(id)
      : this.database.prepare('SELECT * FROM dsh_integration_jobs WHERE id = ? AND owner_user_id = ?').get(id, ownerUserId)
    return row === undefined ? undefined : toJob(row)
  }

  /**
   * List one owner's jobs.
   * @param ownerUserId - internal user id.
   * @returns jobs newest first.
   */
  listJobs(ownerUserId: string): JobRecord[] {
    return this.database
      .prepare('SELECT * FROM dsh_integration_jobs WHERE owner_user_id = ? ORDER BY created_at DESC, id DESC')
      .all(ownerUserId)
      .map(row => toJob(row))
  }

  /**
   * Count one owner's active jobs.
   * @param ownerUserId - internal user id.
   * @returns queued and running job count.
   */
  countActiveJobs(ownerUserId: string): number {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS total FROM dsh_integration_jobs
         WHERE owner_user_id = ? AND status IN ('queued', 'running')`,
      )
      .get(ownerUserId)
    if (row === undefined) return 0
    return integer(row, 'total')
  }

  /**
   * Insert one artifact.
   * @param artifact - complete artifact record.
   */
  insertArtifact(artifact: ArtifactRecord): void {
    this.database
      .prepare(
        `INSERT INTO dsh_integration_artifacts
          (id, job_id, workspace_id, owner_user_id, relative_path, sha256, mime, size, created_at, download_scope)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        artifact.jobId,
        artifact.workspaceId,
        artifact.ownerUserId,
        artifact.relativePath,
        artifact.sha256,
        artifact.mime,
        artifact.size,
        artifact.createdAt,
        artifact.downloadScope,
      )
  }

  /**
   * Find one owner-scoped artifact.
   * @param id - artifact id.
   * @param ownerUserId - internal user id.
   * @returns the artifact, or undefined.
   */
  findArtifact(id: string, ownerUserId: string): ArtifactRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM dsh_integration_artifacts WHERE id = ? AND owner_user_id = ?')
      .get(id, ownerUserId)
    return row === undefined ? undefined : toArtifact(row)
  }

  /**
   * List one job's artifacts.
   * @param jobId - job id.
   * @param ownerUserId - internal user id.
   * @returns artifacts ordered by path.
   */
  listArtifacts(jobId: string, ownerUserId: string): ArtifactRecord[] {
    return this.database
      .prepare(
        'SELECT * FROM dsh_integration_artifacts WHERE job_id = ? AND owner_user_id = ? ORDER BY relative_path ASC',
      )
      .all(jobId, ownerUserId)
      .map(row => toArtifact(row))
  }

  /** Release the database handle. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }
}
