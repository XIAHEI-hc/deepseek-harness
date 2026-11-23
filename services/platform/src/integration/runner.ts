/**
 * Physical analysis-job execution.
 *
 * Every job runs in a short-lived, unprivileged container with a read-only root
 * filesystem, read-only inputs, a writable per-job output directory, a writable
 * private scratch directory, no capabilities, no host mounts beyond those three
 * directories, and `--network none` unless a reviewed broker network is
 * configured. The Docker CLI is the authority for these flags; service code
 * cannot widen them from a session.
 *
 * @module @deepseek-ai/dsh-platform-services/integration/runner
 */

import { createDefaultDockerExecutor } from '../runtime/container-backend.ts'
import type { DockerCommandResult, DockerExecutor } from '../runtime/backend.ts'
import type { IntegrationConfig } from './config.ts'
import type { JobLanguage } from './types.ts'

/** Bytes of container stdout/stderr retained for local diagnostics. */
const MAX_CAPTURED_OUTPUT = 64 * 1024

/** One analysis container invocation. */
export interface AnalysisRunSpec {
  readonly jobId: string
  readonly inputsDirectory: string
  readonly outputDirectory: string
  readonly scratchDirectory: string
  readonly language: JobLanguage
}

/** Outcome of one container invocation. */
export interface AnalysisRunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Injectable executor and clock for tests. */
export interface AnalysisRunnerOptions {
  readonly executor?: DockerExecutor | undefined
}

/**
 * Derive the stable container name of one job.
 * @param jobId - job UUID.
 * @returns a Docker-safe name.
 */
export function analysisContainerName(jobId: string): string {
  return `dsh-analysis-${jobId.replaceAll('-', '').slice(0, 24)}`
}

/**
 * Build the complete `docker run` argv for one analysis job.
 * @param config - fusion configuration with image, limits, and network.
 * @param spec - job paths and language.
 * @returns the Docker CLI argv.
 */
export function buildAnalysisRunArguments(config: IntegrationConfig, spec: AnalysisRunSpec): string[] {
  const command = spec.language === 'python'
    ? ['python3', '/scratch/run.py']
    : ['/bin/sh', '/scratch/run.sh']
  return [
    'run',
    '--rm',
    '--name',
    analysisContainerName(spec.jobId),
    '--label',
    `dsh.integration.job=${spec.jobId}`,
    '--network',
    config.jobNetwork,
    '--read-only',
    '--user',
    `${String(config.jobUid)}:${String(config.jobUid)}`,
    '--cpus',
    config.jobCpuLimit,
    '--memory',
    `${String(config.jobMemoryMb)}m`,
    '--pids-limit',
    String(config.jobPidsLimit),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--ulimit',
    'nofile=256:256',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '-v',
    `${spec.inputsDirectory}:/inputs:ro`,
    '-v',
    `${spec.outputDirectory}:/work:rw`,
    '-v',
    `${spec.scratchDirectory}:/scratch:rw`,
    '-w',
    '/work',
    '-e',
    'HOME=/scratch',
    '-e',
    'TMPDIR=/tmp',
    '-e',
    'NO_COLOR=1',
    // Clear any image entrypoint so the command below is the whole job. A fixed
    // image must not be able to substitute a different process.
    '--entrypoint',
    '',
    config.jobImage,
    ...command,
  ]
}

/**
 * Truncate captured process output for logs.
 * @param value - raw output.
 * @returns the leading bytes with a truncation marker.
 */
function truncate(value: string): string {
  if (value.length <= MAX_CAPTURED_OUTPUT) return value
  return `${value.slice(0, MAX_CAPTURED_OUTPUT)}\n[truncated]`
}

/** Runs and cancels analysis containers. */
export class AnalysisJobRunner {
  private readonly config: IntegrationConfig
  private readonly executor: DockerExecutor
  private readonly active = new Map<string, string>()

  /**
   * @param config - fusion configuration.
   * @param options - injectable Docker executor.
   */
  constructor(config: IntegrationConfig, options: AnalysisRunnerOptions = {}) {
    this.config = config
    this.executor = options.executor ?? createDefaultDockerExecutor(config.dockerCommand, {
      timeoutMs: config.jobTimeoutMs + 30_000,
    })
  }

  /**
   * Run one job to completion.
   * @param spec - prepared job paths and language.
   * @returns the container exit code and captured diagnostics.
   * @throws when the container runner is not permitted by configuration.
   */
  async run(spec: AnalysisRunSpec): Promise<AnalysisRunResult> {
    if (this.config.runnerKind !== 'container') {
      throw new Error('analysis jobs require the container runner')
    }
    if (this.config.jobImage === '') throw new Error('analysis job image is not configured')
    const name = analysisContainerName(spec.jobId)
    this.active.set(spec.jobId, name)
    try {
      const result: DockerCommandResult = await this.executor(buildAnalysisRunArguments(this.config, spec))
      if (result.exitCode !== 0) await this.removeContainer(name)
      return {
        exitCode: result.exitCode,
        stdout: truncate(result.stdout),
        stderr: truncate(result.stderr),
      }
    } catch (error) {
      // A killed Docker client can leave the container running; the launch flags
      // still bound it, but a failed job must not retain a writable container.
      await this.removeContainer(name)
      throw error
    } finally {
      this.active.delete(spec.jobId)
    }
  }

  /**
   * Remove one container, ignoring an already-absent one.
   * @param name - container name.
   */
  private async removeContainer(name: string): Promise<void> {
    // Removal is best effort; the container keeps its original launch flags.
    await this.executor(['rm', '-f', name]).catch((error: unknown) => { void error })
  }

  /**
   * Force-remove one job container.
   * @param jobId - job id.
   * @returns true when a container removal command ran.
   */
  async cancel(jobId: string): Promise<boolean> {
    const name = this.active.get(jobId) ?? analysisContainerName(jobId)
    this.active.delete(jobId)
    // Removing an already absent container is not a cancellation failure.
    return await this.executor(['rm', '-f', name]).then(
      () => true,
      (error: unknown) => { void error; return false },
    )
  }

  /** Force-remove every container this runner started. */
  async close(): Promise<void> {
    const names = [...this.active.values()]
    this.active.clear()
    for (const name of names) {
      // Shutdown best effort: a surviving container is still bound by its
      // launch flags and the next preflight reports the daemon state.
      await this.executor(['rm', '-f', name]).catch((error: unknown) => { void error })
    }
  }
}
