/**
 * Startup configuration for the DSH platform services.
 *
 * One environment is resolved into three nested configs so each service receives
 * exactly the facts it owns: identity (auth mode, session policy, W3 provider),
 * runtime (per-user instance lifecycle), and gateway (public listener, assertion
 * signing, revocation timing). Validation fails loudly at boot instead of letting
 * a production deployment start with development defaults.
 *
 * @module @deepseek-ai/dsh-platform-services/config
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Deployment environment class. */
export type AppEnv = 'development' | 'testing' | 'production'

/** Authentication mode: W3 in every deployment, Mock in development and tests only. */
export type AuthMode = 'mock' | 'w3'

/** One W3 OAuth provider configuration. */
export interface W3Config {
  readonly clientId: string
  readonly clientSecret: string
  readonly authorizeUrl: string
  readonly tokenUrl: string
  readonly userinfoUrl: string
  /** Optional W3 single-logout endpoint returned to the browser after a platform logout. */
  readonly logoutUrl: string
  readonly redirectUri: string
  readonly scope: string
  /** Request body encoding for the token exchange; the reference implementation supports both. */
  readonly tokenRequestFormat: 'json' | 'form'
}

/** One development-only Mock identity; never selectable from the browser. */
export interface MockIdentityConfig {
  readonly subject: string
  readonly uid: string
  readonly displayName: string
  readonly email: string
}

/** Identity service configuration. */
export interface IdentityConfig {
  readonly appEnv: AppEnv
  readonly mode: AuthMode
  /** Directory holding the SQLite identity database and its WAL side files. */
  readonly dataDir: string
  readonly sessionCookieName: string
  readonly csrfCookieName: string
  readonly loginNonceCookieName: string
  /** `Secure` attribute on every platform cookie; required in production. */
  readonly cookieSecure: boolean
  /** Idle lifetime in milliseconds, refreshed by activity. */
  readonly idleTimeoutMs: number
  /** Absolute session lifetime in milliseconds from login. */
  readonly absoluteTimeoutMs: number
  /** OAuth login transaction lifetime in milliseconds. */
  readonly oauthStateTtlMs: number
  /**
   * Login-attempt rate limit applied per client address. `maxAttemptsPerAddress`
   * of 0 disables limiting (development and tests); production keeps a finite
   * budget so one address cannot enumerate login starts.
   */
  readonly loginRateLimit: {
    /** Sliding window length in milliseconds. */
    readonly windowMs: number
    /** Login starts admitted per address inside one window; 0 disables. */
    readonly maxAttemptsPerAddress: number
  }
  /** Internal service key the gateway presents on `/internal/introspect`; at least 32 characters in production. */
  readonly internalApiKey: string
  readonly w3: W3Config
  readonly mock: MockIdentityConfig
}

/** How one user runtime is executed. */
export type RuntimeKind = 'process' | 'container'

/** Runtime manager and supervisor configuration. */
export interface RuntimeConfig {
  readonly kind: RuntimeKind
  /** Opaque space key HMAC secret; at least 32 characters in production. */
  readonly spaceKeySecret: string
  /** Host-side root that holds one space directory per user. */
  readonly root: string
  /** Idle seconds before a runtime without leases is stopped; data stays on disk. */
  readonly idleSeconds: number
  /** How often the idle reaper checks for reclamation, in milliseconds. */
  readonly reapIntervalMs: number
  /** Repository root whose CLI and patch the process backend launches. */
  readonly repoRoot: string
  /** Command prefix for the process backend; `web` flags are appended. */
  readonly processCommand: readonly string[]
  /** Immutable runtime image for the container backend. */
  readonly image: string
  /** Docker CLI executable the container backend invokes. */
  readonly dockerCommand: string
  /** Private container network for the container backend. */
  readonly network: string
  /** Directory inside a user container that maps to the user's host space directory. */
  readonly containerDataRoot: string
  /** Path inside a user container of the public key the runtime verifies assertions with. */
  readonly containerPublicKeyPath: string
  /** Path inside a user container of the runtime overlay file. */
  readonly containerPatchPath: string
  /** Repository root inside a user container (the runtime image's `/app`). */
  readonly containerRepoRoot: string
  /** Runtime listen port inside a user container. */
  readonly containerPort: number
  /** Numeric container UID/GID the runtime runs as. */
  readonly containerUid: number
  /** Optional explicit bind IP for the runtime listener; undefined lets the backend choose. */
  readonly bindHost: string | undefined
  /** Public host authority the runtime accepts through its browser-trust fence. */
  readonly publicAuthority: string
  /** Cordis patch overlay that disables the legacy token provider and enables the gateway provider. */
  readonly patchFile: string
  /** Longest accepted cold start in milliseconds. */
  readonly startTimeoutMs: number
  /** Per-runtime resource limits passed to the container backend. */
  readonly cpuLimit: string
  readonly memoryLimitMb: number
  readonly pidsLimit: number
  /** Longest concurrent starts the supervisor performs at once. */
  readonly maxConcurrentStarts: number
  /** URL path prefix on the runtime that the gateway serves; empty means the whole origin. */
  readonly urlBasePath: string
}

