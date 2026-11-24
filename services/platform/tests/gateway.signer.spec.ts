/** Gateway assertion signing, checked against the runtime's own verifier. */
import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  verifyGatewayAssertion,
  type GatewayAssertionPolicy,
} from '../../../packages/host/authentication-gateway/src/assertion.ts'
import { ReplayWindow } from '../../../packages/host/authentication-gateway/src/replay.ts'
import {
  createAssertionSigner,
  GATEWAY_ASSERTION_HEADER,
  type AssertionClaims,
  type AssertionSignerConfig,
} from '../src/gateway/signer.ts'
import type { PlatformConfig } from '../src/config.ts'
import {
  buildGatewayAssertionPolicy,
  createGatewayTestConfig,
  createTestSigner,
  decodeAssertionPayload,
  FakeIdentityService,
  FakeRuntimeManager,
  removeGatewayTestConfig,
  signRawAssertion,
  testUser,
  type TestSigner,
} from './gateway.fakes.ts'
import { createGateway } from '../src/gateway/index.ts'

/** Fixed signing instant for deterministic lifetime checks. */
const NOW = 1_800_000_000_000

/** User and runtime a correctly signed assertion describes. */
const claims: AssertionClaims = {
  subject: testUser('user-a').id,
  sessionId: 'session-a',
  permissionVersion: 4,
  generation: 3,
}

let config: PlatformConfig
let signer: TestSigner

function setup(overrides: { assertionTtlSeconds?: number } = {}): void {
  config = createGatewayTestConfig(overrides)
  signer = createTestSigner(config)
}

afterEach(() => {
  if (config !== undefined) removeGatewayTestConfig(config)
})

type PolicyOptions = Parameters<typeof buildGatewayAssertionPolicy>[0]

/** Policy matching the test signer and the identity facts the assertion describes. */
function policy(overrides: Partial<PolicyOptions> = {}): GatewayAssertionPolicy {
  return buildGatewayAssertionPolicy({
    signer: signer.signer,
    subject: claims.subject,
    audience: config.gateway.audience,
    maxLifetimeSeconds: config.gateway.maxAssertionLifetimeSeconds,
    ...overrides,
  })
}

/** Signer config for the current test configuration. */
function signerConfig(): AssertionSignerConfig {
  return {
    privateKeyFile: config.gateway.privateKeyFile,
    issuer: config.gateway.issuer,
    audience: config.gateway.audience,
    keyId: config.gateway.keyId,
    assertionTtlSeconds: config.gateway.assertionTtlSeconds,
  }
}

