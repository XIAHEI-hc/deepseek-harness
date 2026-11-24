/**
 * Optional host-fusion analysis service.
 *
 * @module @deepseek-ai/dsh-platform-services/integration
 */

export { createIntegrationService, INTEGRATION_API_PREFIX } from './service.ts'
export type { IntegrationServiceOptions, IntegrationAuditSink } from './service.ts'
export { loadIntegrationConfig, IntegrationConfigError } from './config.ts'
export type { IntegrationConfig, IntegrationRunnerKind } from './config.ts'
export { runPreflight } from './preflight.ts'
export type { PreflightResult, PreflightOptions } from './preflight.ts'
export type {
  ArtifactRecord,
  HostAdapter,
  IntegrationActor,
  IntegrationIssue,
  IntegrationState,
  IntegrationStatus,
  IntegrationSystemView,
  JobRecord,
  JobStatus,
  ResourceAction,
  ResourceGrant,
  ResourceLocator,
  ResourcePage,
  ResourceType,
  ResourceView,
  SnapshotRecord,
  WorkspaceRecord,
} from './types.ts'
