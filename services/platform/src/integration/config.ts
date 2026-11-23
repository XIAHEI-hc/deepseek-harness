/**
 * Optional system-fusion configuration.
 *
 * Fusion is off by default. This module parses only structural settings; whether
 * every safety prerequisite is actually present is decided by the preflight in
 * `preflight.ts`, so a partially configured deployment can keep the native
 * platform running while every fusion route stays blocked.
 *
 * @module @deepseek-ai/dsh-platform-services/integration/config
 */

import { resolve } from 'node:path'
import type { AppEnv } from '../config.ts'

/** How an analysis job is executed. Production requires `container`. */
export type IntegrationRunnerKind = 'process' | 'container'

/** System-fusion settings resolved from the deployment environment. */
export interface IntegrationConfig {
  /** Deployment environment class, copied for preflight decisions. */
  readonly appEnv: AppEnv
  /** Master switch; false leaves every fusion entry point absent. */
  readonly enabled: boolean
  /** Administrator-maintained system registry file. */
  readonly systemsFile: string
  /** Directory holding immutable input snapshots. */
  readonly snapshotsRoot: string
  /** Directory holding per-user, per-workspace analysis outputs. */
  readonly workspacesRoot: string
  /** Directory holding per-job scratch and input staging. */
  readonly jobsRoot: string
  /** Metadata database file for snapshots, workspaces, jobs, and artifacts. */
  readonly databaseFile: string
  /** How an analysis job runs; production rejects `process`. */
  readonly runnerKind: IntegrationRunnerKind
  /** Fixed analysis image; empty blocks container jobs until configured. */
  readonly jobImage: string
  /** Docker CLI used by the container runner. */
  readonly dockerCommand: string
  /** Gateway URL a runtime tool calls; empty lets the composition root choose. */
  readonly runtimeApiUrl: string
  /** Network mode or network name for an analysis container. */
  readonly jobNetwork: string
  /** Numeric UID/GID the analysis container runs as. */
  readonly jobUid: number
  /** CPU limit passed to the analysis container. */
  readonly jobCpuLimit: string
  /** Memory limit in megabytes. */
  readonly jobMemoryMb: number
  /** Process-count limit. */
  readonly jobPidsLimit: number
  /** Longest accepted job runtime before the runner kills the container. */
  readonly jobTimeoutMs: number
  /** Concurrent active jobs allowed per user. */
  readonly maxActiveJobsPerUser: number
  /** Largest accepted snapshot body in bytes. */
  readonly maxSnapshotBytes: number
  /** Largest accepted analysis script in bytes. */
  readonly maxScriptBytes: number
  /** HTTP adapter request timeout. */
  readonly httpTimeoutMs: number
  /** Largest accepted HTTP adapter response body. */
  readonly httpMaxBytes: number
}

/** Structural facts the integration parser needs from the platform configuration. */
export interface IntegrationConfigDefaults {
  readonly appEnv: AppEnv
  readonly dataDir: string
  readonly runtimeDockerCommand: string
}

/** Raised when a fusion environment value is structurally invalid. */
export class IntegrationConfigError extends Error {
  /** @param message - human-actionable description of the invalid value. */
  constructor(message: string) {
    super(message)
    this.name = 'IntegrationConfigError'
  }
}

/**
 * Read one environment value.
 * @param env - environment mapping.
 * @param name - variable name.
 * @param fallback - value when unset or blank.
 * @returns the trimmed value or fallback.
 */
function read(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name]
  if (value === undefined || value.trim() === '') return fallback
  return value.trim()
}

/**
 * Parse a boolean environment flag.
 * @param raw - raw value.
 * @param name - variable name for errors.
 * @returns the parsed boolean.
 * @throws {IntegrationConfigError} when the value is not a recognized boolean.
 */
function parseBoolean(raw: string, name: string): boolean {
  const normalized = raw.toLowerCase()
  if (['true', '1', 'yes'].includes(normalized)) return true
  if (['false', '0', 'no'].includes(normalized)) return false
  throw new IntegrationConfigError(`${name} must be a boolean, got ${JSON.stringify(raw)}`)
}

