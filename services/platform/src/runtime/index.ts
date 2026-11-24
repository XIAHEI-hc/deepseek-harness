/**
 * Per-user runtime manager and supervisor for the DSH platform services.
 *
 * The public surface exposes the manager factory, both real backends, the
 * backend seam tests replace, and the space-key helpers tests assert against.
 *
 * @module @deepseek-ai/dsh-platform-services/runtime
 */

export {
  createRuntimeManager,
  type RuntimeManagerConfig,
  type RuntimeManagerOptions,
} from './manager.ts'
export { RuntimeManagerError, RuntimeBackendError, runtimeErrorCode } from './errors.ts'
export {
  createProcessBackend,
  buildProcessRuntimeId,
  parseProcessRuntimeId,
  type ProcessBackendOptions,
  type ProcessRuntimeBackend,
} from './process-backend.ts'
export {
  createDockerBackend,
  createDefaultDockerExecutor,
  containerNameForSpace,
  pickContainerIp,
  type ContainerBackendOptions,
} from './container-backend.ts'
export type {
  DockerCommandResult,
  DockerExecutor,
  HttpProbe,
  RuntimeAssertionFacts,
  RuntimeBackend,
  RuntimeInspection,
  RuntimeInstance,
  RuntimeScheduler,
  RuntimeStartSpec,
  SpawnedProcess,
  SpawnFunction,
  SpawnOptionsLike,
} from './backend.ts'
export {
  assertPathWithinRoot,
  assertUserId,
  computeSpaceKey,
  ensureRuntimeSpaceDirs,
  resolveRuntimeSpace,
  resolveRuntimeSpaceByKey,
  USER_ID_PATTERN,
  type RuntimeSpacePaths,
} from './space.ts'
export {
  RuntimeRegistry,
  type RuntimeDesiredState,
  type RuntimeRecord,
  type RuntimeRecordInput,
  type RuntimeRecordPatch,
} from './registry.ts'
export {
  RUNTIME_SCHEMA_MIGRATIONS,
  RUNTIME_SCHEMA_VERSION,
  migrateRuntimeRegistry,
  type RuntimeSchemaMigration,
} from './migrations.ts'
export { type RuntimeLog, type RuntimeLogEntry } from './support.ts'
