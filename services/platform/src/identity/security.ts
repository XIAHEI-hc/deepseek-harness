/**
 * Identity security primitives: token hashing, random cookies, return-to
 * sanitization, user synchronization, session creation, and cookie attributes.
 *
 * Raw session tokens, CSRF tokens, OAuth states, and browser nonces are generated
 * with `node:crypto` and persisted only as SHA-256 hex digests. Every comparison
 * of a stored digest or service secret hashes both sides first so the comparison
 * is constant-time regardless of the presented length.
 *
 * @module @deepseek-ai/dsh-platform-services/identity/security
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { PlatformUser, SetCookie } from '../contracts.ts'
import type { IdentityConfig } from '../config.ts'
import { IdentityError } from './errors.ts'
import type { IdentityStore, LoginStateRow, SessionRow, UserRow } from './store.ts'

/** Location the W3 callback redirects to when a login attempt fails. */
export const W3_DENIED_LOCATION = '/login?error=w3_denied'

/** Minimum age of the last-activity timestamp before a session refresh is written. */
export const SESSION_REFRESH_INTERVAL_MS = 60_000

/** Identity facts resolved from a W3 profile or the configured mock identity. */
export interface SyncedIdentity {
  /** Stable subject (`uuid`, falling back to `sub`). */
  readonly subject: string
  /** W3 account identifier; required. */
  readonly uid: string
  /** Display name; falls back to the uid when blank. */
  readonly displayName: string
  /** Optional W3 email; null when none was returned. */
  readonly email: string | null
}

/** Newly minted session credentials; the raw values are returned to the browser only. */
export interface SessionCredentials {
  /** Raw session cookie token. */
  readonly token: string
  /** Raw CSRF cookie token. */
  readonly csrfToken: string
  /** Persisted session row. */
  readonly session: SessionRow
}

/** One minted OAuth login transaction. */
export interface CreatedLoginState {
  /** Raw OAuth state parameter. */
  readonly state: string
  /** Raw browser-binding nonce cookie value. */
  readonly nonce: string
}

/**
 * Hash a raw token with SHA-256.
 * @param raw - raw token value.
 * @returns lowercase SHA-256 hex digest.
 */
export function digest(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

/**
 * Compare two strings in constant time.
 * @param left - first value.
 * @param right - second value.
 * @returns true when both values are byte-equal.
 */
export function constantTimeEquals(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest()
  const rightDigest = createHash('sha256').update(right, 'utf8').digest()
  return timingSafeEqual(leftDigest, rightDigest)
}

/**
 * Generate one URL-safe random token.
 * @param byteLength - number of random bytes.
 * @returns the base64url-encoded token.
 */
export function randomToken(byteLength: number): string {
  return randomBytes(byteLength).toString('base64url')
}

/**
 * Format epoch milliseconds as an ISO-8601 UTC timestamp.
 * @param epochMs - epoch milliseconds.
 * @returns the ISO-8601 text.
 */
export function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString()
}

/**
 * Parse an ISO-8601 timestamp from the identity database.
 * @param value - stored ISO-8601 text.
 * @returns epoch milliseconds.
 * @throws when the stored timestamp is not parseable.
 */
export function parseIso(value: string): number {
  const epochMs = Date.parse(value)
  if (Number.isNaN(epochMs)) throw new Error(`identity database timestamp is not parseable: ${value}`)
  return epochMs
}

/**
 * Sanitize a post-login redirect target to a same-site relative path.
 *
 * Absolute URLs, protocol-relative paths, backslash tricks, and control
 * characters fall back to `/` so a crafted `return_to` cannot become an open
 * redirect.
 * @param value - raw `return_to` query value, or null/undefined when absent.
 * @returns a safe same-site path.
 */
export function safeReturnTo(value: string | null | undefined): string {
  const candidate = (value ?? '/').trim()
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) {
    return '/'
  }
  for (const character of candidate) {
    if (character.charCodeAt(0) < 32) return '/'
  }
  return candidate
}

/**
 * Create and persist one OAuth login transaction.
 * @param config - identity configuration owning the transaction lifetime.
 * @param store - identity store.
 * @param returnTo - raw post-login redirect target; sanitized before storage.
 * @param nowMs - current epoch milliseconds.
 * @returns the raw state and browser nonce.
 */
export function createLoginState(
  config: IdentityConfig,
  store: IdentityStore,
  returnTo: string | null | undefined,
  nowMs: number,
): CreatedLoginState {
  const state = randomToken(32)
  const nonce = randomToken(32)
  store.insertLoginState({
    id: randomUUID(),
    stateHash: digest(state),
    browserNonceHash: digest(nonce),
    returnTo: safeReturnTo(returnTo),
    createdAt: toIso(nowMs),
    expiresAt: toIso(nowMs + config.oauthStateTtlMs),
    consumedAt: null,
  })
  return { state, nonce }
}

/**
 * Atomically consume one OAuth login transaction.
 * @param store - identity store.
 * @param rawState - raw state parameter from the callback.
 * @param browserNonce - nonce cookie value from the browser, or undefined.
 * @param nowMs - current epoch milliseconds.
 * @returns the consumed row, or undefined when unusable.
 */
export function consumeLoginState(
  store: IdentityStore,
  rawState: string,
  browserNonce: string | undefined,
  nowMs: number,
): LoginStateRow | undefined {
  if (rawState === '' || browserNonce === undefined || browserNonce === '') return undefined
  return store.consumeLoginState(digest(rawState), digest(browserNonce), toIso(nowMs))
}

