/** Assertion parsing and policy checks, exercised against an independent signer. */
import { createHmac, createPublicKey, generateKeyPairSync, sign as signBytes, type KeyObject } from 'node:crypto'
import { expect, it } from 'vitest'
import {
  readAssertion,
  resolveVerificationMaterial,
  verifyAssertion,
  verifyGatewayAssertion,
  type AssertionAlgorithm,
  type AssertionPolicy,
  type GatewayAssertionPolicy,
} from '../src/assertion.ts'
import { ReplayWindow } from '../src/replay.ts'

const policy: AssertionPolicy = {
  secret: 's'.repeat(32),
  audience: 'pixlab-prod',
  subject: 'user-a',
  clockSkewSeconds: 30,
  maxLifetimeSeconds: 300,
}

const NOW = 1_700_000_000_000

/** Sign one assertion the way the gateway does; separate from the verifier under test. */
function sign(payload: Record<string, unknown>, secret = policy.secret): string {
  const segment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', secret)
    .update(['dsh-gateway-identity', '1', segment].join('.'))
    .digest('base64url')
  return `${segment}.${signature}`
}

/** A currently valid payload for the configured policy. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1, aud: policy.audience, sub: policy.subject, sid: 'iam-a1', pv: 4,
    iat: NOW / 1000 - 10, exp: NOW / 1000 + 60, ...overrides,
  }
}

it('admits a signed assertion for this audience and subject', () => {
  expect(verifyAssertion(sign(payload()), policy, NOW)).toEqual({
    ok: true,
    identity: { subject: 'user-a', sessionId: 'iam-a1', permissionVersion: 4 },
  })
})

it('refuses an assertion signed with another secret', () => {
  expect(verifyAssertion(sign(payload(), 'x'.repeat(32)), policy, NOW)).toEqual({ ok: false, reason: 'signature' })
})

it('refuses a tampered payload even when the original signature is kept', () => {
  const [segment, signature] = sign(payload()).split('.')
  const forged = Buffer.from(JSON.stringify(payload({ pv: 9 })), 'utf8').toString('base64url')
  expect(verifyAssertion(`${forged}.${signature}`, policy, NOW)).toEqual({ ok: false, reason: 'signature' })
  expect(segment).toBeDefined()
})

it('refuses an assertion for another audience or another subject', () => {
  expect(verifyAssertion(sign(payload({ aud: 'other' })), policy, NOW)).toEqual({ ok: false, reason: 'audience' })
  expect(verifyAssertion(sign(payload({ sub: 'user-b' })), policy, NOW)).toEqual({ ok: false, reason: 'subject' })
})

it('refuses an expired or not-yet-valid assertion outside the clock skew', () => {
  const expired = payload({ iat: NOW / 1000 - 240, exp: NOW / 1000 - 120 })
  expect(verifyAssertion(sign(expired), policy, NOW)).toEqual({ ok: false, reason: 'expired' })
  const future = payload({ iat: NOW / 1000 + 120, exp: NOW / 1000 + 300 })
  expect(verifyAssertion(sign(future), policy, NOW)).toEqual({ ok: false, reason: 'not-yet-valid' })
})

it('accepts a start inside the clock skew', () => {
  const skewed = payload({ iat: NOW / 1000 + 10, exp: NOW / 1000 + 200 })
  expect(verifyAssertion(sign(skewed), policy, NOW).ok).toBe(true)
})

it('refuses assertions whose lifetime is inverted or exceeds the policy', () => {
  expect(verifyAssertion(sign(payload({ exp: NOW / 1000 - 10 })), policy, NOW)).toEqual({ ok: false, reason: 'lifetime' })
  const long = payload({ iat: NOW / 1000, exp: NOW / 1000 + 3_600 })
  expect(verifyAssertion(sign(long), policy, NOW)).toEqual({ ok: false, reason: 'lifetime' })
})

it('refuses malformed, unsupported, and mistyped payloads', () => {
  expect(verifyAssertion('not-an-assertion', policy, NOW)).toEqual({ ok: false, reason: 'malformed' })
  expect(verifyAssertion(`${sign(payload()).split('.')[0]}.`, policy, NOW)).toEqual({ ok: false, reason: 'malformed' })
  const signedText = (text: string): string => {
    const segment = Buffer.from(text, 'utf8').toString('base64url')
    const signature = createHmac('sha256', policy.secret).update(['dsh-gateway-identity', '1', segment].join('.')).digest('base64url')
    return `${segment}.${signature}`
  }
  expect(verifyAssertion(signedText('{'), policy, NOW)).toEqual({ ok: false, reason: 'version' })
  expect(verifyAssertion(signedText('[]'), policy, NOW)).toEqual({ ok: false, reason: 'version' })
  expect(verifyAssertion(signedText(JSON.stringify(payload({ v: 2 }))), policy, NOW)).toEqual({ ok: false, reason: 'version' })
  expect(verifyAssertion(signedText(JSON.stringify(payload({ sid: 7 }))), policy, NOW)).toEqual({ ok: false, reason: 'version' })
  expect(verifyAssertion(signedText(JSON.stringify(payload({ pv: -1 }))), policy, NOW)).toEqual({ ok: false, reason: 'version' })
  expect(verifyAssertion(signedText(JSON.stringify(payload({ exp: 'soon' }))), policy, NOW)).toEqual({ ok: false, reason: 'version' })
})

it('reads the configured header from Fetch and node header representations', () => {
  expect(readAssertion(new Headers({ 'x-dsh-gateway-identity': 'a.b' }), 'x-dsh-gateway-identity')).toBe('a.b')
  expect(readAssertion({ 'X-DSH-Gateway-Identity': 'c.d' }, 'x-dsh-gateway-identity')).toBe('c.d')
  expect(readAssertion({ 'x-dsh-gateway-identity': ['e.f'] }, 'x-dsh-gateway-identity')).toBe('e.f')
  expect(readAssertion({ 'x-dsh-gateway-identity': ['e.f', 'g.h'] }, 'x-dsh-gateway-identity')).toBeUndefined()
  expect(readAssertion({ 'x-dsh-gateway-identity': undefined }, 'x-dsh-gateway-identity')).toBeUndefined()
  expect(readAssertion({}, 'x-dsh-gateway-identity')).toBeUndefined()
  expect(readAssertion({ 'x-dsh-gateway-identity': '' }, 'x-dsh-gateway-identity')).toBeUndefined()
})

/** Gateway keypair the verifier under test knows only through its public half. */
const signer = generateKeyPairSync('ed25519')
/** Another gateway keypair, never configured on this instance. */
const otherSigner = generateKeyPairSync('ed25519')

