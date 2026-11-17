/**
 * Verification of the identity assertion a trusted reverse proxy attaches to a request.
 *
 * The proxy authenticates the browser against its own identity provider and signs one
 * assertion per request. Nothing here reads cookies or browser-supplied identity: an
 * assertion either verifies against this instance's secret, audience, and served subject,
 * or the request stays unauthenticated.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** Assertion payload version understood by this module. */
const ASSERTION_VERSION = 1
/** Field separator inside the signed canonical string. */
const FIELD_SEPARATOR = '.'
/** Domain separator keeping these signatures from being reused by another purpose. */
const SIGNATURE_CONTEXT = 'dsh-gateway-identity'

/** Identity facts a verified assertion carries. */
export interface GatewayIdentity {
  /** Identity-provider subject the proxy authenticated. */
  readonly subject: string
  /** Proxy-side session that authorized this request. */
  readonly sessionId: string
  /** Identity-provider permission version at assertion time. */
  readonly permissionVersion: number
}

/** Facts bounding which assertions this instance accepts. */
export interface AssertionPolicy {
  /** Shared HMAC secret; at least 32 characters. */
  readonly secret: string
  /** Deployment audience this instance belongs to. */
  readonly audience: string
  /** The single subject this instance serves. */
  readonly subject: string
  /** Accepted clock difference in seconds. */
  readonly clockSkewSeconds: number
  /** Longest accepted `expiresAt - issuedAt` interval in seconds. */
  readonly maxLifetimeSeconds: number
}

/** Why an assertion was refused, for logging and tests. */
export type AssertionRejection =
  | 'malformed'
  | 'signature'
  | 'version'
  | 'audience'
  | 'subject'
  | 'lifetime'
  | 'not-yet-valid'
  | 'expired'

/** Verification outcome: the identity to admit or the reason it is refused. */
export type AssertionResult =
  | { readonly ok: true; readonly identity: GatewayIdentity }
  | { readonly ok: false; readonly reason: AssertionRejection }

/** Header lookup over a Fetch or node:http header representation. */
function readHeader(
  headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>,
  name: string,
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue
    if (typeof value === 'string') return value
    if (value === undefined) return undefined
    // Repeated headers are ambiguous for a single assertion; refuse rather than pick one.
    return value.length === 1 ? value[0] : undefined
  }
  return undefined
}

/**
 * Read the assertion a trusted proxy attached to one request.
 * @param headers - request headers from either the Fetch or node:http carrier.
 * @param name - configured assertion header name.
 * @returns the assertion text, or undefined when the header is absent or ambiguous.
 */
export function readAssertion(
  headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>,
  name: string,
): string | undefined {
  const value = readHeader(headers, name)
  if (value === undefined || value === '') return undefined
  return value
}

/** Signed canonical string: context, payload segment, and pinned version. */
function canonical(payloadSegment: string): string {
  return [SIGNATURE_CONTEXT, String(ASSERTION_VERSION), payloadSegment].join(FIELD_SEPARATOR)
}

/** Constant-time equality over two base64url segments. */
function signatureMatches(expected: Buffer, actual: string): boolean {
  const decoded = Buffer.from(actual, 'base64url')
  if (decoded.length !== expected.length) return false
  return timingSafeEqual(decoded, expected)
}

/** Parsed assertion payload before policy checks. */
interface AssertionPayload {
  readonly aud: string
  readonly sub: string
  readonly sid: string
  readonly pv: number
  readonly iat: number
  readonly exp: number
}

/** Structural parse of the decoded payload; undefined when a field is missing or mistyped. */
function parsePayload(text: string): AssertionPayload | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    // A non-JSON payload is a malformed assertion, not a recoverable condition.
    void error
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const { aud, sub, sid, pv, iat, exp, v } = record
  if (v !== ASSERTION_VERSION) return undefined
  if (typeof aud !== 'string' || typeof sub !== 'string' || typeof sid !== 'string') return undefined
  if (typeof pv !== 'number' || !Number.isInteger(pv) || pv < 0) return undefined
  if (typeof iat !== 'number' || !Number.isFinite(iat) || typeof exp !== 'number' || !Number.isFinite(exp)) return undefined
  return { aud, sub, sid, pv, iat, exp }
}

/**
 * Verify one assertion against this instance's policy.
 * @param assertion - assertion text read from the configured header.
 * @param policy - secret, audience, served subject, and accepted time window.
 * @param nowMs - current time in milliseconds, injected for deterministic tests.
 * @returns the admitted identity, or the reason the assertion is refused.
 */
export function verifyAssertion(assertion: string, policy: AssertionPolicy, nowMs: number = Date.now()): AssertionResult {
  const parts = assertion.split(FIELD_SEPARATOR)
  if (parts.length !== 2) return { ok: false, reason: 'malformed' }
  const [payloadSegment, signature] = parts
  if (payloadSegment === undefined || signature === undefined || payloadSegment === '' || signature === '') {
    return { ok: false, reason: 'malformed' }
  }
  const expected = createHmac('sha256', policy.secret).update(canonical(payloadSegment)).digest()
  // The signature is checked before the payload is trusted for any policy decision.
  if (!signatureMatches(expected, signature)) return { ok: false, reason: 'signature' }
  let payloadText: string
  try {
    payloadText = Buffer.from(payloadSegment, 'base64url').toString('utf8')
  } catch (error) {
    // Invalid base64url is indistinguishable from a malformed payload.
    void error
    return { ok: false, reason: 'malformed' }
  }
  const payload = parsePayload(payloadText)
  if (payload === undefined) return { ok: false, reason: 'version' }
  if (payload.aud !== policy.audience) return { ok: false, reason: 'audience' }
  if (payload.sub !== policy.subject) return { ok: false, reason: 'subject' }
  const lifetime = payload.exp - payload.iat
  if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > policy.maxLifetimeSeconds) {
    return { ok: false, reason: 'lifetime' }
  }
  const nowSeconds = nowMs / 1000
  if (payload.iat - policy.clockSkewSeconds > nowSeconds) return { ok: false, reason: 'not-yet-valid' }
  if (payload.exp + policy.clockSkewSeconds <= nowSeconds) return { ok: false, reason: 'expired' }
  return {
    ok: true,
    identity: { subject: payload.sub, sessionId: payload.sid, permissionVersion: payload.pv },
  }
}
