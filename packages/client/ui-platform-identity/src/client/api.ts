/**
 * Platform gateway calls the identity UI performs.
 *
 * Every request is same-origin and carries the browser's own session cookie;
 * the page never reads the HttpOnly session. Mutating requests echo the
 * non-HttpOnly CSRF cookie in `x-csrf-token`. A 401 is a session ending rather
 * than a retryable failure, so the caller clears local state and returns to
 * the sign-in page.
 */
import type { PlatformUser, RuntimePhase } from './contract.ts'

/** Non-HttpOnly CSRF cookie the platform sets for mutating requests. */
export const CSRF_COOKIE = 'dsh_csrf'

/** Platform sign-in endpoint. */
const IDENTITY_PATH = '/auth/me'
/** The caller's own runtime status. */
const RUNTIME_STATUS_PATH = '/api/runtime/me'
/** Idempotent request for the caller's runtime. */
const RUNTIME_WAKE_PATH = '/api/runtime/wake'
/** Recovery of the caller's failed runtime. */
const RUNTIME_RETRY_PATH = '/api/runtime/retry'
/** Browser-session revocation. */
const LOGOUT_PATH = '/auth/logout'
/** Platform sign-in page. */
const LOGIN_PATH = '/login'

/** The platform surface's answer classes; a body is read only for `ok`. */
export type PlatformResponse<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable' }

/** Same-origin navigation face the plugin drives. */
export interface PlatformLocation {
  readonly pathname: string
  readonly search: string
  readonly hash?: string
  /** Navigate the page to `url`. */
  assign(url: string): void
}

/** Transport seam for the platform surface; tests supply their own. */
export interface PlatformTransport {
  /** Perform one same-origin request. */
  fetch(input: string, init?: RequestInit): Promise<Response>
  /** Read one cookie by name. */
  cookie(name: string): string | undefined
  /** Current page location and navigation. */
  location: PlatformLocation
}

/** `/auth/me` answer. */
export interface PlatformMeResponse {
  /** The platform user behind the browser session. */
  user: PlatformUser
  /** ISO-8601 instant the browser session ends. */
  sessionExpiresAt?: string
}

/** `/api/runtime/me` answer. */
export interface RuntimeStatusResponse {
  /** Current runtime state. */
  state: RuntimePhase
  /** Allocation generation the runtime belongs to. */
  generation: number
  /** Whether the gateway permits a retry right now. */
  retryable: boolean
  /** Stable failure code for a failed runtime. */
  errorCode?: string
}

/**
 * Cookie read used by the CSRF header; absent in non-browser runs.
 * @param name - cookie name.
 * @returns the decoded cookie value, or undefined when the page has no such cookie.
 */
export function readBrowserCookie(name: string): string | undefined {
  const cookie = (globalThis as { document?: { cookie?: string } }).document?.cookie
  if (cookie === undefined) return undefined
  const prefix = `${name}=`
  for (const part of cookie.split(';')) {
    const entry = part.trim()
    if (entry.startsWith(prefix)) return decodeURIComponent(entry.slice(prefix.length))
  }
  return undefined
}

/**
 * Build the transport bound to the current browser page.
 * @returns the page-bound transport.
 */
export function browserTransport(): PlatformTransport {
  const location: PlatformLocation = {
    get pathname() { return globalThis.location.pathname },
    get search() { return globalThis.location.search },
    get hash() { return globalThis.location.hash },
    assign: (url) => { globalThis.location.assign(url) },
  }
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    cookie: readBrowserCookie,
    location,
  }
}

/**
 * Read the CSRF token a mutating request must echo.
 * @param transport - platform transport.
 * @returns the CSRF token, or undefined when the cookie is absent.
 */
export function readCsrfToken(transport: PlatformTransport): string | undefined {
  return transport.cookie(CSRF_COOKIE)
}

/**
 * The `return_to` for the current page: its same-origin path, query, and fragment.
 * @param transport - platform transport.
 * @returns the current page's same-origin relative URL.
 */
export function currentReturnTo(transport: PlatformTransport): string {
  return `${transport.location.pathname}${transport.location.search}${transport.location.hash ?? ''}`
}

/**
 * Same-origin sign-in URL that returns to `returnTo` after authentication.
 * @param returnTo - same-origin relative path to restore after sign-in.
 * @returns the sign-in URL.
 */
export function loginUrl(returnTo: string): string {
  return `${LOGIN_PATH}?return_to=${encodeURIComponent(returnTo)}`
}

/**
 * Send the page to sign-in, unless it is already there.
 * @param transport - platform transport.
 */
export function redirectToLogin(transport: PlatformTransport): void {
  if (transport.location.pathname === LOGIN_PATH) return
  transport.location.assign(loginUrl(currentReturnTo(transport)))
}

/**
 * Send the page to the sign-in page without a return target (used after sign-out).
 * @param transport - platform transport.
 */
export function redirectToLoginRoot(transport: PlatformTransport): void {
  transport.location.assign(LOGIN_PATH)
}

