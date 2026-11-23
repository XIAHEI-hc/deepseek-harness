/**
 * Read-only administrative status for the optional fusion service.
 *
 * The command opens the integration database and runs the same preflight the
 * server would run, without starting the gateway or any analysis container.
 *
 * @module @deepseek-ai/dsh-platform-services/admin/integration
 */

import type { PlatformConfig } from '../config.ts'
import { runPreflight, type PreflightOptions } from '../integration/preflight.ts'
import { IntegrationStore } from '../integration/store.ts'
import type { IntegrationIssue, IntegrationState, JobRecord } from '../integration/types.ts'

/** One integration status report. */
export interface IntegrationStatusReport {
  readonly enabled: boolean
  readonly state: IntegrationState
  readonly systems: number
  readonly issues: readonly IntegrationIssue[]
  readonly counts: {
    readonly workspaces: number
    readonly snapshots: number
    readonly jobs: number
    readonly artifacts: number
    readonly activeJobs: number
  } | null
}

/**
 * Read fusion configuration state and metadata counts.
 * @param config - resolved platform configuration.
 * @param options - preflight probe overrides used by tests.
 * @returns the status report.
 */
export async function readIntegrationStatus(
  config: PlatformConfig,
  options: PreflightOptions = {},
): Promise<IntegrationStatusReport> {
  if (!config.integration.enabled) {
    return {
      enabled: false,
      state: 'disabled',
      systems: 0,
      issues: [],
      counts: null,
    }
  }
  const preflight = await runPreflight(config.integration, options)
  let counts: IntegrationStatusReport['counts'] = null
  try {
    const store = IntegrationStore.open(config.integration.databaseFile)
    try {
      counts = store.stats()
    } finally {
      store.close()
    }
  } catch (error) {
    void error
    // The status command still reports preflight issues when the database
    // cannot be opened; this is a read-only diagnostic surface.
  }
  return {
    enabled: true,
    state: preflight.state,
    systems: preflight.registry?.systems.length ?? 0,
    issues: preflight.issues,
    counts,
  }
}

/**
 * List recent fusion jobs across users for local operational inspection.
 * @param config - resolved platform configuration.
 * @param limit - maximum rows.
 * @returns jobs newest first, or an empty list when fusion is disabled.
 */
export function readIntegrationJobs(config: PlatformConfig, limit: number): readonly JobRecord[] {
  if (!config.integration.enabled) return []
  const store = IntegrationStore.open(config.integration.databaseFile)
  try {
    return store.listAllJobs(limit)
  } finally {
    store.close()
  }
}