/** Policy verifying version 2 assertions with the generated Ed25519 public key. */
const ed25519Policy: GatewayAssertionPolicy = {
  algorithm: 'ed25519',
  secret: undefined,
  publicKey: createPublicKey(signer.publicKey.export({ type: 'spki', format: 'pem' }).toString()),
  audience: policy.audience,
  subject: policy.subject,
  clockSkewSeconds: policy.clockSkewSeconds,
  maxLifetimeSeconds: policy.maxLifetimeSeconds,
}

/** Shared HMAC secret configured on the version 2 HMAC policy. */
const gatewaySecret = 's'.repeat(32)

/** Policy verifying version 2 assertions with the shared HMAC secret. */
const hmacPolicy: GatewayAssertionPolicy = {
  algorithm: 'hmac-sha256',
  secret: gatewaySecret,
  publicKey: undefined,
  audience: policy.audience,
  subject: policy.subject,
  clockSkewSeconds: policy.clockSkewSeconds,
  maxLifetimeSeconds: policy.maxLifetimeSeconds,
}

/** Canonical JSON the gateway signs: sorted keys and `,`/`:` separators without padding. */
function canonicalJson(claim: Record<string, unknown>): string {
  const sorted = Object.entries(claim).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  return JSON.stringify(Object.fromEntries(sorted))
}

/** A currently valid version 2 payload for the configured policy. */
function gatewayPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 2,
    iss: 'pixlab-gateway',
    aud: policy.audience,
    sub: policy.subject,
    sid: 'iam-session',
    pv: 3,
    gen: 3,
    iat: NOW / 1000 - 10,
    exp: NOW / 1000 + 60,
    jti: 'jti-1',
    kid: 'pixlab-gateway-2026-01',
    ...overrides,
  }
}

