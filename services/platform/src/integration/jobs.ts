/**
 * Analysis job lifecycle.
 *
 * A job binds the validated session, one owner-verified workspace, and a set of
 * owner-verified snapshots. Before launch every snapshot is re-authorized with
 * the connector, staged under the job's private input directory, and mounted
 * read-only. Outputs land below the selected workspace only; a workspace switch
 * affects later jobs and never redirects a running one.
 *
 * @module @deepseek-ai/dsh-platform-services/integration/jobs
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { IntegrationConfig } from './config.ts'
import type {
  ArtifactRecord,
  HostAdapter,
  IntegrationActor,
  JobLanguage,
  JobRecord,
  SnapshotRecord,
  WorkspaceRecord,
} from './types.ts'
import type { IntegrationStore } from './store.ts'
import type { SnapshotService } from './snapshots.ts'
import type { WorkspaceService } from './workspaces.ts'
import { AnalysisJobRunner } from './runner.ts'
import { listRegularFiles, mimeForPath, newObjectId, readRegularFile, resolveWithin, sha256Hex, writeNewFile } from './files.ts'
import { IntegrationError } from './errors.ts'

/** Largest artifact collected from one job. */
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024

/** Largest artifact count collected from one job. */
const MAX_ARTIFACTS = 512

/** One request to start an analysis job. */
export interface StartJobRequest {
  readonly workspaceId: string
  readonly inputSnapshotIds: readonly string[]
  readonly language: JobLanguage
  readonly script: string
}

/** Facts returned when a job is read. */
export interface JobView {
  readonly job: JobRecord
  readonly artifacts: readonly ArtifactRecord[]
}

/** Audit sink for fusion job events. */
export type JobAuditSink = (event: {
  readonly action: string
  readonly outcome: 'success' | 'failure'
  readonly userId: string
  readonly jobId: string
  readonly errorCode: string | null
}) => void

/** Runs analysis jobs and records their provenance. */
export class JobService {
  private readonly config: IntegrationConfig
  private readonly store: IntegrationStore
  private readonly snapshots: SnapshotService
  private readonly workspaces: WorkspaceService
  private readonly runner: AnalysisJobRunner
  private readonly adapters: ReadonlyMap<string, HostAdapter>
  private readonly audit: JobAuditSink | undefined
  private readonly active = new Map<string, Promise<void>>()
  private readonly now: () => number
  private closed = false

  /**
   * @param parts - resolved collaborators.
   */
  constructor(parts: {
    readonly config: IntegrationConfig
    readonly store: IntegrationStore
    readonly snapshots: SnapshotService
    readonly workspaces: WorkspaceService
    readonly runner: AnalysisJobRunner
    readonly adapters: ReadonlyMap<string, HostAdapter>
    readonly audit?: JobAuditSink | undefined
    readonly now?: (() => number) | undefined
  }) {
    this.config = parts.config
    this.store = parts.store
    this.snapshots = parts.snapshots
    this.workspaces = parts.workspaces
    this.runner = parts.runner
    this.adapters = parts.adapters
    this.audit = parts.audit
    this.now = parts.now ?? Date.now
  }

