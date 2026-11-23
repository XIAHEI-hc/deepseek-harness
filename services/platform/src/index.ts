/**
 * Public composition surface of the DSH platform services.
 * @module @deepseek-ai/dsh-platform-services
 */

export { createPlatformApp, type PlatformApp } from './app.ts'
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