/** Gateway (public ingress) configuration. */
export interface GatewayConfig {
  readonly listenHost: string
  readonly listenPort: number
  /** Public HTTP(S) origin the browser uses; cookies and redirects are built from it. */
  readonly publicOrigin: string
  readonly issuer: string
  readonly audience: string
  readonly keyId: string
  /** PEM Ed25519 private key the gateway signs assertions with. */
  readonly privateKeyFile: string
  /** PEM Ed25519 public key the runtime verifies assertions with. */
  readonly publicKeyFile: string
  /** Assertion lifetime in seconds; the runtime accepts at most `maxLifetimeSeconds`. */
  readonly assertionTtlSeconds: number
  /** Longest assertion lifetime the runtime policy accepts, in seconds. */
  readonly maxAssertionLifetimeSeconds: number
  /** WebSocket session revalidation period in seconds. */
  readonly wsRevalidateSeconds: number
  /** Version 2 assertion replay window the runtime keeps, in seconds. */
  readonly replayWindowSeconds: number
  /** Public path of the platform login page. */
  readonly loginPath: string
  /** Longest accepted request body for buffered non-streaming surfaces, in bytes. */
  readonly maxBodyBytes: number
  /** Whether a missing key pair is generated on first start; development and tests only. */
  readonly generateKeyPairIfMissing: boolean
}

/** Fully resolved platform configuration. */
export interface PlatformConfig {
  readonly appEnv: AppEnv
  readonly realm: string
  readonly dataDir: string
  readonly identity: IdentityConfig
  readonly runtime: RuntimeConfig
  readonly gateway: GatewayConfig
}

/** Per-section overrides accepted by {@link createPlatformConfig}. */
export interface PlatformConfigOverrides {
  readonly appEnv?: AppEnv
  readonly realm?: string
  readonly dataDir?: string
  readonly identity?: Partial<IdentityConfig>
  readonly runtime?: Partial<RuntimeConfig>
  readonly gateway?: Partial<GatewayConfig>
}

/** Raised when startup configuration is incomplete or unsafe for its environment. */
export class PlatformConfigError extends Error {
  /** @param message - human-actionable description of the invalid configuration. */
  constructor(message: string) {
    super(message)
    this.name = 'PlatformConfigError'
  }
}

/** Default repository-relative runtime patch overlay. */
export const DEFAULT_RUNTIME_PATCH_FILE = 'deploy/runtime/platform-runtime.patch.yml'
/** Runtime idle timeout default: thirty minutes. */
const DEFAULT_IDLE_SECONDS = 1800
/** Development gateway port. */
const DEFAULT_GATEWAY_PORT = 8080
/** WebSocket revalidation default: twenty seconds. */
const DEFAULT_WS_REVALIDATE_SECONDS = 20
/** Assertion lifetime default: sixty seconds. */
const DEFAULT_ASSERTION_TTL_SECONDS = 60
/** Runtime policy maximum assertion lifetime; the runtime overlay repeats this value. */
const DEFAULT_MAX_ASSERTION_LIFETIME_SECONDS = 300
/** Replay window default: sixty seconds. */
const DEFAULT_REPLAY_WINDOW_SECONDS = 60
/** Login page path served by the gateway. */
export const DEFAULT_LOGIN_PATH = '/login'
/** Longest buffered request body the gateway accepts for platform JSON surfaces. */
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024
/** Absolute session lifetime default: twelve hours. */
const DEFAULT_ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000
/** Idle session lifetime default: two hours. */
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000
/** OAuth login transaction lifetime default: ten minutes. */
const DEFAULT_OAUTH_STATE_TTL_MS = 10 * 60 * 1000
/** Login attempt budget per address inside one window. */
const DEFAULT_LOGIN_RATE_LIMIT_MAX = 30
/** Login attempt rate-limit window default: one minute. */
const DEFAULT_LOGIN_RATE_LIMIT_WINDOW_MS = 60 * 1000