  /**
   * Validate and enqueue one analysis job.
   * @param actor - validated session identity.
   * @param request - workspace, snapshots, language, and script.
   * @returns the queued job.
   */
  async start(actor: IntegrationActor, request: StartJobRequest): Promise<JobRecord> {
    if (this.closed) throw new IntegrationError('integration-blocked', 'integration service is closed', 503)
    const scriptBytes = new TextEncoder().encode(request.script)
    if (scriptBytes.byteLength === 0 || scriptBytes.byteLength > this.config.maxScriptBytes) {
      throw new IntegrationError('invalid-request', 'analysis script is empty or too large', 413)
    }
    if (request.inputSnapshotIds.length === 0 || request.inputSnapshotIds.length > 32) {
      throw new IntegrationError('invalid-request', 'between 1 and 32 input snapshots are required')
    }
    if (this.store.countActiveJobs(actor.userId) >= this.config.maxActiveJobsPerUser) {
      throw new IntegrationError('job-limit', 'too many active analysis jobs', 429)
    }
    const workspace = this.workspaces.require(actor, request.workspaceId)
    const uniqueIds = [...new Set(request.inputSnapshotIds)]
    const snapshots = this.store.findSnapshots(uniqueIds, actor.userId)
    if (snapshots.length !== uniqueIds.length) {
      throw new IntegrationError('resource-not-found', 'an input snapshot is unknown', 404)
    }
    for (const snapshot of snapshots) {
      if (snapshot.policyEpoch !== actor.permissionVersion) {
        throw new IntegrationError('resource-forbidden', 'snapshot permission epoch changed', 403)
      }
      const adapter = this.adapters.get(snapshot.locator.systemId)
      if (adapter === undefined) {
        throw new IntegrationError('resource-forbidden', 'snapshot connector is no longer available', 403)
      }
      await adapter.authorize(actor, snapshot.locator, 'read')
    }
    const job: JobRecord = {
      id: newObjectId(),
      ownerUserId: actor.userId,
      sessionId: actor.sessionId,
      workspaceId: workspace.id,
      inputSnapshotIds: uniqueIds,
      language: request.language,
      scriptSha256: sha256Hex(scriptBytes),
      status: 'queued',
      createdAt: new Date(this.now()).toISOString(),
      startedAt: null,
      finishedAt: null,
      errorCode: null,
    }
    this.store.insertJob(job)
    const completion = this.execute(actor, job, workspace, snapshots, request.script)
    this.active.set(job.id, completion)
    void completion.finally(() => {
      this.active.delete(job.id)
    })
    return job
  }

  /**
   * Report one owner-scoped job and its artifacts.
   * @param actor - validated session identity.
   * @param jobId - job id.
   * @returns the job view.
   */
  get(actor: IntegrationActor, jobId: string): JobView {
    const job = this.store.findJob(jobId, actor.userId)
    if (job === undefined) throw new IntegrationError('job-not-found', 'unknown job', 404)
    return { job, artifacts: this.store.listArtifacts(job.id, actor.userId) }
  }

  /**
   * List the actor's jobs.
   * @param actor - validated session identity.
   * @returns jobs newest first.
   */
  list(actor: IntegrationActor): JobRecord[] {
    return this.store.listJobs(actor.userId)
  }

  /**
   * Cancel one owner-scoped job and remove its container.
   * @param actor - validated session identity.
   * @param jobId - job id.
   * @returns the updated job.
   */
  async cancel(actor: IntegrationActor, jobId: string): Promise<JobRecord> {
    const job = this.store.findJob(jobId, actor.userId)
    if (job === undefined) throw new IntegrationError('job-not-found', 'unknown job', 404)
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') return job
    await this.runner.cancel(jobId)
    const updated = this.store.updateJob(jobId, {
      status: 'cancelled',
      finishedAt: new Date(this.now()).toISOString(),
      errorCode: 'job-cancelled',
    })
    this.auditEvent('JOB_CANCELLED', 'success', actor.userId, jobId, null)
    return updated ?? job
  }

  /**
   * Read one owner-scoped artifact from disk.
   * @param actor - validated session identity.
   * @param artifactId - artifact id.
   * @returns the artifact metadata and bytes.
   */
  artifact(actor: IntegrationActor, artifactId: string): { artifact: ArtifactRecord; bytes: Uint8Array } {
    const artifact = this.store.findArtifact(artifactId, actor.userId)
    if (artifact === undefined) throw new IntegrationError('artifact-not-found', 'unknown artifact', 404)
    const workspace = this.workspaces.require(actor, artifact.workspaceId)
    const path = this.workspaces.artifactPath(workspace, artifact.jobId, artifact.relativePath)
    let bytes: Uint8Array
    try {
      bytes = readRegularFile(path, MAX_ARTIFACT_BYTES)
    } catch {
      throw new IntegrationError('artifact-not-found', 'artifact bytes are unavailable', 404)
    }
    if (sha256Hex(bytes) !== artifact.sha256) {
      throw new IntegrationError('storage-failed', 'artifact hash no longer matches', 500)
    }
    return { artifact, bytes }
  }

  /**
   * Wait for one job to settle; used by tests and shutdown.
   * @param jobId - job id.
   */
  async wait(jobId: string): Promise<void> {
    await this.active.get(jobId)
  }

