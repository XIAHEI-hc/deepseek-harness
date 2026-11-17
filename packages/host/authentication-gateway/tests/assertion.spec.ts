/** Assertion parsing and policy checks, exercised against an independent signer. */
import { createHmac } from 'node:crypto'
import { expect, it } from 'vitest'
import { readAssertion, verifyAssertion, type AssertionPolicy } from '../src/assertion.ts'

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