/** One JSON request with the platform's status classification. */
async function requestPlatform(
  transport: PlatformTransport,
  path: string,
  method: 'GET' | 'POST',
  csrfToken: string | undefined,
  readBody: boolean,
): Promise<PlatformResponse<unknown>> {
  const headers: Record<string, string> = {}
  if (csrfToken !== undefined) headers['x-csrf-token'] = csrfToken
  let response: Response
  try {
    response = await transport.fetch(path, { method, credentials: 'same-origin', headers })
  } catch (_error) {
    // A transport failure is the unreachable platform surface; the caller offers a recheck.
    return { kind: 'unavailable' }
  }
  if (response.status === 401) return { kind: 'unauthorized' }
  if (response.status === 403) return { kind: 'forbidden' }
  if (response.status === 404) return { kind: 'missing' }
  if (!response.ok) return { kind: 'unavailable' }
  if (!readBody) return { kind: 'ok', value: undefined }
  try {
    return { kind: 'ok', value: await response.json() }
  } catch (_error) {
    return { kind: 'unavailable' }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlatformUser(value: unknown): value is PlatformUser {
  if (!isRecord(value)) return false
  const email = value.email
  return typeof value.id === 'string'
    && typeof value.subject === 'string'
    && typeof value.uid === 'string'
    && typeof value.displayName === 'string'
    && (email === undefined || email === null || typeof email === 'string')
}

const RUNTIME_PHASES: readonly RuntimePhase[] = [
  'UNALLOCATED', 'PROVISIONING', 'STARTING', 'READY', 'STOPPING', 'STOPPED', 'FAILED',
]

function isRuntimePhase(value: unknown): value is RuntimePhase {
  return typeof value === 'string' && (RUNTIME_PHASES as readonly string[]).includes(value)
}

/**
 * Parse one `/api/runtime/*` answer; undefined when the body is not a runtime status.
 * @param value - decoded response body.
 * @returns the runtime status, or undefined for a malformed body.
 */
export function parseRuntimeStatus(value: unknown): RuntimeStatusResponse | undefined {
  if (!isRecord(value)) return undefined
  const state = value.state
  if (!isRuntimePhase(state)) return undefined
  const errorCode = value.errorCode
  return {
    state,
    generation: typeof value.generation === 'number' ? value.generation : 0,
    retryable: value.retryable === true,
    ...(typeof errorCode === 'string' ? { errorCode } : {}),
  }
}

/**
 * Read the platform user behind the browser session.
 * @param transport - platform transport.
 * @returns the identity answer classification.
 */
export async function fetchPlatformIdentity(transport: PlatformTransport): Promise<PlatformResponse<PlatformMeResponse>> {
  const response = await requestPlatform(transport, IDENTITY_PATH, 'GET', undefined, true)
  if (response.kind !== 'ok') return response
  const value = response.value
  if (!isRecord(value) || !isPlatformUser(value.user)) return { kind: 'unavailable' }
  const sessionExpiresAt = value.sessionExpiresAt
  return {
    kind: 'ok',
    value: {
      user: value.user,
      ...(typeof sessionExpiresAt === 'string' ? { sessionExpiresAt } : {}),
    },
  }
}

/**
 * Read the caller's runtime status.
 * @param transport - platform transport.
 * @returns the runtime status answer classification.
 */
export async function fetchRuntimeStatus(transport: PlatformTransport): Promise<PlatformResponse<RuntimeStatusResponse>> {
  const response = await requestPlatform(transport, RUNTIME_STATUS_PATH, 'GET', undefined, true)
  if (response.kind !== 'ok') return response
  const status = parseRuntimeStatus(response.value)
  return status === undefined ? { kind: 'unavailable' } : { kind: 'ok', value: status }
}

/**
 * Idempotently request the caller's runtime.
 * @param transport - platform transport.
 * @returns the runtime status answer classification.
 */
export async function wakeRuntimeStatus(transport: PlatformTransport): Promise<PlatformResponse<RuntimeStatusResponse>> {
  const response = await requestPlatform(transport, RUNTIME_WAKE_PATH, 'POST', readCsrfToken(transport), true)
  if (response.kind !== 'ok') return response
  const status = parseRuntimeStatus(response.value)
  return status === undefined ? { kind: 'unavailable' } : { kind: 'ok', value: status }
}

/**
 * Ask the gateway to recover the caller's failed runtime.
 * @param transport - platform transport.
 * @returns the runtime status answer classification.
 */
export async function retryRuntimeStatus(transport: PlatformTransport): Promise<PlatformResponse<RuntimeStatusResponse>> {
  const response = await requestPlatform(transport, RUNTIME_RETRY_PATH, 'POST', readCsrfToken(transport), true)
  if (response.kind !== 'ok') return response
  const status = parseRuntimeStatus(response.value)
  return status === undefined ? { kind: 'unavailable' } : { kind: 'ok', value: status }
}

/**
 * Revoke the current browser session.
 * @param transport - platform transport.
 * @returns the request classification; ok means the session was revoked.
 */
export async function logoutPlatform(transport: PlatformTransport): Promise<PlatformResponse<undefined>> {
  const response = await requestPlatform(transport, LOGOUT_PATH, 'POST', readCsrfToken(transport), false)
  return response.kind === 'ok' ? { kind: 'ok', value: undefined } : response
}
