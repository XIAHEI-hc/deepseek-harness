/**
 * Verification of the identity assertion a trusted reverse proxy attaches to a request.
 *
 * The proxy authenticates the browser against its own identity provider and signs one
 * assertion per request. Nothing here reads cookies or browser-supplied identity: an
 * assertion either verifies against this instance's configured key, audience, and served
 * subject, or the request stays unauthenticated.
 *
 * Version 1 assertions are HMAC-SHA256 over `dsh-gateway-identity.1.<payload segment>`.
 * Version 2 assertions add issuer, key id, runtime generation, and assertion id claims and
 * are signed with the configured algorithm over `dsh-gateway-identity.2.<payload segment>`,
 * so an instance may hold an Ed25519 public key instead of the shared secret.
 */
import {
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify as verifyEd25519Signature,
  type KeyObject,
} from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ReplayWindow } from './replay.ts'

/** Assertion payload version signed with the shared HMAC secret. */
const LEGACY_ASSERTION_VERSION = 1
/** Assertion payload version carrying generation binding, issuer, and replay claims. */
const GATEWAY_ASSERTION_VERSION = 2
/** Field separator inside the signed canonical string and the wire form. */
const FIELD_SEPARATOR = '.'
/** Domain separator keeping these signatures from being reused by another purpose. */
const SIGNATURE_CONTEXT = 'dsh-gateway-identity'
/** Length of a detached Ed25519 signature. */
const ED25519_SIGNATURE_BYTES = 64
/** PEM header of a private key, which would otherwise derive its public half and fail open. */
const PRIVATE_KEY_PEM = /-----BEGIN [^-]*PRIVATE KEY-----/

/** Signature algorithm a gateway signs assertions with. */
export type AssertionAlgorithm = 'hmac-sha256' | 'ed25519'

