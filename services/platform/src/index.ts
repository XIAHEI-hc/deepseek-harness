/**
 * Public composition surface of the DSH platform services.
 * @module @deepseek-ai/dsh-platform-services
 */

export { createPlatformApp, type PlatformApp } from './app.ts'
export { migrateHome, MigrationError, type MigrateHomeEntry, type MigrateHomeOptions, type MigrateHomeReport, type MigrationFailureCode } from './admin/migrate-home.ts'
export {
  disableUser,
  enableUser,
  revokeAllUserSessions,
  UserAdminError,
  type UserAdminFailureCode,
  type UserAdminReport,
  type UserAdminRequest,
} from './admin/users.ts'
export { findPlatformUserById, findPlatformUserBySubject } from './identity/lookup.ts'
export {
  createPlatformConfig,
  ensureGatewayKeyPair,
  loadPlatformConfig,
  PlatformConfigError,
  DEFAULT_LOGIN_PATH,
  DEFAULT_RUNTIME_PATCH_FILE,
  type AppEnv,
  type AuthMode,
  type GatewayConfig,
  type IdentityConfig,
  type MockIdentityConfig,
  type PlatformConfig,
  type PlatformConfigOverrides,
  type RuntimeConfig,
  type RuntimeKind,
  type W3Config,
} from './config.ts'
export type {
  GatewayIdentity,
  IdentityFailureCode,
  IdentityService,
  PlatformHeaders,
  PlatformHttpRequest,
  PlatformHttpResult,
  PlatformUser,
  RuntimeEnsureResult,
  RuntimeManager,
  RuntimeState,
  RuntimeStatusView,
  RuntimeTarget,
  SessionLookup,
  SetCookie,
  ValidatedSession,
} from './contracts.ts'