describe('gateway assertion signer', () => {
  it('mints the two-segment wire form the runtime verifier accepts', () => {
    setup()
    const assertion = signer.signer.sign(claims, NOW)
    expect(assertion.split('.')).toHaveLength(2)
    expect(assertion.startsWith('dsh-gateway-identity')).toBe(false)
    const result = verifyGatewayAssertion(assertion, policy(), NOW)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.identity).toMatchObject({
      subject: claims.subject,
      sessionId: claims.sessionId,
      permissionVersion: claims.permissionVersion,
      generation: claims.generation,
      issuer: config.gateway.issuer,
    })
    expect(typeof result.identity.assertionId).toBe('string')
  })

  it('carries the complete version 2 claim set with the configured facts', () => {
    setup()
    const assertion = signer.signer.sign(claims, NOW)
    const payload = decodeAssertionPayload(assertion)
    expect(payload).toMatchObject({
      v: 2,
      iss: config.gateway.issuer,
      aud: config.gateway.audience,
      sub: claims.subject,
      sid: claims.sessionId,
      pv: claims.permissionVersion,
      gen: claims.generation,
      iat: NOW / 1000,
      exp: NOW / 1000 + config.gateway.assertionTtlSeconds,
      kid: config.gateway.keyId,
    })
    expect(typeof payload.jti).toBe('string')
    expect(payload.jti).not.toBe('')
    expect(payload.exp).toBe((payload.iat as number) + config.gateway.assertionTtlSeconds)
    expect(GATEWAY_ASSERTION_HEADER).toBe('x-dsh-gateway-identity')
  })

  it('uses a fresh assertion id for every signature', () => {
    setup()
    const first = decodeAssertionPayload(signer.signer.sign(claims, NOW))
    const second = decodeAssertionPayload(signer.signer.sign(claims, NOW))
    expect(first.jti).not.toBe(second.jti)
  })

  it('refuses a tampered payload that keeps the original signature', () => {
    setup()
    const [segment, signature] = signer.signer.sign(claims, NOW).split('.')
    const payload = decodeAssertionPayload(`${segment ?? ''}.${signature ?? ''}`)
    const forged = Buffer.from(JSON.stringify({ ...payload, pv: 99 }), 'utf8').toString('base64url')
    expect(verifyGatewayAssertion(`${forged}.${signature ?? ''}`, policy(), NOW))
      .toEqual({ ok: false, reason: 'signature' })
  })

  it('refuses a tampered signature', () => {
    setup()
    const [segment] = signer.signer.sign(claims, NOW).split('.')
    expect(verifyGatewayAssertion(`${segment ?? ''}.AA`, policy(), NOW))
      .toEqual({ ok: false, reason: 'signature' })
  })

  it('refuses an expired assertion', () => {
    setup()
    const assertion = signer.signer.sign(claims, NOW)
    expect(verifyGatewayAssertion(assertion, policy(), NOW)).toHaveProperty('ok', true)
    const later = NOW + (config.gateway.assertionTtlSeconds + 60) * 1000
    expect(verifyGatewayAssertion(assertion, policy(), later)).toEqual({ ok: false, reason: 'expired' })
  })

  it('refuses an assertion signed by another key', () => {
    setup()
    const otherConfig = createGatewayTestConfig()
    try {
      const foreign = createTestSigner(otherConfig).signer.sign(claims, NOW)
      expect(verifyGatewayAssertion(foreign, policy(), NOW)).toEqual({ ok: false, reason: 'signature' })
    } finally {
      removeGatewayTestConfig(otherConfig)
    }
  })

  it('refuses mismatched issuer, audience, subject, key id, and generation claims', () => {
    setup()
    const assertion = signer.signer.sign(claims, NOW)
    expect(verifyGatewayAssertion(assertion, policy({ issuer: 'other-gateway' }), NOW))
      .toEqual({ ok: false, reason: 'issuer' })
    expect(verifyGatewayAssertion(assertion, policy({ audience: 'other-audience' }), NOW))
      .toEqual({ ok: false, reason: 'audience' })
    expect(verifyGatewayAssertion(assertion, policy({ subject: 'someone-else' }), NOW))
      .toEqual({ ok: false, reason: 'subject' })
    expect(verifyGatewayAssertion(assertion, policy({ keyId: 'other-key' }), NOW))
      .toEqual({ ok: false, reason: 'key-id' })
    expect(verifyGatewayAssertion(assertion, policy({ generation: claims.generation + 1 }), NOW))
      .toEqual({ ok: false, reason: 'generation' })
  })

  it('refuses a replayed assertion id inside the runtime replay window', () => {
    setup()
    const replay = new ReplayWindow(config.gateway.replayWindowSeconds)
    const replayPolicy = policy({ replay })
    const assertion = signer.signer.sign(claims, NOW)
    expect(verifyGatewayAssertion(assertion, replayPolicy, NOW)).toHaveProperty('ok', true)
    expect(verifyGatewayAssertion(assertion, replayPolicy, NOW + 1000)).toEqual({ ok: false, reason: 'replay' })
  })

  it('refuses a prior generation after a restart', () => {
    setup()
    const pinned = policy({ generation: claims.generation })
    expect(verifyGatewayAssertion(signer.signer.sign(claims, NOW), pinned, NOW)).toHaveProperty('ok', true)
    const restarted: AssertionClaims = { ...claims, generation: claims.generation + 1 }
    expect(verifyGatewayAssertion(signer.signer.sign(restarted, NOW), pinned, NOW))
      .toEqual({ ok: false, reason: 'generation' })
  })

  it('refuses a payload that is not a version 2 claim object', () => {
    setup()
    const v1Payload = {
      v: 1,
      aud: config.gateway.audience,
      sub: claims.subject,
      sid: claims.sessionId,
      pv: 1,
      iat: 1,
      exp: 2,
    }
    expect(verifyGatewayAssertion(signRawAssertion(signer.privateKey, v1Payload), policy(), NOW))
      .toEqual({ ok: false, reason: 'version' })
  })

  it('fails loudly when the private key file is missing', () => {
    setup()
    const missing = createGatewayTestConfig({
      privateKeyFile: `${config.gateway.privateKeyFile}.missing`,
      publicKeyFile: `${config.gateway.publicKeyFile}.missing`,
      generateKeyPairIfMissing: false,
    })
    try {
      expect(() => createAssertionSigner({
        ...signerConfig(),
        privateKeyFile: missing.gateway.privateKeyFile,
      })).toThrow(/could not be read/)
    } finally {
      removeGatewayTestConfig(missing)
    }
  })

  it('fails loudly when the private key is not Ed25519', () => {
    setup()
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    writeFileSync(config.gateway.privateKeyFile, rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
    expect(() => createAssertionSigner(signerConfig())).toThrow(/must be Ed25519/)
  })

  it('refuses an unparsable key file and a non-positive lifetime', () => {
    setup()
    writeFileSync(config.gateway.privateKeyFile, 'not a pem key')
    expect(() => createAssertionSigner(signerConfig())).toThrow(/not a parseable PEM/)
    expect(() => createAssertionSigner({ ...signerConfig(), assertionTtlSeconds: 0 }))
      .toThrow(/assertionTtlSeconds/)
  })

  it('accepts the private key it was configured with and publishes its public half', () => {
    setup()
    const signerFromFile = createAssertionSigner(signerConfig())
    expect(signerFromFile.issuer).toBe(config.gateway.issuer)
    expect(signerFromFile.audience).toBe(config.gateway.audience)
    expect(signerFromFile.keyId).toBe(config.gateway.keyId)
    expect(createPublicKey(signerFromFile.publicKeyPem).asymmetricKeyType).toBe('ed25519')
    expect(verifyGatewayAssertion(signerFromFile.sign(claims, NOW), policy(), NOW)).toHaveProperty('ok', true)
  })
})

