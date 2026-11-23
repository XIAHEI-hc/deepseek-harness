/**
 * Shared value contracts between the DSH platform services.
 *
 * Identity, runtime management, and the public gateway are separate modules with
 * separate tests; every value that crosses those seams is declared here so no
 * module re-declares (and drifts from) another module's wire or state semantics.
 *
 * @module @deepseek-ai/dsh-platform-services/contracts
 */

/** One DSH platform identity, owned by the identity service. */
export interface PlatformUser {
  /** Stable internal DSH user id (UUID); never derived from a browser parameter. */
  readonly id: string
  /** Stable W3 subject (`uuid`, falling back to `sub`); the unique identity key. */
  readonly subject: string
  /** W3 account identifier (employee number or account name). */
  readonly uid: string
  /** Display name shown in the native DSH sidebar. */
  readonly displayName: string
  /** Optional W3 email address; `null` when W3 did not return one. */
  readonly email: string | null
}

/** Why a session lookup did not yield an authenticated session. */
export type IdentityFailureCode =
  /** No session cookie was presented. */
  | 'no-session'
  /** The presented token does not match any stored session. */
  | 'session-invalid'
  /** The idle or absolute lifetime passed. */
  | 'session-expired'
  /** Logout, all-device revocation, or an admin revocation ended the session. */
  | 'session-revoked'
  /** The user account is disabled or its permission version moved. */
  | 'account-disabled'
  /** A state-changing request carried no matching CSRF token. */
  | 'csrf-invalid'
  /** The OAuth login transaction is unknown, expired, already consumed, or bound to another browser. */
  | 'login-state-invalid'
  /** W3 reported that the user denied or failed the login. */
  | 'w3-denied'
  /** W3 token or userinfo could not be reached or returned an unusable answer. */
  | 'w3-unavailable'
  /** The W3 identity conflicts with an existing account's `uid`. */
  | 'identity-conflict'
  /** W3 returned no usable subject or uid. */
  | 'identity-incomplete'
  /** The internal service key is missing or wrong. */
  | 'internal-unauthorized'
  /** Startup configuration forbids Mock authentication. */
  | 'mock-disabled'
  /** The requested route or method is not part of the identity surface. */
  | 'not-found'

/**
 * The identity facts a request is admitted with.
 *
 * `expiresAt` and `absoluteExpiresAt` are epoch milliseconds; the idle expiry is
 * refreshed by activity while the absolute expiry never moves.
 */
export interface ValidatedSession {
  readonly user: PlatformUser
  readonly sessionId: string
  /** Permission version the session was minted with; a later user change invalidates it. */
  readonly permissionVersion: number
  readonly expiresAt: number
  readonly absoluteExpiresAt: number
}

/** Result of resolving one session token. */
export type SessionLookup =
  | { readonly ok: true; readonly session: ValidatedSession }
  | { readonly ok: false; readonly code: IdentityFailureCode }

/** One cookie the platform sets on the browser. */
export interface SetCookie {
  readonly name: string
  readonly value: string
  /** Lifetime in seconds; omission writes a session cookie. */
  readonly maxAgeSeconds?: number | undefined
  readonly httpOnly?: boolean | undefined
  readonly secure?: boolean | undefined
  readonly sameSite?: 'Lax' | 'Strict' | undefined
  readonly path?: string | undefined
}

/** Header map accepted by the platform HTTP surfaces. */
export type PlatformHeaders = Readonly<Record<string, string | readonly string[] | undefined>>

/** One HTTP request handed to the identity service. */
export interface PlatformHttpRequest {
  readonly method: string
  readonly url: URL
  readonly headers: PlatformHeaders
  /** Parsed `Cookie` header; the transport owns cookie parsing. */
  readonly cookies: Readonly<Record<string, string>>
  /** Buffered request body text for the small JSON platform endpoints; absent when empty. */
  readonly body?: string | undefined
  /** Transport-observed client address; used by login rate limiting and audit rows. */
  readonly clientAddress?: string | undefined
}

/** One HTTP response the identity service produced. */
export interface PlatformHttpResult {
  readonly status: number
  readonly headers?: Readonly<Record<string, string>> | undefined
  readonly cookies?: readonly SetCookie[] | undefined
  /** Textual body; JSON and HTML are both shipped as text with an explicit content type. */
  readonly body?: string | undefined
}