/** Sign one version 2 assertion the way the Ed25519 gateway does. */
function signGateway(payload: Record<string, unknown>, privateKey: KeyObject = signer.privateKey): string {
  const segment = Buffer.from(canonicalJson(payload), 'utf8').toString('base64url')
  const signature = signBytes(null, Buffer.from(`dsh-gateway-identity.2.${segment}`, 'utf8'), privateKey)
  return `${segment}.${signature.toString('base64url')}`
}

/** Sign one version 2 assertion the way the HMAC gateway does. */
function signGatewayHmac(payload: Record<string, unknown>, secret = gatewaySecret): string {
  const segment = Buffer.from(canonicalJson(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', secret).update(`dsh-gateway-identity.2.${segment}`).digest('base64url')
  return `${segment}.${signature}`
}

it('admits a version 2 Ed25519 assertion with the facts the gateway asserts', () => {
  expect(verifyGatewayAssertion(signGateway(gatewayPayload()), ed25519Policy, NOW)).toEqual({
    ok: true,
    identity: {
      subject: 'user-a',
      sessionId: 'iam-session',
      permissionVersion: 3,
      generation: 3,
      assertionId: 'jti-1',
      issuer: 'pixlab-gateway',
    },
  })
})

it('admits a version 2 HMAC assertion under the configured algorithm', () => {
  expect(verifyGatewayAssertion(signGatewayHmac(gatewayPayload()), hmacPolicy, NOW)).toHaveProperty('ok', true)
  expect(verifyGatewayAssertion(signGatewayHmac(gatewayPayload({ aud: 'other' })), hmacPolicy, NOW))
    .toEqual({ ok: false, reason: 'audience' })
  expect(verifyGatewayAssertion(signGatewayHmac(gatewayPayload(), 'x'.repeat(32)), hmacPolicy, NOW))
    .toEqual({ ok: false, reason: 'signature' })
})

it('refuses a version 2 assertion for another audience or another subject', () => {
  expect(verifyGatewayAssertion(signGateway(gatewayPayload({ aud: 'other' })), ed25519Policy, NOW))
    .toEqual({ ok: false, reason: 'audience' })
  expect(verifyGatewayAssertion(signGateway(gatewayPayload({ sub: 'user-b' })), ed25519Policy, NOW))
    .toEqual({ ok: false, reason: 'subject' })
})

it('refuses a version 2 assertion when the configured issuer differs', () => {
  const pinned: GatewayAssertionPolicy = { ...ed25519Policy, issuer: 'pixlab-gateway' }
  expect(verifyGatewayAssertion(signGateway(gatewayPayload()), pinned, NOW)).toHaveProperty('ok', true)
  expect(verifyGatewayAssertion(signGateway(gatewayPayload({ iss: 'other-gateway' })), pinned, NOW))
    .toEqual({ ok: false, reason: 'issuer' })
})

it('refuses a version 2 assertion when the configured key id differs', () => {
  const pinned: GatewayAssertionPolicy = { ...ed25519Policy, keyId: 'pixlab-gateway-2026-01' }
  expect(verifyGatewayAssertion(signGateway(gatewayPayload()), pinned, NOW)).toHaveProperty('ok', true)
  expect(verifyGatewayAssertion(signGateway(gatewayPayload({ kid: 'other-key' })), pinned, NOW))
    .toEqual({ ok: false, reason: 'key-id' })
})

it('refuses a version 2 assertion when the configured generation differs', () => {
  const pinned: GatewayAssertionPolicy = { ...ed25519Policy, generation: 3 }
  expect(verifyGatewayAssertion(signGateway(gatewayPayload()), pinned, NOW)).toHaveProperty('ok', true)
  expect(verifyGatewayAssertion(signGateway(gatewayPayload({ gen: 4 })), pinned, NOW))
    .toEqual({ ok: false, reason: 'generation' })
})

it('refuses an expired or not-yet-valid version 2 assertion outside the clock skew', () => {
  const expired = gatewayPayload({ iat: NOW / 1000 - 240, exp: NOW / 1000 - 120 })
  expect(verifyGatewayAssertion(signGateway(expired), ed25519Policy, NOW)).toEqual({ ok: false, reason: 'expired' })
  const future = gatewayPayload({ iat: NOW / 1000 + 120, exp: NOW / 1000 + 300 })
  expect(verifyGatewayAssertion(signGateway(future), ed25519Policy, NOW)).toEqual({ ok: false, reason: 'not-yet-valid' })
})

it('refuses a tampered version 2 payload even when the original signature is kept', () => {
  const [segment, signature] = signGateway(gatewayPayload()).split('.')
  const forged = Buffer.from(canonicalJson(gatewayPayload({ pv: 9 })), 'utf8').toString('base64url')
  expect(verifyGatewayAssertion(`${forged}.${signature}`, ed25519Policy, NOW)).toEqual({ ok: false, reason: 'signature' })
  expect(segment).toBeDefined()
})

it('refuses a version 2 assertion signed by another key', () => {
  expect(verifyGatewayAssertion(signGateway(gatewayPayload(), otherSigner.privateKey), ed25519Policy, NOW))
    .toEqual({ ok: false, reason: 'signature' })
})

it('refuses a version 1 assertion under the Ed25519 algorithm', () => {
  expect(verifyGatewayAssertion(sign(payload()), ed25519Policy, NOW)).toEqual({ ok: false, reason: 'version' })
})

it('refuses version 2 claims that are missing or mistyped', () => {
  for (const field of ['iss', 'aud', 'sub', 'sid', 'pv', 'gen', 'iat', 'exp', 'jti', 'kid']) {
    // An undefined claim is absent from the signed JSON, so this covers a missing required field.
    const missing = gatewayPayload({ [field]: undefined })
    expect(verifyGatewayAssertion(signGateway(missing), ed25519Policy, NOW)).toEqual({ ok: false, reason: 'payload' })
  }
  expect(verifyGatewayAssertion(signGateway(gatewayPayload({ jti: '' })), ed25519Policy, NOW))
    .toEqual({ ok: false, reason: 'payload' })
  expect(verifyGatewayAssertion(signGateway(gatewayPayload({ pv: -1 })), ed25519Policy, NOW))
    .toEqual({ ok: false, reason: 'payload' })
  expect(verifyGatewayAssertion(signGateway(gatewayPayload({ gen: 0 })), ed25519Policy, NOW))
    .toEqual({ ok: false, reason: 'payload' })
  expect(verifyGatewayAssertion(signGateway(gatewayPayload({ exp: 'soon' })), ed25519Policy, NOW))
    .toEqual({ ok: false, reason: 'payload' })
  expect(verifyGatewayAssertion('not-an-assertion', ed25519Policy, NOW)).toEqual({ ok: false, reason: 'malformed' })
  expect(verifyGatewayAssertion(`${signGateway(gatewayPayload()).split('.')[0]}.`, ed25519Policy, NOW))
    .toEqual({ ok: false, reason: 'malformed' })
})

it('admits a version 2 assertion once and refuses the repeat inside the replay window', () => {
  const replay: GatewayAssertionPolicy = { ...ed25519Policy, replay: new ReplayWindow(60) }
  const assertion = signGateway(gatewayPayload())
  expect(verifyGatewayAssertion(assertion, replay, NOW)).toHaveProperty('ok', true)
  expect(verifyGatewayAssertion(assertion, replay, NOW + 1000)).toEqual({ ok: false, reason: 'replay' })
})

it('accepts a repeated assertion when no replay window is configured', () => {
  const assertion = signGateway(gatewayPayload())
  expect(verifyGatewayAssertion(assertion, ed25519Policy, NOW)).toHaveProperty('ok', true)
  expect(verifyGatewayAssertion(assertion, ed25519Policy, NOW)).toHaveProperty('ok', true)
})

it('forgets an assertion id once its replay window ends', () => {
  const replay: GatewayAssertionPolicy = { ...ed25519Policy, replay: new ReplayWindow(60) }
  const assertion = signGateway(gatewayPayload())
  expect(verifyGatewayAssertion(assertion, replay, NOW)).toHaveProperty('ok', true)
  expect(verifyGatewayAssertion(assertion, replay, NOW + 60_001)).toHaveProperty('ok', true)
})

it('keeps the replay window bounded by sweeping ended entries first', () => {
  const replay = new ReplayWindow(60)
  replay.remember('first', NOW)
  replay.remember('second', NOW + 5_000)
  expect(replay.has('first', NOW + 30_000)).toBe(true)
  expect(replay.has('first', NOW + 60_001)).toBe(false)
  expect(replay.has('second', NOW + 60_001)).toBe(true)
})

it('keeps a version 2 payload signed over the version 1 framing a version rejection', () => {
  expect(verifyGatewayAssertion(sign(payload({ v: 2 })), hmacPolicy, NOW)).toEqual({ ok: false, reason: 'version' })
})

/** Sign one version 2 assertion over arbitrary payload text. */
function signGatewayText(text: string, privateKey: KeyObject = signer.privateKey): string {
  const segment = Buffer.from(text, 'utf8').toString('base64url')
  const signature = signBytes(null, Buffer.from(`dsh-gateway-identity.2.${segment}`, 'utf8'), privateKey)
  return `${segment}.${signature.toString('base64url')}`
}

it('refuses a signed payload that is not a version 2 claim object', () => {
  expect(verifyGatewayAssertion(signGatewayText('{'), ed25519Policy, NOW)).toEqual({ ok: false, reason: 'version' })
  expect(verifyGatewayAssertion(signGatewayText('[]'), ed25519Policy, NOW)).toEqual({ ok: false, reason: 'version' })
  expect(verifyGatewayAssertion(signGatewayText('{"aud":"pixlab-prod"}'), ed25519Policy, NOW))
    .toEqual({ ok: false, reason: 'version' })
})

it('refuses a version 2 assertion with a malformed signature segment', () => {
  expect(verifyGatewayAssertion(`${signGateway(gatewayPayload()).split('.')[0]}.AA`, ed25519Policy, NOW))
    .toEqual({ ok: false, reason: 'signature' })
  expect(verifyGatewayAssertion(`${signGatewayHmac(gatewayPayload()).split('.')[0]}.AA`, hmacPolicy, NOW))
    .toEqual({ ok: false, reason: 'signature' })
})

it('refuses a version 2 assertion whose lifetime is inverted or exceeds the policy', () => {
  const inverted = gatewayPayload({ iat: NOW / 1000, exp: NOW / 1000 - 10 })
  expect(verifyGatewayAssertion(signGateway(inverted), ed25519Policy, NOW)).toEqual({ ok: false, reason: 'lifetime' })
  const long = gatewayPayload({ iat: NOW / 1000 - 5, exp: NOW / 1000 + 3_600 })
  expect(verifyGatewayAssertion(signGateway(long), ed25519Policy, NOW)).toEqual({ ok: false, reason: 'lifetime' })
})

it('refuses a version 2 assertion when the policy holds no matching key material', () => {
  expect(verifyGatewayAssertion(signGatewayHmac(gatewayPayload()), { ...hmacPolicy, secret: undefined }, NOW))
    .toEqual({ ok: false, reason: 'signature' })
  expect(verifyGatewayAssertion(signGateway(gatewayPayload()), { ...ed25519Policy, publicKey: undefined }, NOW))
    .toEqual({ ok: false, reason: 'signature' })
})

it('rejects a policy whose signature algorithm is outside the closed union', () => {
  expect(() => verifyGatewayAssertion(signGateway(gatewayPayload()), { ...ed25519Policy, algorithm: 'rsa' as AssertionAlgorithm }, NOW))
    .toThrow(/assertion signature algorithm/)
  expect(() => resolveVerificationMaterial({ algorithm: 'rsa' as AssertionAlgorithm })).toThrow(/verification algorithm/)
})

it('keeps the version 1 entry point from accepting a version 2 payload', () => {
  expect(verifyAssertion(signGatewayHmac(gatewayPayload()), policy, NOW)).toEqual({ ok: false, reason: 'version' })
})

it('reads no assertion from Fetch headers that omit it', () => {
  expect(readAssertion(new Headers(), 'x-dsh-gateway-identity')).toBeUndefined()
})