/**
 * Parse a positive integer environment value.
 * @param raw - raw value.
 * @param name - variable name for errors.
 * @param fallback - value used when blank.
 * @returns the positive integer.
 * @throws {IntegrationConfigError} when the value is not a positive integer.
 */
function parsePositiveInteger(raw: string, name: string, fallback: number): number {
  if (raw === '') return fallback
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new IntegrationConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return Number(raw)
}

/**
 * Validate a Docker network selection.
 * @param network - configured network text.
 * @returns the network text.
 * @throws {IntegrationConfigError} when the selection would grant host or shared network access.
 */
function parseJobNetwork(network: string): string {
  if (network === 'none') return network
  if (!/^[a-zA-Z0-9_.-]+$/.test(network)) {
    throw new IntegrationConfigError('DSH_INTEGRATION_JOB_NETWORK must be `none` or a dedicated network name')
  }
  if (network === 'host' || network === 'bridge' || network === 'default') {
    throw new IntegrationConfigError('DSH_INTEGRATION_JOB_NETWORK must not select a host or shared Docker network')
  }
  return network
}

/**
 * Resolve fusion configuration from an environment mapping.
 * @param env - environment mapping.
 * @param defaults - platform facts used for default paths and the Docker command.
 * @returns the resolved fusion configuration.
 * @throws {IntegrationConfigError} when a value is structurally invalid or unsafe for the environment.
 */