/**
 * DSH platform identity service.
 *
 * `handle` owns `/auth/*` and `/internal/*`. It returns `undefined` for any other
 * path so the gateway keeps routing the request to the native DSH runtime.
 */
export interface IdentityService {
  readonly mode: 'mock' | 'w3'
  /**
   * Handle one identity-surface request.
   * @param request - method, URL, headers, and parsed cookies.
   * @returns the response, or undefined when the path is outside the identity surface.
   */
  handle(request: PlatformHttpRequest): Promise<PlatformHttpResult | undefined>
  /**
   * Resolve a session token to the authenticated identity.
   * @param sessionToken - raw HttpOnly session cookie value, or undefined when absent.
   * @returns the admitted session or the reason it is refused.
   */
  authenticate(sessionToken: string | undefined): Promise<SessionLookup>
  /**
   * Verify a state-changing request's CSRF token against its session.
   * @param session - the already validated session.
   * @param csrfHeader - `x-csrf-token` request header, or undefined.
   * @param csrfCookie - CSRF cookie value, or undefined.
   * @returns true only when the header, cookie, and stored hash agree.
   */
  verifyCsrf(
    session: ValidatedSession,
    csrfHeader: string | undefined,
    csrfCookie: string | undefined,
  ): boolean
  /** Release database handles. */
  close(): Promise<void>
}

/** Lifecycle state of one user's DSH runtime. */
export type RuntimeState =
  | 'UNALLOCATED'
  | 'PROVISIONING'
  | 'STARTING'
  | 'READY'
  | 'STOPPING'
  | 'STOPPED'
  | 'FAILED'

/** Anonymous status of one user's runtime, safe to return to that user's browser. */
export interface RuntimeStatusView {
  readonly state: RuntimeState
  /** Monotonic allocation generation; a restart increments it. */
  readonly generation: number
  /** Whether an explicit retry may succeed. */
  readonly retryable: boolean
  /** Stable machine error code; never contains paths, ports, or provider text. */
  readonly errorCode: string | null
}

/** Private loopback location of a READY runtime; never serialized to a browser. */
export interface RuntimeTarget {
  readonly host: string
  readonly port: number
  readonly generation: number
}

/** Result of ensuring a user's runtime. */
export interface RuntimeEnsureResult extends RuntimeStatusView {
  /** Present only when the runtime reached READY and can serve traffic. */
  readonly target?: RuntimeTarget | undefined
}

/** Per-user DSH runtime lifecycle owner. */
export interface RuntimeManager {
  /**
   * Idempotently bring the user's runtime to READY and return its private target.
   * Concurrent calls for one user share one start; different users start independently.
   * @param userId - stable internal user id resolved from a validated session.
   */
  ensure(userId: string): Promise<RuntimeEnsureResult>
  /**
   * Retry a FAILED or unexpectedly exited runtime.
   * @param userId - stable internal user id resolved from a validated session.
   */
  retry(userId: string): Promise<RuntimeEnsureResult>
  /**
   * Stop the user's current runtime instance (if any) and start a fresh
   * generation. Used by the operator restart command; a missing runtime is
   * started like `ensure`.
   * @param userId - stable internal user id resolved from an operator selector.
   */
  restart(userId: string): Promise<RuntimeEnsureResult>
  /**
   * Read the user's current runtime status without starting anything.
   * @param userId - stable internal user id resolved from a validated session.
   */
  status(userId: string): Promise<RuntimeStatusView>
  /**
   * Record user activity for idle reclamation.
   * @param userId - stable internal user id resolved from a validated session.
   */
  touch(userId: string): void
  /**
   * Hold one active connection or task against idle reclamation.
   * @param userId - stable internal user id resolved from a validated session.
   * @returns idempotent release for that lease.
   */
  lease(userId: string): () => void
  /** Stop every runtime this manager owns and release its registry. */
  close(): Promise<void>
}

/** One validated browser request, as the gateway routes it. */
export interface GatewayIdentity {
  readonly session: ValidatedSession
  /** Raw session token, kept only for revalidation. */
  readonly sessionToken: string
}