/**
 * Read one environment value.
 * @param env - environment mapping.
 * @param name - variable name.
 * @param fallback - value when the variable is unset or blank.
 * @returns the trimmed value or the fallback.
 */
function readEnv(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name]
  if (value === undefined || value.trim() === '') return fallback
  return value.trim()
}

/**
 * Read one required environment value.
 * @param env - environment mapping.
 * @param name - variable name.
 * @param problems - collector that receives the missing-variable message.
 * @returns the value, or an empty string when absent.
 */
function readRequiredEnv(env: NodeJS.ProcessEnv, name: string, problems: string[]): string {
  const value = readEnv(env, name, '')
  if (value === '') problems.push(`${name} is required`)
  return value
}

/**
 * Parse a boolean environment flag.
 * @param value - raw value.
 * @param name - variable name for the error message.
 * @returns the parsed boolean.
 * @throws {PlatformConfigError} when the value is not a recognized boolean.
 */
function parseBoolean(value: string, name: string): boolean {
  const normalized = value.toLowerCase()
  if (['true', '1', 'yes'].includes(normalized)) return true
  if (['false', '0', 'no'].includes(normalized)) return false
  throw new PlatformConfigError(`${name} must be a boolean, got ${JSON.stringify(value)}`)
}

/**
 * Parse a non-negative integer environment value.
 * @param raw - raw value.
 * @param name - variable name for the error message.
 * @param fallback - value when the variable is blank.
 * @returns the parsed integer.
 * @throws {PlatformConfigError} when the value is not a non-negative integer.
 */
