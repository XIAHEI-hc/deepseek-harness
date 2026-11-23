/**
 * Stateless runtime capability tokens for the fusion tool surface.
 *
 * The per-user DSH runtime calls the platform API with a short-lived bearer
 * token instead of a browser session cookie. The token is an HMAC over a
 * compact claim set using the platform space-key secret; the runtime never
 * receives that secret, and the token is scoped to one user, one permission
 * version, and a short expiry.
 *
 * @module @deepseek-ai/dsh-platform-services/integration/capability
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { PlatformUser, ValidatedSession } from '../contracts.ts'

/** Default capability lifetime: fifteen minutes. */
export const RUNTIME_CAPABILITY_TTL_MS = 15 * 60 * 1000

/** Longest accepted serialized token. */
const MAX_TOKEN_LENGTH = 4096

/** Claims carried by one runtime capability token. */
export interface RuntimeCapabilityClaims {
  readonly version: 1
  readonly userId: string
  readonly subject: string
  readonly uid: string
  readonly displayName: string
  readonly permissionVersion: number
  /** Epoch milliseconds. */
  readonly expiresAt: number
}

/** Decoded wire claims. */
interface WireClaims {
  readonly v: 1
  readonly sub: string
  readonly subject: string
  readonly uid: string
  readonly name: string
  readonly pv: number
  readonly exp: number
}

/**
 * Encode one JSON value as base64url.
 * @param value - JSON value.
 * @returns the encoded segment.
 */
function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

/**
 * Sign one payload segment.
 * @param secret - HMAC secret.
 * @param payload - encoded payload segment.
 * @returns the base64url signature.
 */
function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(`dsh-runtime-capability.1.${payload}`, 'utf8').digest('base64url')
}

/**
 * Mint one runtime capability token.
 * @param secret - platform HMAC secret; never given to the runtime.
 * @param user - platform user the token acts for.
 * @param permissionVersion - current user permission version.
 * @param nowMs - current epoch milliseconds.
 * @param ttlMs - lifetime in milliseconds.
 * @returns the wire token.
 */
export function mintRuntimeCapability(
  secret: string,
  user: PlatformUser,
  permissionVersion: number,
  nowMs: number = Date.now(),
  ttlMs: number = RUNTIME_CAPABILITY_TTL_MS,
): string {
  if (secret.length < 32) throw new Error('runtime capability secret must be at least 32 characters')
  if (!Number.isInteger(permissionVersion) || permissionVersion < 1) throw new Error('permission version must be positive')
  const claims: WireClaims = {
    v: 1,
    sub: user.id,
    subject: user.subject,
    uid: user.uid,
    name: user.displayName,
    pv: permissionVersion,
    exp: nowMs + ttlMs,
  }
  const payload = encode(claims)
  return `${payload}.${sign(secret, payload)}`
}

/**
 * Verify one runtime capability token.
 * @param secret - platform HMAC secret.
 * @param token - wire token.
 * @param nowMs - current epoch milliseconds.
 * @returns the claims, or undefined for a malformed, tampered, or expired token.
 */
export function verifyRuntimeCapability(
  secret: string,
  token: string,
  nowMs: number = Date.now(),
): RuntimeCapabilityClaims | undefined {
  if (secret.length < 32 || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return undefined
  const separator = token.indexOf('.')
  if (separator <= 0 || separator === token.length - 1) return undefined
  const payload = token.slice(0, separator)
  const signature = token.slice(separator + 1)
  if (payload.includes('.') || signature.includes('.')) return undefined
  const expected = sign(secret, payload)
  const left = Buffer.from(signature, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  if (left.length !== right.length || !timingSafeEqual(left, right)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  if (record['v'] !== 1) return undefined
  if (typeof record['sub'] !== 'string' || typeof record['subject'] !== 'string' || typeof record['uid'] !== 'string') return undefined
  if (typeof record['name'] !== 'string' || typeof record['pv'] !== 'number' || typeof record['exp'] !== 'number') return undefined
  if (!Number.isInteger(record['pv']) || record['pv'] < 1) return undefined
  if (!Number.isFinite(record['exp']) || record['exp'] <= nowMs) return undefined
  return {
    version: 1,
    userId: record['sub'],
    subject: record['subject'],
    uid: record['uid'],
    displayName: record['name'],
    permissionVersion: record['pv'],
    expiresAt: record['exp'],
  }
}

/**
 * Project verified claims into a session-shaped actor for the fusion service.
 * @param claims - verified token claims.
 * @returns the validated session used by every fusion handler.
 */
export function sessionFromCapability(claims: RuntimeCapabilityClaims): ValidatedSession {
  return {
    user: {
      id: claims.userId,
      subject: claims.subject,
      uid: claims.uid,
      displayName: claims.displayName,
      email: null,
    },
    sessionId: `runtime:${claims.userId}`,
    permissionVersion: claims.permissionVersion,
    expiresAt: claims.expiresAt,
    absoluteExpiresAt: claims.expiresAt,
  }
}