/**
 * Create or refresh the platform user for one identity provider profile.
 *
 * A second subject may not take over an existing `uid`, an existing subject keeps
 * its stable user id, and a disabled account is refused instead of resurrected.
 * @param store - identity store.
 * @param identity - profile facts resolved from W3 or the configured mock identity.
 * @param nowMs - current epoch milliseconds.
 * @returns the persisted user row.
 * @throws {IdentityError} `identity-incomplete`, `identity-conflict`, or `account-disabled`.
 */
export function syncUser(
  store: IdentityStore,
  identity: SyncedIdentity,
  nowMs: number,
): UserRow {
  const subject = identity.subject.trim()
  const uid = identity.uid.trim()
  if (subject === '' || uid === '') {
    throw new IdentityError('identity-incomplete', 400, 'identity profile is missing a subject or uid')
  }
  const timestamp = toIso(nowMs)
  const displayName = identity.displayName === '' ? uid : identity.displayName
  const email = identity.email === '' ? null : identity.email
  return store.transaction(() => {
    const existing = store.findUserBySubject(subject)
    if (existing === undefined) {
      if (store.findUserByUid(uid) !== undefined) {
        throw new IdentityError('identity-conflict', 409, 'identity conflicts with an existing account')
      }
      const created: UserRow = {
        id: randomUUID(),
        subject,
        uid,
        displayName,
        email,
        status: 'active',
        permissionVersion: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastLoginAt: timestamp,
      }
      store.insertUser(created)
      return created
    }
    if (existing.status !== 'active') {
      throw new IdentityError('account-disabled', 403, 'account is disabled')
    }
    const conflicting = store.findUserByUid(uid)
    if (conflicting !== undefined && conflicting.id !== existing.id) {
      throw new IdentityError('identity-conflict', 409, 'identity conflicts with an existing account')
    }
    const updated: UserRow = {
      ...existing,
      uid,
      displayName,
      email,
      updatedAt: timestamp,
      lastLoginAt: timestamp,
    }
    store.updateUserLogin(updated)
    return updated
  })
}

/**
 * Mint and persist one session for an authenticated user.
 * @param config - identity configuration owning the session lifetimes.
 * @param store - identity store.
 * @param user - authenticated user row.
 * @param nowMs - current epoch milliseconds.
 * @returns the raw credentials and the persisted session row.
 */
export function createSession(
  config: IdentityConfig,
  store: IdentityStore,
  user: UserRow,
  nowMs: number,
): SessionCredentials {
  const token = randomToken(48)
  const csrfToken = randomToken(32)
  const session: SessionRow = {
    id: randomUUID(),
    userId: user.id,
    tokenHash: digest(token),
    csrfTokenHash: digest(csrfToken),
    permissionVersion: user.permissionVersion,
    createdAt: toIso(nowMs),
    lastSeenAt: toIso(nowMs),
    expiresAt: toIso(nowMs + config.idleTimeoutMs),
    absoluteExpiresAt: toIso(nowMs + config.absoluteTimeoutMs),
    revokedAt: null,
  }
  store.insertSession(session)
  return { token, csrfToken, session }
}

/**
 * Project a stored user row onto the shared identity contract.
 * @param user - stored user row.
 * @returns the public user facts.
 */
export function toPlatformUser(user: UserRow): PlatformUser {
  return {
    id: user.id,
    subject: user.subject,
    uid: user.uid,
    displayName: user.displayName,
    email: user.email,
  }
}

/**
 * Build the session and CSRF cookies a successful login sets.
 * @param config - identity configuration owning cookie names and attributes.
 * @param credentials - raw credentials minted for this login.
 * @returns the cookies to set.
 */
export function sessionCookies(
  config: IdentityConfig,
  credentials: SessionCredentials,
): readonly SetCookie[] {
  const maxAgeSeconds = Math.floor(config.absoluteTimeoutMs / 1000)
  return [
    {
      name: config.sessionCookieName,
      value: credentials.token,
      maxAgeSeconds,
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'Lax',
      path: '/',
    },
    {
      name: config.csrfCookieName,
      value: credentials.csrfToken,
      maxAgeSeconds,
      httpOnly: false,
      secure: config.cookieSecure,
      sameSite: 'Lax',
      path: '/',
    },
  ]
}

/**
 * Build the cookies that clear the session and CSRF cookies on logout.
 * @param config - identity configuration owning cookie names and attributes.
 * @returns the cookies to set with a zero lifetime.
 */
export function clearedSessionCookies(config: IdentityConfig): readonly SetCookie[] {
  return [
    {
      name: config.sessionCookieName,
      value: '',
      maxAgeSeconds: 0,
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'Lax',
      path: '/',
    },
    {
      name: config.csrfCookieName,
      value: '',
      maxAgeSeconds: 0,
      httpOnly: false,
      secure: config.cookieSecure,
      sameSite: 'Lax',
      path: '/',
    },
  ]
}

/**
 * Build the browser-binding nonce cookie for a login transaction.
 * @param config - identity configuration owning the nonce cookie and lifetime.
 * @param nonce - raw nonce value.
 * @returns the cookie to set on the browser.
 */
export function loginNonceCookie(config: IdentityConfig, nonce: string): SetCookie {
  return {
    name: config.loginNonceCookieName,
    value: nonce,
    maxAgeSeconds: Math.floor(config.oauthStateTtlMs / 1000),
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Lax',
    path: '/auth/callback',
  }
}

/**
 * Build the cookie that clears the browser-binding nonce after the callback runs.
 * @param config - identity configuration owning the nonce cookie.
 * @returns the cookie to set with a zero lifetime.
 */
export function clearedLoginNonceCookie(config: IdentityConfig): SetCookie {
  return {
    name: config.loginNonceCookieName,
    value: '',
    maxAgeSeconds: 0,
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Lax',
    path: '/auth/callback',
  }
}