/** Identity facts a verified assertion carries. */
export interface GatewayIdentity {
  /** Identity-provider subject the proxy authenticated. */
  readonly subject: string
  /** Proxy-side session that authorized this request. */
  readonly sessionId: string
  /** Identity-provider permission version at assertion time. */
  readonly permissionVersion: number
  /** Runtime generation the gateway asserted; present for version 2 assertions. */
  readonly generation?: number | undefined
  /** Unique assertion id the gateway issued; present for version 2 assertions. */
  readonly assertionId?: string | undefined
  /** Issuer that signed the assertion; present for version 2 assertions. */
  readonly issuer?: string | undefined
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

/** Facts bounding which gateway assertions this instance accepts, and the material that verifies them. */
export interface GatewayAssertionPolicy {
  /** Signature algorithm version 2 assertions must be signed with. */
  readonly algorithm: AssertionAlgorithm
  /** Shared HMAC secret; at least 32 characters. Required when `algorithm` is `hmac-sha256`. */
  readonly secret: string | undefined
  /** Ed25519 public key; required when `algorithm` is `ed25519`. */
  readonly publicKey: KeyObject | undefined
  /** Deployment audience this instance belongs to. */
  readonly audience: string
  /** The single subject this instance serves. */
  readonly subject: string
  /** Accepted clock difference in seconds. */
  readonly clockSkewSeconds: number
  /** Longest accepted `expiresAt - issuedAt` interval in seconds. */
  readonly maxLifetimeSeconds: number
  /** Signing key id version 2 assertions must carry; absent accepts any key id. */
  readonly keyId?: string | undefined
  /** Issuer version 2 assertions must carry; absent accepts any issuer. */
  readonly issuer?: string | undefined
  /** Runtime generation version 2 assertions must carry; absent accepts any generation. */
  readonly generation?: number | undefined
  /** Replay memory shared by all requests this instance admits; absent accepts repeats. */
  readonly replay?: ReplayWindow | undefined
}

/** Policy fields the verification helper reads; version 1 accepts no algorithm. */
interface VerificationPolicy {
  readonly secret: string | undefined
  readonly audience: string
  readonly subject: string
  readonly clockSkewSeconds: number
  readonly maxLifetimeSeconds: number
  readonly algorithm?: AssertionAlgorithm | undefined
  readonly publicKey?: KeyObject | undefined
  readonly keyId?: string | undefined
  readonly issuer?: string | undefined
  readonly generation?: number | undefined
  readonly replay?: ReplayWindow | undefined
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
  /** A version 2 payload is missing a required claim or carries a mistyped one. */
  | 'payload'
  | 'issuer'
  | 'key-id'
  | 'generation'
  | 'replay'

/** Verification outcome: the identity to admit or the reason it is refused. */
export type AssertionResult =
  | { readonly ok: true; readonly identity: GatewayIdentity }
  | { readonly ok: false; readonly reason: AssertionRejection }

/** Verification material as configured, before the public key is parsed. */
export interface VerificationConfig {
  /** Signature algorithm version 2 assertions use. */
  readonly algorithm: AssertionAlgorithm
  /** Shared HMAC secret; required when `algorithm` is `hmac-sha256`. */
  readonly secret?: string | undefined
  /** PEM Ed25519 public key text; used when `algorithm` is `ed25519`. */
  readonly publicKey?: string | undefined
  /** Path to a PEM Ed25519 public key; used when `algorithm` is `ed25519` and `publicKey` is absent. */
  readonly publicKeyFile?: string | undefined
}

/** Parsed material an assertion policy verifies signatures with. */
export interface VerificationMaterial {
  /** Signature algorithm version 2 assertions use. */
  readonly algorithm: AssertionAlgorithm
  /** Shared HMAC secret, present only for `hmac-sha256`. */
  readonly secret: string | undefined
  /** Ed25519 public key, present only for `ed25519`. */
  readonly publicKey: KeyObject | undefined
}

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

/** Exhaustiveness check for a closed union. */
function assertNever(value: never, context: string): never {
  throw new TypeError(`${context}: unhandled ${JSON.stringify(value)}`)
}

/** Signed canonical string for one assertion version and payload segment. */
function signedMessage(version: number, payloadSegment: string): string {
  return [SIGNATURE_CONTEXT, String(version), payloadSegment].join(FIELD_SEPARATOR)
}

/**
 * Decode one base64url payload segment as UTF-8 text.
 *
 * Decoding a string with base64url is total: characters outside the alphabet are ignored.
 * @param payloadSegment - the payload half of the wire form.
 * @returns the decoded text.
 */
function decodePayloadSegment(payloadSegment: string): string {
  return Buffer.from(payloadSegment, 'base64url').toString('utf8')
}

/**
 * Parse the payload segment as a JSON object, the only container a claim set can have.
 * @param payloadText - decoded payload text.
 * @returns the parsed object, or undefined when the text is not a JSON object.
 */
function parsePayloadObject(payloadText: string): Record<string, unknown> | undefined {
  let value: unknown
  try {
    value = JSON.parse(payloadText)
  } catch (error) {
    // A signed but non-JSON payload carries no version claim and is handled as version 1.
    void error
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Constant-time comparison of an expected HMAC digest with the wire signature segment. */
function hmacMatches(message: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(message).digest()
  const actual = Buffer.from(signature, 'base64url')
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

/**
 * Detached Ed25519 verification of the wire signature segment.
 *
 * The key is an Ed25519 public key this instance parsed at load, so node:crypto answers
 * `false` for every signature it cannot match instead of reporting an error.
 */
function ed25519Matches(message: string, signature: string, publicKey: KeyObject): boolean {
  const actual = Buffer.from(signature, 'base64url')
  if (actual.length !== ED25519_SIGNATURE_BYTES) return false
  return verifyEd25519Signature(null, Buffer.from(message, 'utf8'), publicKey, actual)
}
/** Check one wire signature with the algorithm a policy names. */
function signatureMatches(
  message: string,
  signature: string,
  algorithm: AssertionAlgorithm,
  policy: VerificationPolicy,
): boolean {
  switch (algorithm) {
    case 'hmac-sha256':
      return policy.secret !== undefined && hmacMatches(message, signature, policy.secret)
    case 'ed25519':
      return policy.publicKey !== undefined && ed25519Matches(message, signature, policy.publicKey)
    default:
      return assertNever(algorithm, 'assertion signature algorithm')
  }
}

/** Parsed version 1 payload before policy checks. */
interface LegacyPayload {
  readonly aud: string
  readonly sub: string
  readonly sid: string
  readonly pv: number
  readonly iat: number
  readonly exp: number
}

/** Structural parse of a version 1 payload; undefined when a field is missing or mistyped. */
function parseLegacyPayload(text: string): LegacyPayload | undefined {
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
  if (v !== LEGACY_ASSERTION_VERSION) return undefined
  if (typeof aud !== 'string' || typeof sub !== 'string' || typeof sid !== 'string') return undefined
  if (typeof pv !== 'number' || !Number.isInteger(pv) || pv < 0) return undefined
  if (typeof iat !== 'number' || !Number.isFinite(iat) || typeof exp !== 'number' || !Number.isFinite(exp)) return undefined
  return { aud, sub, sid, pv, iat, exp }
}

/** Structural test for a non-empty string claim. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/** Structural test for a finite integer claim. */
function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

/**
 * Apply the version 1 policy to a payload whose version 1 signature already verified.
 * @param payloadText - authenticated payload text.
 * @param policy - audience, served subject, and accepted time window.
 * @param nowMs - current time in milliseconds.
 * @returns the admitted identity, or the reason the payload is refused.
 */
function verifyLegacyPayload(payloadText: string, policy: VerificationPolicy, nowMs: number): AssertionResult {
  const payload = parseLegacyPayload(payloadText)
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

/**
 * Apply the version 2 policy to an authenticated claim set.
 * @param claim - parsed payload whose `v` selected the version 2 framing.
 * @param policy - audience, served subject, optional claims, time window, and replay memory.
 * @param nowMs - current time in milliseconds.
 * @returns the admitted identity, or the reason the payload is refused.
 */
function verifyGatewayPayload(
  claim: Record<string, unknown>,
  policy: VerificationPolicy,
  nowMs: number,
): AssertionResult {
  const { iss, aud, sub, sid, pv, gen, iat, exp, jti, kid } = claim
  if (!isNonEmptyString(iss) || !isNonEmptyString(aud) || !isNonEmptyString(sub)) {
    return { ok: false, reason: 'payload' }
  }
  if (typeof sid !== 'string') return { ok: false, reason: 'payload' }
  if (!isInteger(pv) || pv < 0) return { ok: false, reason: 'payload' }
  if (!isInteger(gen) || gen < 1) return { ok: false, reason: 'payload' }
  if (!isInteger(iat) || !isInteger(exp)) return { ok: false, reason: 'payload' }
  if (!isNonEmptyString(jti) || !isNonEmptyString(kid)) return { ok: false, reason: 'payload' }
  if (aud !== policy.audience) return { ok: false, reason: 'audience' }
  if (sub !== policy.subject) return { ok: false, reason: 'subject' }
  if (policy.issuer !== undefined && iss !== policy.issuer) return { ok: false, reason: 'issuer' }
  if (policy.keyId !== undefined && kid !== policy.keyId) return { ok: false, reason: 'key-id' }
  if (policy.generation !== undefined && gen !== policy.generation) {
    return { ok: false, reason: 'generation' }
  }
  const lifetime = exp - iat
  if (lifetime <= 0 || lifetime > policy.maxLifetimeSeconds) return { ok: false, reason: 'lifetime' }
  if (policy.replay !== undefined && policy.replay.has(jti, nowMs)) {
    return { ok: false, reason: 'replay' }
  }
  const nowSeconds = nowMs / 1000
  if (iat - policy.clockSkewSeconds > nowSeconds) return { ok: false, reason: 'not-yet-valid' }
  if (exp + policy.clockSkewSeconds <= nowSeconds) return { ok: false, reason: 'expired' }
  // Only an assertion that passed every check joins the replay window.
  policy.replay?.remember(jti, nowMs)
  return {
    ok: true,
    identity: {
      subject: sub,
      sessionId: sid,
      permissionVersion: pv,
      generation: gen,
      assertionId: jti,
      issuer: iss,
    },
  }
}

/**
 * Verify one assertion against this instance's policy.
 *
 * A signature over the version 1 framing always makes the assertion version 1, even when the
 * payload claims another version, so an unsupported `v` keeps its existing rejection reason.
 * Version 2 claims are not read for a policy decision until its signature verified.
 * @param assertion - assertion text read from the configured header.
 * @param policy - key material, audience, served subject, optional claims, and accepted time window.
 * @param nowMs - current time in milliseconds, injected for deterministic tests.
 * @returns the admitted identity, or the reason the assertion is refused.
 */
function verify(assertion: string, policy: VerificationPolicy, nowMs: number): AssertionResult {
  const parts = assertion.split(FIELD_SEPARATOR)
  if (parts.length !== 2) return { ok: false, reason: 'malformed' }
  const [payloadSegment, signature] = parts
  if (payloadSegment === undefined || signature === undefined || payloadSegment === '' || signature === '') {
    return { ok: false, reason: 'malformed' }
  }
  const payloadText = decodePayloadSegment(payloadSegment)
  if (policy.algorithm !== 'ed25519'
    && signatureMatches(signedMessage(LEGACY_ASSERTION_VERSION, payloadSegment), signature, 'hmac-sha256', policy)) {
    return verifyLegacyPayload(payloadText, policy, nowMs)
  }
  // The claimed `v` below selects the signed framing; it is not a policy decision.
  const claim = parsePayloadObject(payloadText)
  // Version 1 payloads have no Ed25519 framing, so that combination stays an unsupported version.
  if (claim?.v !== GATEWAY_ASSERTION_VERSION) {
    return { ok: false, reason: policy.algorithm === 'ed25519' ? 'version' : 'signature' }
  }
  // A policy without an algorithm accepts version 1 assertions only.
  if (policy.algorithm === undefined) return { ok: false, reason: 'version' }
  const message = signedMessage(GATEWAY_ASSERTION_VERSION, payloadSegment)
  if (!signatureMatches(message, signature, policy.algorithm, policy)) {
    return { ok: false, reason: 'signature' }
  }
  return verifyGatewayPayload(claim, policy, nowMs)
}

/**
 * Verify one version 1 assertion against this instance's HMAC secret.
 * @param assertion - assertion text read from the configured header.
 * @param policy - shared secret, audience, served subject, and accepted time window.
 * @param nowMs - current time in milliseconds, injected for deterministic tests.
 * @returns the admitted identity, or the reason the assertion is refused.
 */
export function verifyAssertion(assertion: string, policy: AssertionPolicy, nowMs: number = Date.now()): AssertionResult {
  return verify(assertion, policy, nowMs)
}

/**
 * Verify one gateway assertion, accepting version 1 assertions only under `hmac-sha256` and
 * version 2 assertions under the configured algorithm.
 * @param assertion - assertion text read from the configured header.
 * @param policy - key material, audience, served subject, accepted claims, time window, and replay memory.
 * @param nowMs - current time in milliseconds, injected for deterministic tests.
 * @returns the admitted identity, or the reason the assertion is refused.
 */
export function verifyGatewayAssertion(
  assertion: string,
  policy: GatewayAssertionPolicy,
  nowMs: number = Date.now(),
): AssertionResult {
  return verify(assertion, policy, nowMs)
}

/**
 * Read the PEM text a verification config names.
 * @param publicKeyFile - configured file path, or undefined when the field is absent.
 * @returns the file text, or undefined when no path was configured.
 * @throws {Error} when the file cannot be read.
 */
function readPublicKeyFile(publicKeyFile: string | undefined): string | undefined {
  if (publicKeyFile === undefined) return undefined
  try {
    return readFileSync(publicKeyFile, 'utf8')
  } catch (error) {
    throw new Error(`host-authentication-gateway: publicKeyFile "${publicKeyFile}" could not be read`, { cause: error })
  }
}

/**
 * Parse the configured Ed25519 public key.
 * @param config - verification config naming a key text or key file.
 * @returns the parsed public key.
 * @throws {Error} when no key is configured, the key is a private key, or the key is not Ed25519.
 */
function loadEd25519PublicKey(config: VerificationConfig): KeyObject {
  const keyText = config.publicKey ?? readPublicKeyFile(config.publicKeyFile)
  if (keyText === undefined) {
    throw new Error("host-authentication-gateway: algorithm 'ed25519' requires publicKey or publicKeyFile")
  }
  if (PRIVATE_KEY_PEM.test(keyText)) {
    throw new Error('host-authentication-gateway: publicKey must be an Ed25519 public key, not a private key')
  }
  let key: KeyObject
  try {
    key = createPublicKey(keyText)
  } catch (error) {
    throw new Error('host-authentication-gateway: publicKey is not a parseable PEM public key', { cause: error })
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`host-authentication-gateway: publicKey must be an Ed25519 public key, got ${String(key.asymmetricKeyType)}`)
  }
  return key
}

/**
 * Resolve the configured signing material, reading a key file when one is named.
 * @param config - signature algorithm and the key material that algorithm uses.
 * @returns the parsed algorithm, secret, and public key.
 * @throws {Error} when the configuration cannot verify an assertion of its own algorithm.
 */
export function resolveVerificationMaterial(config: VerificationConfig): VerificationMaterial {
  switch (config.algorithm) {
    case 'hmac-sha256':
      if (config.secret === undefined || config.secret.length < 32) {
        throw new Error("host-authentication-gateway: algorithm 'hmac-sha256' requires a secret of at least 32 characters")
      }
      return { algorithm: 'hmac-sha256', secret: config.secret, publicKey: undefined }
    case 'ed25519':
      return { algorithm: 'ed25519', secret: undefined, publicKey: loadEd25519PublicKey(config) }
    default:
      return assertNever(config.algorithm, 'verification algorithm')
  }
}