function parseInteger(raw: string, name: string, fallback: number): number {
  if (raw === '') return fallback
  if (!/^\d+$/.test(raw)) throw new PlatformConfigError(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`)
  return Number(raw)
}

/**
 * Parse an HTTP(S) origin, refusing any path, query, or fragment.
 * @param raw - configured origin text.
 * @param name - variable name for the error message.
 * @returns the normalized origin.
 * @throws {PlatformConfigError} when the value is not a bare HTTP(S) origin.
 */
function parseOrigin(raw: string, name: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new PlatformConfigError(`${name} must be an absolute HTTP(S) URL, got ${JSON.stringify(raw)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PlatformConfigError(`${name} must use http or https, got ${url.protocol}`)
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new PlatformConfigError(`${name} must be a bare origin without a path, query, or fragment, got ${JSON.stringify(raw)}`)
  }
  return url.origin
}

/**
 * Split a command line into argv tokens, refusing quoting so a path with spaces fails loudly.
 * @param raw - space-separated command text.
 * @param name - variable name for the error message.
 * @returns the tokens.
 * @throws {PlatformConfigError} when quoting is used, which this simple split cannot honor.
 */
function parseCommand(raw: string, name: string): string[] {
  if (/["']/.test(raw)) {
    throw new PlatformConfigError(`${name} does not support quoting; use a wrapper script for paths with spaces`)
  }
  const tokens = raw.split(/\s+/).filter(token => token !== '')
  if (tokens.length === 0) throw new PlatformConfigError(`${name} must name a command`)
  return tokens
}

/**
 * Build the default process-backend command for a repository checkout.
 *
 * The runtime child runs with its own user workspace as the working directory, so
 * the tsx loader and the DSH CLI must both be addressed absolutely; a bare
 * `tsx/esm` specifier would resolve against that workspace and fail. The
 * executable path is kept as one argv element so a host path containing spaces
 * (`C:\Program Files\nodejs\node.exe`) is not split by the environment parser.
 * @param repoRoot - repository checkout owning the CLI and the installed tsx.
 * @returns the command prefix the process backend appends `web` flags to.
 */
export function defaultProcessCommand(repoRoot: string): string[] {
  let loader = 'tsx/esm'
  try {
    // `import.meta.resolve` yields the file URL Node's `--import` accepts on every
    // platform; a raw Windows path would be parsed as a `d:` URL scheme and fail.
    loader = import.meta.resolve('tsx/esm')
  } catch {
    // A deployment without tsx installed keeps the bare specifier; the process
    // backend then reports the import failure instead of silently not starting.
  }
  return [process.execPath, '--import', loader, join(repoRoot, 'apps', 'cli', 'src', 'bin.ts')]
}

/**
 * Resolve the platform configuration from an environment mapping.
 * @param env - environment mapping; defaults to `process.env`.
 * @returns the fully resolved configuration.
 * @throws {PlatformConfigError} listing every missing or unsafe setting.
 */
export function loadPlatformConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const problems: string[] = []
  const appEnvRaw = readEnv(env, 'APP_ENV', 'development').toLowerCase()
  if (!['development', 'testing', 'production'].includes(appEnvRaw)) {
    throw new PlatformConfigError(`APP_ENV must be development, testing, or production, got ${JSON.stringify(appEnvRaw)}`)
  }
  const appEnv = appEnvRaw as AppEnv
  const production = appEnv === 'production'
  const modeRaw = readEnv(env, 'AUTH_MODE', production ? 'w3' : 'mock').toLowerCase()
  if (modeRaw !== 'mock' && modeRaw !== 'w3') {
    throw new PlatformConfigError(`AUTH_MODE must be mock or w3, got ${JSON.stringify(modeRaw)}`)
  }
  const mode = modeRaw as AuthMode
  if (mode === 'mock' && production) {
    throw new PlatformConfigError('Mock authentication is forbidden in production; set AUTH_MODE=w3')
  }
  const dataDir = resolve(readEnv(env, 'DSH_PLATFORM_DATA_DIR', '.dsh-platform'))
  const repoRoot = resolve(readEnv(env, 'DSH_PLATFORM_REPO_ROOT', process.cwd()))
  const defaultPublicOrigin = production
    ? ''
    : `http://127.0.0.1:${String(parseInteger(readEnv(env, 'DSH_GATEWAY_LISTEN_PORT', ''), 'DSH_GATEWAY_LISTEN_PORT', DEFAULT_GATEWAY_PORT))}`
  const publicOriginRaw = readRequiredEnv(env, 'DSH_GATEWAY_PUBLIC_URL', problems)
  let publicOrigin: string
  try {
    publicOrigin = parseOrigin(publicOriginRaw === '' ? (defaultPublicOrigin === '' ? 'https://invalid.invalid' : defaultPublicOrigin) : publicOriginRaw, 'DSH_GATEWAY_PUBLIC_URL')
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
    publicOrigin = 'https://invalid.invalid'
  }
  if (production && !publicOrigin.startsWith('https://')) {
    problems.push('DSH_GATEWAY_PUBLIC_URL must be an https origin in production')
  }
  const cookieSecure = parseBoolean(
    readEnv(env, 'AUTH_COOKIE_SECURE', production ? 'true' : 'false'),
    'AUTH_COOKIE_SECURE',
  )
  if (production && !cookieSecure) problems.push('AUTH_COOKIE_SECURE must be true in production')
  const w3: W3Config = {
    clientId: readEnv(env, 'W3_CLIENT_ID', ''),
    clientSecret: readEnv(env, 'W3_CLIENT_SECRET', ''),
    authorizeUrl: readEnv(env, 'W3_AUTHORIZE_URL', ''),
    tokenUrl: readEnv(env, 'W3_TOKEN_URL', ''),
    userinfoUrl: readEnv(env, 'W3_USERINFO_URL', ''),
    logoutUrl: readEnv(env, 'W3_LOGOUT_URL', ''),
    redirectUri: readEnv(env, 'W3_REDIRECT_URI', ''),
    scope: readEnv(env, 'W3_SCOPE', 'base.profile'),
    tokenRequestFormat: readEnv(env, 'W3_TOKEN_REQUEST_FORMAT', 'json').toLowerCase() === 'form' ? 'form' : 'json',
  }
  if (mode === 'w3') {
    for (const [name, value] of [
      ['W3_CLIENT_ID', w3.clientId],
      ['W3_CLIENT_SECRET', w3.clientSecret],
      ['W3_AUTHORIZE_URL', w3.authorizeUrl],
      ['W3_TOKEN_URL', w3.tokenUrl],
      ['W3_USERINFO_URL', w3.userinfoUrl],
      ['W3_REDIRECT_URI', w3.redirectUri],
    ] as const) {
      if (value === '') problems.push(`${name} is required when AUTH_MODE=w3`)
    }
    for (const [name, value] of [
      ['W3_AUTHORIZE_URL', w3.authorizeUrl],
      ['W3_TOKEN_URL', w3.tokenUrl],
      ['W3_USERINFO_URL', w3.userinfoUrl],
      ['W3_REDIRECT_URI', w3.redirectUri],
    ] as const) {
      if (value !== '' && production && !value.startsWith('https://')) problems.push(`${name} must use https in production`)
    }
    if (w3.tokenRequestFormat !== 'json' && w3.tokenRequestFormat !== 'form') {
      problems.push('W3_TOKEN_REQUEST_FORMAT must be json or form')
    }
  }
  const internalApiKey = readEnv(env, 'DSH_INTERNAL_API_KEY', '')
  if (internalApiKey !== '' && internalApiKey.length < 32) {
    problems.push('DSH_INTERNAL_API_KEY must be at least 32 characters')
  }
  if (production && internalApiKey.length < 32) {
    problems.push('DSH_INTERNAL_API_KEY (>=32 characters) is required in production')
  }
  const host = new URL(publicOrigin)
  const runtimeKindRaw = readEnv(env, 'DSH_RUNTIME_KIND', production ? 'container' : 'process')
  if (runtimeKindRaw !== 'process' && runtimeKindRaw !== 'container') {
    throw new PlatformConfigError(`DSH_RUNTIME_KIND must be process or container, got ${JSON.stringify(runtimeKindRaw)}`)
  }
  const runtimeImage = readEnv(env, 'DSH_RUNTIME_IMAGE', '')
  if (runtimeKindRaw === 'container' && runtimeImage === '') {
    problems.push('DSH_RUNTIME_IMAGE is required when DSH_RUNTIME_KIND=container')
  }
  const privateKeyFile = resolve(readEnv(env, 'DSH_GATEWAY_SIGNING_PRIVATE_KEY_FILE', join(dataDir, 'keys', 'gateway-ed25519-private.pem')))
  const publicKeyFile = resolve(readEnv(env, 'DSH_GATEWAY_PUBLIC_KEY_FILE', join(dataDir, 'keys', 'gateway-ed25519-public.pem')))
  const spaceKeySecretRaw = readEnv(env, 'DSH_PLATFORM_SPACE_KEY_SECRET', '')
  const spaceKeySecret = spaceKeySecretRaw === '' ? `development-space-key-${'0123456789abcdef'.repeat(2)}` : spaceKeySecretRaw
  if (production && spaceKeySecretRaw.length < 32) {
    problems.push('DSH_PLATFORM_SPACE_KEY_SECRET (>=32 characters) is required in production')
  }
  if (spaceKeySecretRaw !== '' && spaceKeySecretRaw.length < 32) {
    problems.push('DSH_PLATFORM_SPACE_KEY_SECRET must be at least 32 characters')
  }
  const processCommand = readEnv(env, 'DSH_RUNTIME_PROCESS_COMMAND', '') === ''
    ? defaultProcessCommand(repoRoot)
    : parseCommand(readEnv(env, 'DSH_RUNTIME_PROCESS_COMMAND', ''), 'DSH_RUNTIME_PROCESS_COMMAND')
  const config: PlatformConfig = {
    appEnv,
    realm: readEnv(env, 'DSH_PLATFORM_REALM', 'dsh'),
    dataDir,
    identity: {
      appEnv,
      mode,
      dataDir,
      sessionCookieName: readEnv(env, 'AUTH_COOKIE_NAME', 'dsh_session'),
      csrfCookieName: readEnv(env, 'AUTH_CSRF_COOKIE_NAME', 'dsh_csrf'),
      loginNonceCookieName: readEnv(env, 'AUTH_LOGIN_NONCE_COOKIE_NAME', 'dsh_login_nonce'),
      cookieSecure,
      idleTimeoutMs: parseInteger(readEnv(env, 'AUTH_IDLE_TIMEOUT_MINUTES', ''), 'AUTH_IDLE_TIMEOUT_MINUTES', DEFAULT_IDLE_TIMEOUT_MS / 60_000) * 60_000,
      absoluteTimeoutMs: parseInteger(readEnv(env, 'AUTH_ABSOLUTE_TIMEOUT_MINUTES', ''), 'AUTH_ABSOLUTE_TIMEOUT_MINUTES', DEFAULT_ABSOLUTE_TIMEOUT_MS / 60_000) * 60_000,
      oauthStateTtlMs: parseInteger(readEnv(env, 'AUTH_OAUTH_STATE_TTL_MINUTES', ''), 'AUTH_OAUTH_STATE_TTL_MINUTES', DEFAULT_OAUTH_STATE_TTL_MS / 60_000) * 60_000,
      loginRateLimit: {
        windowMs: parseInteger(readEnv(env, 'AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS', ''), 'AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS', DEFAULT_LOGIN_RATE_LIMIT_WINDOW_MS / 1000) * 1000,
        maxAttemptsPerAddress: parseInteger(readEnv(env, 'AUTH_LOGIN_RATE_LIMIT_MAX', ''), 'AUTH_LOGIN_RATE_LIMIT_MAX', DEFAULT_LOGIN_RATE_LIMIT_MAX),
      },
      internalApiKey,
      w3,
      mock: {
        subject: readEnv(env, 'MOCK_USER_SUBJECT', 'dev-user-001'),
        uid: readEnv(env, 'MOCK_USER_UID', 'local-001'),
        displayName: readEnv(env, 'MOCK_USER_DISPLAY_NAME', '本地开发用户'),
        email: readEnv(env, 'MOCK_USER_EMAIL', ''),
      },
    },
    runtime: {
      kind: runtimeKindRaw,
      spaceKeySecret,
      root: resolve(readEnv(env, 'DSH_RUNTIME_ROOT', join(dataDir, 'spaces'))),
      idleSeconds: parseInteger(readEnv(env, 'DSH_RUNTIME_IDLE_SECONDS', ''), 'DSH_RUNTIME_IDLE_SECONDS', DEFAULT_IDLE_SECONDS),
      reapIntervalMs: parseInteger(readEnv(env, 'DSH_RUNTIME_REAP_INTERVAL_SECONDS', ''), 'DSH_RUNTIME_REAP_INTERVAL_SECONDS', 30) * 1000,
      repoRoot,
      processCommand,
      image: runtimeImage,
      dockerCommand: readEnv(env, 'DSH_RUNTIME_DOCKER_COMMAND', 'docker'),
      network: readEnv(env, 'DSH_RUNTIME_NETWORK', 'dsh-private'),
      containerDataRoot: readEnv(env, 'DSH_RUNTIME_CONTAINER_DATA_ROOT', '/data'),
      containerPublicKeyPath: readEnv(env, 'DSH_RUNTIME_CONTAINER_PUBLIC_KEY_PATH', '/run/dsh/gateway-public.pem'),
      containerPatchPath: readEnv(env, 'DSH_RUNTIME_CONTAINER_PATCH_PATH', '/run/dsh/platform-runtime.patch.yml'),
      containerRepoRoot: readEnv(env, 'DSH_RUNTIME_CONTAINER_REPO_ROOT', '/app'),
      containerPort: parseInteger(readEnv(env, 'DSH_RUNTIME_CONTAINER_PORT', ''), 'DSH_RUNTIME_CONTAINER_PORT', 3080),
      containerUid: parseInteger(readEnv(env, 'DSH_RUNTIME_CONTAINER_UID', ''), 'DSH_RUNTIME_CONTAINER_UID', 1000),
      bindHost: readEnv(env, 'DSH_RUNTIME_BIND_HOST', '') === '' ? undefined : readEnv(env, 'DSH_RUNTIME_BIND_HOST', ''),
      publicAuthority: host.host,
      patchFile: resolve(readEnv(env, 'DSH_RUNTIME_PATCH_FILE', join(repoRoot, DEFAULT_RUNTIME_PATCH_FILE))),
      startTimeoutMs: parseInteger(readEnv(env, 'DSH_RUNTIME_START_TIMEOUT_MS', ''), 'DSH_RUNTIME_START_TIMEOUT_MS', production ? 60_000 : 180_000),
      cpuLimit: readEnv(env, 'DSH_RUNTIME_CPU_LIMIT', '1'),
      memoryLimitMb: parseInteger(readEnv(env, 'DSH_RUNTIME_MEMORY_MB', ''), 'DSH_RUNTIME_MEMORY_MB', 2048),
      pidsLimit: parseInteger(readEnv(env, 'DSH_RUNTIME_PIDS_LIMIT', ''), 'DSH_RUNTIME_PIDS_LIMIT', 512),
      maxConcurrentStarts: parseInteger(readEnv(env, 'DSH_RUNTIME_MAX_CONCURRENT_STARTS', ''), 'DSH_RUNTIME_MAX_CONCURRENT_STARTS', 4),
      urlBasePath: readEnv(env, 'DSH_RUNTIME_URL_BASE_PATH', ''),
    },
    gateway: {
      listenHost: readEnv(env, 'DSH_GATEWAY_LISTEN_HOST', production ? '0.0.0.0' : '127.0.0.1'),
      listenPort: parseInteger(readEnv(env, 'DSH_GATEWAY_LISTEN_PORT', ''), 'DSH_GATEWAY_LISTEN_PORT', DEFAULT_GATEWAY_PORT),
      publicOrigin,
      issuer: readEnv(env, 'DSH_GATEWAY_ISSUER', 'dsh-gateway'),
      audience: readEnv(env, 'DSH_GATEWAY_AUDIENCE', 'dsh-web'),
      keyId: readEnv(env, 'DSH_GATEWAY_KEY_ID', 'dsh-gateway-key-v1'),
      privateKeyFile,
      publicKeyFile,
      assertionTtlSeconds: parseInteger(readEnv(env, 'DSH_GATEWAY_ASSERTION_TTL_SECONDS', ''), 'DSH_GATEWAY_ASSERTION_TTL_SECONDS', DEFAULT_ASSERTION_TTL_SECONDS),
      maxAssertionLifetimeSeconds: DEFAULT_MAX_ASSERTION_LIFETIME_SECONDS,
      wsRevalidateSeconds: parseInteger(readEnv(env, 'DSH_GATEWAY_WS_REVALIDATE_SECONDS', ''), 'DSH_GATEWAY_WS_REVALIDATE_SECONDS', DEFAULT_WS_REVALIDATE_SECONDS),
      replayWindowSeconds: DEFAULT_REPLAY_WINDOW_SECONDS,
      loginPath: readEnv(env, 'DSH_GATEWAY_LOGIN_PATH', DEFAULT_LOGIN_PATH),
      maxBodyBytes: parseInteger(readEnv(env, 'DSH_GATEWAY_MAX_BODY_BYTES', ''), 'DSH_GATEWAY_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES),
      generateKeyPairIfMissing: !production,
    },
  }
  if (config.gateway.assertionTtlSeconds > config.gateway.maxAssertionLifetimeSeconds) {
    problems.push('DSH_GATEWAY_ASSERTION_TTL_SECONDS must not exceed the runtime policy lifetime of 300 seconds')
  }
  if (config.gateway.wsRevalidateSeconds > 20) {
    problems.push('DSH_GATEWAY_WS_REVALIDATE_SECONDS must be 20 seconds or less so revoked sessions drop promptly')
  }
  if (problems.length > 0) {
    throw new PlatformConfigError(`Invalid DSH platform configuration:\n- ${[...new Set(problems)].join('\n- ')}`)
  }
  return config
}

/**
 * Build a complete configuration for tests and embedded use, applying explicit
 * development defaults for every field the caller does not override.
 * @param overrides - per-section partial values.
 * @returns the resolved configuration, without environment validation.
 */
export function createPlatformConfig(overrides: PlatformConfigOverrides = {}): PlatformConfig {
  const dataDir = resolve(overrides.dataDir ?? join(process.cwd(), '.dsh-platform'))
  const repoRoot = resolve(process.env.DSH_PLATFORM_REPO_ROOT ?? process.cwd())
  const appEnv = overrides.appEnv ?? 'testing'
  const base = loadPlatformConfig({
    APP_ENV: appEnv,
    AUTH_MODE: 'mock',
    DSH_PLATFORM_DATA_DIR: dataDir,
    DSH_PLATFORM_REPO_ROOT: repoRoot,
    DSH_GATEWAY_PUBLIC_URL: 'http://127.0.0.1:8080',
    AUTH_COOKIE_SECURE: 'false',
    DSH_RUNTIME_KIND: 'process',
    DSH_PLATFORM_SPACE_KEY_SECRET: 'test-space-key-secret-0123456789abcdef',
    DSH_INTERNAL_API_KEY: 'test-internal-key-0123456789abcdef0123456789abcdef',
    DSH_GATEWAY_LISTEN_PORT: '8080',
  })
  const gateway: GatewayConfig = { ...base.gateway, ...overrides.gateway }
  constraintCheck(gateway)
  return {
    ...base,
    realm: overrides.realm ?? base.realm,
    identity: { ...base.identity, ...overrides.identity },
    runtime: {
      ...base.runtime,
      ...overrides.runtime,
      repoRoot: overrides.runtime?.repoRoot ?? repoRoot,
      publicAuthority: new URL(gateway.publicOrigin).host,
    },
    gateway,
  }
}

/**
 * Re-check the cross-field gateway constraints after overrides.
 * @param gateway - merged gateway configuration.
 * @throws {PlatformConfigError} when an override made the configuration unsafe.
 */
function constraintCheck(gateway: GatewayConfig): void {
  if (gateway.assertionTtlSeconds > gateway.maxAssertionLifetimeSeconds) {
    throw new PlatformConfigError('gateway override: assertionTtlSeconds exceeds maxAssertionLifetimeSeconds')
  }
  if (gateway.wsRevalidateSeconds > 20) {
    throw new PlatformConfigError('gateway override: wsRevalidateSeconds must be 20 or less')
  }
}

/**
 * Ensure the gateway's Ed25519 key pair exists and return the file paths.
 *
 * A configured private key is adopted as-is; the public key is derived when the
 * configured public-key file is absent. In development the pair is generated on
 * first start under the platform data directory.
 * @param config - gateway configuration naming the key files.
 * @returns the private and public key file paths.
 * @throws {PlatformConfigError} when a configured private key is unreadable or not Ed25519.
 */
export function ensureGatewayKeyPair(config: GatewayConfig): { privateKeyFile: string; publicKeyFile: string } {
  let privatePem: string
  try {
    privatePem = readFileSync(config.privateKeyFile, 'utf8')
  } catch {
    // Generating on first start is a development convenience; production must
    // provision the key so a redeploy cannot silently become a new signer.
    if (!config.generateKeyPairIfMissing) {
      throw new PlatformConfigError(`DSH_GATEWAY_SIGNING_PRIVATE_KEY_FILE "${config.privateKeyFile}" could not be read`)
    }
    mkdirSync(dirname(config.privateKeyFile), { recursive: true })
    const pair = generateEd25519Pair()
    writeFileSync(config.privateKeyFile, pair.privateKeyPem, { mode: 0o600 })
    writeFileSync(config.publicKeyFile, pair.publicKeyPem, { mode: 0o644 })
    return { privateKeyFile: config.privateKeyFile, publicKeyFile: config.publicKeyFile }
  }
  let privateKey
  try {
    privateKey = createPrivateKey(privatePem)
  } catch (error) {
    throw new PlatformConfigError(`DSH_GATEWAY_SIGNING_PRIVATE_KEY_FILE is not a parseable PEM key: ${String(error)}`)
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new PlatformConfigError(`DSH_GATEWAY_SIGNING_PRIVATE_KEY_FILE must be an Ed25519 key, got ${String(privateKey.asymmetricKeyType)}`)
  }
  try {
    readFileSync(config.publicKeyFile, 'utf8')
  } catch {
    const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()
    mkdirSync(dirname(config.publicKeyFile), { recursive: true })
    writeFileSync(config.publicKeyFile, publicPem, { mode: 0o644 })
  }
  return { privateKeyFile: config.privateKeyFile, publicKeyFile: config.publicKeyFile }
}

/**
 * Generate one Ed25519 key pair in PEM form.
 * @returns the private and public PEM texts.
 */
function generateEd25519Pair(): { privateKeyPem: string; publicKeyPem: string } {
  const pair = generateKeyPairSync('ed25519')
  return {
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}
