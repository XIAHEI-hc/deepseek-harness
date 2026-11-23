/**
 * Ed25519 version 2 gateway-identity assertion signing.
 *
 * The gateway holds the only private key; each per-user runtime receives the
 * public half and accepts one assertion per request. The claim set and the
 * canonical signed message follow the runtime verifier in
 * `packages/host/authentication-gateway/src/assertion.ts`: the header value is
 * `<base64url(payload)>.<base64url(signature)>`, and the signature covers
 * `dsh-gateway-identity.2.<base64url(payload)>`. The version and context text is
 * part of the signed message, never part of the transmitted header, because the
 * verifier splits the header on `.` and expects exactly two segments.
 *
 * @module @deepseek-ai/dsh-platform-services/gateway/signer
 */

import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign as signEd25519,
  type KeyObject,
} from 'node:crypto'
import { readFileSync } from 'node:fs'

/** Header the runtime reads the gateway assertion from. */
export const GATEWAY_ASSERTION_HEADER = 'x-dsh-gateway-identity'

/** Domain separator of the canonical signed message. */
const SIGNATURE_CONTEXT = 'dsh-gateway-identity'

/** Claim version carried by gateway assertions. */
const ASSERTION_VERSION = 2

/** Identity facts one assertion binds to a request. */
export interface AssertionClaims {
  /** Subject the target runtime serves; the internal user id for this deployment. */
  readonly subject: string
  /** Platform session that authorized the request. */
  readonly sessionId: string
  /** User permission version at signing time; a later change revokes the session. */
  readonly permissionVersion: number
  /** Runtime generation the assertion is bound to; a restart increments it. */
  readonly generation: number
}

/** Signing configuration resolved from the gateway config. */
export interface AssertionSignerConfig {
  /** PEM Ed25519 private key file; only the gateway may read it. */
  readonly privateKeyFile: string
  /** Assertion issuer claim. */
  readonly issuer: string
  /** Assertion audience claim; one audience per deployment fleet. */
  readonly audience: string
  /** Signing key id claim; lets a runtime pin the key it trusts. */
  readonly keyId: string
  /** Assertion lifetime in seconds. */
  readonly assertionTtlSeconds: number
}

/** Mints short-lived assertions the runtime verifies. */
export interface AssertionSigner {
  /** Issuer claim every assertion carries. */
  readonly issuer: string
  /** Audience claim every assertion carries. */
  readonly audience: string
  /** Key id claim every assertion carries. */
  readonly keyId: string
  /** PEM public key matching the private key; provisioned to each runtime. */
  readonly publicKeyPem: string
  /**
   * Mint one assertion.
   * @param claims - subject, session, permission version, and runtime generation.
   * @param nowMs - signing instant in milliseconds; defaults to `Date.now()`.
   * @returns the `payload.signature` header value the runtime verifies.
   */
  sign(claims: AssertionClaims, nowMs?: number): string
}

/** Payload claim names, in the documented order, signed as JSON. */
interface AssertionPayload {
  readonly v: 2
  readonly iss: string
  readonly aud: string
  readonly sub: string
  readonly sid: string
  readonly pv: number
  readonly gen: number
  readonly iat: number
  readonly exp: number
  readonly jti: string
  readonly kid: string
}

/**
 * Parse the configured PEM private key and refuse anything that is not Ed25519.
 * @param privateKeyFile - configured private key path.
 * @returns the parsed key object.
 * @throws {Error} when the file is unreadable, unparsable, or not Ed25519.
 */
function loadPrivateKey(privateKeyFile: string): KeyObject {
  let pem: string
  try {
    pem = readFileSync(privateKeyFile, 'utf8')
  } catch (error) {
    // The path names deployment-owned key material; the message names the
    // misconfiguration without echoing file content or the caught error.
    void error
    throw new Error(`gateway: signing private key file ${JSON.stringify(privateKeyFile)} could not be read`)
  }
  let key: KeyObject
  try {
    key = createPrivateKey(pem)
  } catch (error) {
    // A non-PEM file is a configuration failure; key text must not reach logs.
    void error
    throw new Error('gateway: signing private key is not a parseable PEM private key')
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`gateway: signing key must be Ed25519, got ${String(key.asymmetricKeyType)}`)
  }
  return key
}

/**
 * Build the assertion signer from the gateway configuration.
 * @param config - private key file, issuer, audience, key id, and assertion lifetime.
 * @returns the signer bound to that key and those claims.
 * @throws {Error} when the key cannot be read or is not an Ed25519 private key.
 */
export function createAssertionSigner(config: AssertionSignerConfig): AssertionSigner {
  if (config.assertionTtlSeconds <= 0) {
    throw new Error('gateway: assertionTtlSeconds must be positive')
  }
  const privateKey = loadPrivateKey(config.privateKeyFile)
  const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()
  const { issuer, audience, keyId, assertionTtlSeconds } = config
  return {
    issuer,
    audience,
    keyId,
    publicKeyPem,
    sign(claims: AssertionClaims, nowMs: number = Date.now()): string {
      const issuedAt = Math.floor(nowMs / 1000)
      const payload: AssertionPayload = {
        v: ASSERTION_VERSION,
        iss: issuer,
        aud: audience,
        sub: claims.subject,
        sid: claims.sessionId,
        pv: claims.permissionVersion,
        gen: claims.generation,
        iat: issuedAt,
        exp: issuedAt + assertionTtlSeconds,
        jti: randomUUID(),
        kid: keyId,
      }
      const payloadSegment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
      const signed = `${SIGNATURE_CONTEXT}.${String(ASSERTION_VERSION)}.${payloadSegment}`
      const signature = signEd25519(null, Buffer.from(signed, 'utf8'), privateKey)
      return `${payloadSegment}.${signature.toString('base64url')}`
    },
  }
}