describe('gateway factory signing material', () => {
  it('refuses to start without a signing key when auto-generation is disabled', async () => {
    setup()
    const strictConfig = createGatewayTestConfig({
      privateKeyFile: `${config.gateway.privateKeyFile}.absent`,
      publicKeyFile: `${config.gateway.publicKeyFile}.absent`,
      generateKeyPairIfMissing: false,
    })
    try {
      await expect(createGateway(strictConfig, {
        identity: new FakeIdentityService(),
        runtime: new FakeRuntimeManager(),
      })).rejects.toThrow(/could not be read/)
    } finally {
      removeGatewayTestConfig(strictConfig)
    }
  })

  it('uses an injected signer instead of touching the configured key files', async () => {
    setup()
    const injectedConfig = createGatewayTestConfig({
      privateKeyFile: `${config.gateway.privateKeyFile}.absent`,
      publicKeyFile: `${config.gateway.publicKeyFile}.absent`,
      generateKeyPairIfMissing: false,
    })
    try {
      const gateway = await createGateway(injectedConfig, {
        identity: new FakeIdentityService(),
        runtime: new FakeRuntimeManager(),
        signer: signer.signer,
      })
      expect(gateway.signer).toBe(signer.signer)
      await gateway.close()
    } finally {
      removeGatewayTestConfig(injectedConfig)
    }
  })
})