export function loadIntegrationConfig(
  env: NodeJS.ProcessEnv,
  defaults: IntegrationConfigDefaults,
): IntegrationConfig {
  const enabled = parseBoolean(read(env, 'DSH_INTEGRATION_ENABLED', 'false'), 'DSH_INTEGRATION_ENABLED')
  const production = defaults.appEnv === 'production'
  const dataDir = resolve(read(env, 'DSH_INTEGRATION_DATA_DIR', resolve(defaults.dataDir, 'integration')))
  if (!enabled) {
    // A disabled feature must not fail startup because of stale fusion settings.
    return {
      appEnv: defaults.appEnv,
      enabled: false,
      systemsFile: resolve(read(env, 'DSH_INTEGRATION_SYSTEMS_FILE', resolve(dataDir, 'systems.json'))),
      snapshotsRoot: resolve(read(env, 'DSH_INTEGRATION_SNAPSHOTS_DIR', resolve(dataDir, 'snapshots'))),
      workspacesRoot: resolve(read(env, 'DSH_INTEGRATION_WORKSPACES_DIR', resolve(dataDir, 'workspaces'))),
      jobsRoot: resolve(read(env, 'DSH_INTEGRATION_JOBS_DIR', resolve(dataDir, 'jobs'))),
      databaseFile: resolve(read(env, 'DSH_INTEGRATION_DATABASE_FILE', resolve(dataDir, 'integration.sqlite'))),
      runnerKind: production ? 'container' : 'process',
      jobImage: '',
      dockerCommand: defaults.runtimeDockerCommand,
      runtimeApiUrl: '',
      jobNetwork: 'none',
      jobUid: 1000,
      jobCpuLimit: '1',
      jobMemoryMb: 1024,
      jobPidsLimit: 256,
      jobTimeoutMs: 900_000,
      maxActiveJobsPerUser: 2,
      maxSnapshotBytes: 16 * 1024 * 1024,
      maxScriptBytes: 256 * 1024,
      httpTimeoutMs: 15_000,
      httpMaxBytes: 16 * 1024 * 1024,
    }
  }
  const runnerRaw = read(env, 'DSH_INTEGRATION_JOB_RUNNER_KIND', production ? 'container' : 'process')
  if (runnerRaw !== 'process' && runnerRaw !== 'container') {
    throw new IntegrationConfigError(
      `DSH_INTEGRATION_JOB_RUNNER_KIND must be process or container, got ${JSON.stringify(runnerRaw)}`,
    )
  }
  if (production && enabled && runnerRaw !== 'container') {
    throw new IntegrationConfigError(
      'DSH_INTEGRATION_JOB_RUNNER_KIND must be container in production; process isolation is not a fusion boundary',
    )
  }
  const jobImage = read(env, 'DSH_INTEGRATION_JOB_IMAGE', '')
  const jobNetwork = parseJobNetwork(read(env, 'DSH_INTEGRATION_JOB_NETWORK', 'none'))
  const config: IntegrationConfig = {
    appEnv: defaults.appEnv,
    enabled,
    systemsFile: resolve(read(env, 'DSH_INTEGRATION_SYSTEMS_FILE', resolve(dataDir, 'systems.json'))),
    snapshotsRoot: resolve(read(env, 'DSH_INTEGRATION_SNAPSHOTS_DIR', resolve(dataDir, 'snapshots'))),
    workspacesRoot: resolve(read(env, 'DSH_INTEGRATION_WORKSPACES_DIR', resolve(dataDir, 'workspaces'))),
    jobsRoot: resolve(read(env, 'DSH_INTEGRATION_JOBS_DIR', resolve(dataDir, 'jobs'))),
    databaseFile: resolve(read(env, 'DSH_INTEGRATION_DATABASE_FILE', resolve(dataDir, 'integration.sqlite'))),
    runnerKind: runnerRaw,
    jobImage,
    dockerCommand: read(env, 'DSH_INTEGRATION_DOCKER_COMMAND', defaults.runtimeDockerCommand),
    runtimeApiUrl: read(env, 'DSH_INTEGRATION_RUNTIME_API_URL', ''),
    jobNetwork,
    jobUid: parsePositiveInteger(read(env, 'DSH_INTEGRATION_JOB_UID', ''), 'DSH_INTEGRATION_JOB_UID', 1000),
    jobCpuLimit: read(env, 'DSH_INTEGRATION_JOB_CPU_LIMIT', '1'),
    jobMemoryMb: parsePositiveInteger(read(env, 'DSH_INTEGRATION_JOB_MEMORY_MB', ''), 'DSH_INTEGRATION_JOB_MEMORY_MB', 1024),
    jobPidsLimit: parsePositiveInteger(read(env, 'DSH_INTEGRATION_JOB_PIDS_LIMIT', ''), 'DSH_INTEGRATION_JOB_PIDS_LIMIT', 256),
    jobTimeoutMs:
      parsePositiveInteger(read(env, 'DSH_INTEGRATION_JOB_TIMEOUT_SECONDS', ''), 'DSH_INTEGRATION_JOB_TIMEOUT_SECONDS', 900) *
      1000,
    maxActiveJobsPerUser: parsePositiveInteger(
      read(env, 'DSH_INTEGRATION_MAX_ACTIVE_JOBS', ''),
      'DSH_INTEGRATION_MAX_ACTIVE_JOBS',
      2,
    ),
    maxSnapshotBytes: parsePositiveInteger(
      read(env, 'DSH_INTEGRATION_MAX_SNAPSHOT_BYTES', ''),
      'DSH_INTEGRATION_MAX_SNAPSHOT_BYTES',
      16 * 1024 * 1024,
    ),
    maxScriptBytes: parsePositiveInteger(
      read(env, 'DSH_INTEGRATION_MAX_SCRIPT_BYTES', ''),
      'DSH_INTEGRATION_MAX_SCRIPT_BYTES',
      256 * 1024,
    ),
    httpTimeoutMs:
      parsePositiveInteger(read(env, 'DSH_INTEGRATION_HTTP_TIMEOUT_MS', ''), 'DSH_INTEGRATION_HTTP_TIMEOUT_MS', 15_000),
    httpMaxBytes: parsePositiveInteger(
      read(env, 'DSH_INTEGRATION_HTTP_MAX_BYTES', ''),
      'DSH_INTEGRATION_HTTP_MAX_BYTES',
      16 * 1024 * 1024,
    ),
  }
  return config
}