  /** Cancel active containers and wait for in-flight executions. */
  async close(): Promise<void> {
    this.closed = true
    for (const jobId of [...this.active.keys()]) {
      await this.runner.cancel(jobId).catch(() => false)
    }
    await Promise.allSettled([...this.active.values()])
    await this.runner.close()
  }

  /**
   * Prepare inputs and execute one job.
   * @param actor - validated session identity.
   * @param job - queued job.
   * @param workspace - owner-verified workspace.
   * @param snapshots - owner-verified snapshots.
   * @param script - analysis script text.
   */
  private async execute(
    actor: IntegrationActor,
    job: JobRecord,
    workspace: WorkspaceRecord,
    snapshots: readonly SnapshotRecord[],
    script: string,
  ): Promise<void> {
    const jobRoot = resolveWithin(this.config.jobsRoot, actor.userId, job.id)
    const inputs = join(jobRoot, 'inputs')
    const scratch = join(jobRoot, 'scratch')
    try {
      mkdirSync(inputs, { recursive: true })
      mkdirSync(scratch, { recursive: true })
      const scriptName = job.language === 'python' ? 'run.py' : 'run.sh'
      writeNewFile(join(scratch, scriptName), new TextEncoder().encode(script))
      for (const [index, snapshot] of snapshots.entries()) {
        this.snapshots.stage(snapshot, inputs, index)
      }
      const output = this.workspaces.jobOutputDirectory(workspace, job.id)
      this.store.updateJob(job.id, { status: 'running', startedAt: new Date(this.now()).toISOString() })
      this.auditEvent('JOB_START', 'success', actor.userId, job.id, null)
      const result = await this.runner.run({
        jobId: job.id,
        inputsDirectory: inputs,
        outputDirectory: output,
        scratchDirectory: scratch,
        language: job.language,
      })
      if (result.exitCode !== 0) {
        this.store.updateJob(job.id, {
          status: 'failed',
          finishedAt: new Date(this.now()).toISOString(),
          errorCode: 'JOB_EXITED',
        })
        this.auditEvent('JOB_FINISH', 'failure', actor.userId, job.id, 'JOB_EXITED')
        return
      }
      this.collectArtifacts(job, workspace, output)
      this.store.updateJob(job.id, {
        status: 'succeeded',
        finishedAt: new Date(this.now()).toISOString(),
        errorCode: null,
      })
      this.auditEvent('JOB_FINISH', 'success', actor.userId, job.id, null)
    } catch (error) {
      const code = error instanceof IntegrationError ? error.code : 'job-failed'
      this.store.updateJob(job.id, {
        status: 'failed',
        finishedAt: new Date(this.now()).toISOString(),
        errorCode: code,
      })
      this.auditEvent('JOB_FINISH', 'failure', actor.userId, job.id, code)
    }
  }

  /**
   * Record every regular output file as an artifact.
   * @param job - completed job.
   * @param workspace - owner-verified workspace.
   * @param output - job output directory.
   */
  private collectArtifacts(job: JobRecord, workspace: WorkspaceRecord, output: string): void {
    const files = listRegularFiles(output, MAX_ARTIFACTS)
    for (const file of files) {
      const path = this.workspaces.artifactPath(workspace, job.id, file.relativePath)
      const bytes = readRegularFile(path, MAX_ARTIFACT_BYTES)
      this.store.insertArtifact({
        id: newObjectId(),
        jobId: job.id,
        workspaceId: workspace.id,
        ownerUserId: job.ownerUserId,
        relativePath: file.relativePath,
        sha256: sha256Hex(bytes),
        mime: mimeForPath(file.relativePath),
        size: bytes.byteLength,
        createdAt: new Date(this.now()).toISOString(),
        downloadScope: 'owner',
      })
    }
  }

  /**
   * Emit one job audit event without failing the job.
   * @param action - stable action name.
   * @param outcome - success or failure.
   * @param userId - owner internal id.
   * @param jobId - job id.
   * @param errorCode - stable failure code, or null.
   */
  private auditEvent(
    action: string,
    outcome: 'success' | 'failure',
    userId: string,
    jobId: string,
    errorCode: string | null,
  ): void {
    if (this.audit === undefined) return
    try {
      this.audit({ action, outcome, userId, jobId, errorCode })
    } catch {
      // Audit delivery is best effort and must never change job lifecycle.
    }
  }
}
