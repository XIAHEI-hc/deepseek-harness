/** The gateway provider admits only verified assertions and speaks as one owner Peer. */
import { createHmac, generateKeyPairSync, sign as signBytes, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import {
  ConnectionAuthentication,
  type HostConnectionHandle,
  type PeerScope,
} from '@deepseek-ai/dsh-client-connection'
import * as Gateway from '../src/index.ts'

const roots: Context[] = []
afterEach(async () => { for (const ctx of roots.splice(0)) await ctx.fiber.dispose() })

const keyDirectories: string[] = []
afterEach(() => { for (const directory of keyDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

const secret = 'g'.repeat(32)
const config: Gateway.Config = {
  secret,
  audience: 'pixlab-prod',
  subject: 'user-a',
  headerName: 'x-dsh-gateway-identity',
  clockSkewSeconds: 30,
  maxLifetimeSeconds: 300,
}

/** The same deployment fields as plain values, for calls the config schema validates. */
const configInput = {
  secret,
  audience: 'pixlab-prod',
  subject: 'user-a',
  headerName: 'x-dsh-gateway-identity',
  clockSkewSeconds: 30,
  maxLifetimeSeconds: 300,
}

/** Sign one assertion the way the trusted proxy does. */
function sign(overrides: Record<string, unknown> = {}, signerSecret = secret): string {
  const now = Math.floor(Date.now() / 1000)
  const payload = { v: 1, aud: config.audience, sub: config.subject, sid: 'iam-a1', pv: 1, iat: now - 5, exp: now + 60, ...overrides }
  const segment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', signerSecret)
    .update(['dsh-gateway-identity', '1', segment].join('.'))
    .digest('base64url')
  return `${segment}.${signature}`
}

/** Gateway keypair; this instance receives only the exported public key. */
const signer = generateKeyPairSync('ed25519')
const publicKeyPem = signer.publicKey.export({ type: 'spki', format: 'pem' }).toString()
/** Fresh assertion id per signed payload. */
let assertionSequence = 0

/** Canonical JSON the gateway signs: sorted keys and `,`/`:` separators without padding. */
function canonicalJson(claim: Record<string, unknown>): string {
  const sorted = Object.entries(claim).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  return JSON.stringify(Object.fromEntries(sorted))
}

/** A currently valid version 2 payload for this fixture, with a fresh assertion id. */
function gatewayPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000)
  return {
    v: 2,
    iss: 'pixlab-gateway',
    aud: config.audience,
    sub: config.subject,
    sid: 'iam-session',
    pv: 3,
    gen: 3,
    iat: now - 5,
    exp: now + 60,
    jti: `jti-${++assertionSequence}`,
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
function signGatewayHmac(payload: Record<string, unknown>, signerSecret = secret): string {
  const segment = Buffer.from(canonicalJson(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', signerSecret).update(`dsh-gateway-identity.2.${segment}`).digest('base64url')
  return `${segment}.${signature}`
}

/**
 * Mount the provider over a Connection handle that records the Peers it creates.
 * @param overrides - deployment fields this case changes.
 * @param base - deployment the overrides apply to; defaults to the shared fixture.
 */
async function mounted(overrides: Partial<Gateway.Config> = {}, base: Gateway.Config = config) {
  const ctx = new Context()
  roots.push(ctx)
  const peers: PeerScope[] = []
  const shared = new AbortController()
  const createPeer = vi.fn<HostConnectionHandle['createPeer']>((options) => {
    const peer = {
      id: `peer-${peers.length + 1}`,
      principal: options.principal,
      interactions: options.interactions ?? 'answer',
      ctx,
      signal: shared.signal,
      dispose: async () => { shared.abort() },
    } as PeerScope
    peers.push(peer)
    return peer
  })
  const authentication = new ConnectionAuthentication(ctx)
  const connection: HostConnectionHandle = {
    authentication,
    browserPeer: {
      id: 'browser-peer',
      principal: { kind: 'owner' },
      interactions: 'answer',
      ctx,
      signal: new AbortController().signal,
      dispose: async () => {},
    } as PeerScope,
    allowsRemoteAuthorities: true,
    rpc: {
      handle() { throw new Error('RPC registration is outside this fixture') },
      intercept() { throw new Error('RPC interception is outside this fixture') },
    },
    fetch: { register() { throw new Error('Fetch routes are outside this fixture') } },
    createSharedFetchHandler() { throw new Error('Fetch dispatch is outside this fixture') },
    admit() { throw new Error('Combined admission is outside this fixture') },
    createPeer,
  }
  ctx.provide('connection', connection)
  const fiber = ctx.plugin({
    inject: Gateway.inject,
    apply(scope: Context) { Gateway.apply(scope, { ...base, ...overrides }) },
  })
  await fiber.await()
  return { ctx, authentication, peers, createPeer }
}

it('admits a verified assertion as a single owner Peer', async () => {
  const { authentication, peers, createPeer } = await mounted()
  expect(createPeer).toHaveBeenCalledTimes(1)
  expect(peers[0]?.principal).toEqual({ kind: 'owner' })
  const admission = authentication.authenticate({ headers: { 'x-dsh-gateway-identity': sign() } })
  expect('peer' in admission ? admission.peer : undefined).toBe(peers[0])
})

it('admits every request through the same Peer, whatever the assertion carries', async () => {
  const { authentication, peers } = await mounted()
  const first = authentication.authenticate({ headers: { 'x-dsh-gateway-identity': sign({ sid: 'iam-a1', pv: 3 }) } })
  const second = authentication.authenticate({ headers: new Headers({ 'x-dsh-gateway-identity': sign({ sid: 'iam-a2', pv: 4 }) }) })
  expect(first).toHaveProperty('peer')
  expect(second).toHaveProperty('peer')
  expect('peer' in first ? first.peer : undefined).toBe(peers[0])
  expect('peer' in second ? second.peer : undefined).toBe(peers[0])
})

it('refuses absent, foreign, expired, and other-subject assertions', async () => {
  const { ctx, authentication } = await mounted()
  const warn = vi.spyOn(ctx.logger, 'warn')
  const expiredAt = Math.floor(Date.now() / 1000)
  expect(authentication.authenticate({ headers: {} })).toEqual({ rejection: 401 })
  expect(authentication.authenticate({ headers: { 'x-dsh-gateway-identity': sign({}, 'z'.repeat(32)) } })).toEqual({ rejection: 401 })
  expect(authentication.authenticate({ headers: { 'x-dsh-gateway-identity': sign({ iat: expiredAt - 900, exp: expiredAt - 600 }) } })).toEqual({ rejection: 401 })
  expect(authentication.authenticate({ headers: { 'x-dsh-gateway-identity': sign({ sub: 'user-b' }) } })).toEqual({ rejection: 401 })
  expect(authentication.authenticate({ headers: { 'x-dsh-gateway-identity': sign({ aud: 'other' }) } })).toEqual({ rejection: 401 })
  expect(warn.mock.calls.map(call => String(call[0]))).toEqual([
    'host-authentication-gateway: refused assertion (signature)',
    'host-authentication-gateway: refused assertion (expired)',
    'host-authentication-gateway: refused assertion (subject)',
    'host-authentication-gateway: refused assertion (audience)',
  ])
})

it('honours a configured header name', async () => {
  const { authentication } = await mounted({ headerName: 'x-pixlab-identity' })
  expect(authentication.authenticate({ headers: { 'x-dsh-gateway-identity': sign() } })).toEqual({ rejection: 401 })
  expect(authentication.authenticate({ headers: { 'x-pixlab-identity': sign() } })).toHaveProperty('peer')
})

it('withdraws the provider when the plugin disappears', async () => {
  const { ctx, authentication } = await mounted()
  expect(authentication.authenticate({ headers: { 'x-dsh-gateway-identity': sign() } })).toHaveProperty('peer')
  await ctx.fiber.dispose()
  roots.length = 0
  expect(authentication.authenticate({ headers: { 'x-dsh-gateway-identity': sign() } })).toEqual({ rejection: 401 })
})

it('admits a version 2 Ed25519 assertion as the owner Peer', async () => {
  const { authentication, peers, createPeer } = await mounted({ algorithm: 'ed25519', publicKey: publicKeyPem })
  expect(createPeer).toHaveBeenCalledTimes(1)
  const admission = authentication.authenticate({ headers: { 'x-dsh-gateway-identity': signGateway(gatewayPayload()) } })
  expect('peer' in admission ? admission.peer : undefined).toBe(peers[0])
})

it('admits a version 2 HMAC assertion under the default algorithm', async () => {
  const { authentication } = await mounted()
  expect(authentication.authenticate({ headers: { 'x-dsh-gateway-identity': signGatewayHmac(gatewayPayload()) } }))
    .toHaveProperty('peer')
})

it('loads the Ed25519 public key from a configured file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-gateway-key-'))
  keyDirectories.push(directory)
  const publicKeyFile = join(directory, 'gateway.pem')
  writeFileSync(publicKeyFile, publicKeyPem, 'utf8')
  expect(() => Gateway.Config({ ...configInput, algorithm: 'ed25519', publicKeyFile })).not.toThrow()
  const { authentication } = await mounted({ algorithm: 'ed25519', publicKeyFile })
  expect(authentication.authenticate({ headers: { 'x-dsh-gateway-identity': signGateway(gatewayPayload()) } }))
    .toHaveProperty('peer')
})

it('refuses a version 2 assertion that fails a configured claim', async () => {
  const { ctx, authentication } = await mounted({
    algorithm: 'ed25519',
    publicKey: publicKeyPem,
    issuer: 'pixlab-gateway',
    keyId: 'pixlab-gateway-2026-01',
    generation: 3,
  })
  const warn = vi.spyOn(ctx.logger, 'warn')
  expect(authentication.authenticate({ headers: { 'x-dsh-gateway-identity': signGateway(gatewayPayload()) } }))
    .toHaveProperty('peer')
  expect(authentication.authenticate({ headers: { 'x-dsh-gateway-identity': signGateway(gatewayPayload({ iss: 'other' })) } }))
    .toEqual({ rejection: 401 })
  expect(authentication.authenticate({ headers: { 'x-dsh-gateway-identity': signGateway(gatewayPayload({ kid: 'other' })) } }))
    .toEqual({ rejection: 401 })
  expect(authentication.authenticate({ headers: { 'x-dsh-gateway-identity': signGateway(gatewayPayload({ gen: 4 })) } }))
    .toEqual({ rejection: 401 })
  expect(warn.mock.calls.map(call => String(call[0]))).toEqual([
    'host-authentication-gateway: refused assertion (issuer)',
    'host-authentication-gateway: refused assertion (key-id)',
    'host-authentication-gateway: refused assertion (generation)',
  ])
})

it('refuses a version 1 assertion when Ed25519 is configured', async () => {
  const { ctx, authentication } = await mounted({ algorithm: 'ed25519', publicKey: publicKeyPem })
  const warn = vi.spyOn(ctx.logger, 'warn')
  expect(authentication.authenticate({ headers: { 'x-dsh-gateway-identity': sign() } })).toEqual({ rejection: 401 })
  expect(warn.mock.calls.map(call => String(call[0])))
    .toEqual(['host-authentication-gateway: refused assertion (version)'])
})

it('refuses a replayed version 2 assertion only when a replay window is configured', async () => {
  const guarded = await mounted({ algorithm: 'ed25519', publicKey: publicKeyPem, replayWindowSeconds: 5 })
  const assertion = signGateway(gatewayPayload())
  expect(guarded.authentication.authenticate({ headers: { 'x-dsh-gateway-identity': assertion } })).toHaveProperty('peer')
  expect(guarded.authentication.authenticate({ headers: { 'x-dsh-gateway-identity': assertion } })).toEqual({ rejection: 401 })

  const open = await mounted({ algorithm: 'ed25519', publicKey: publicKeyPem })
  const repeated = signGateway(gatewayPayload())
  expect(open.authentication.authenticate({ headers: { 'x-dsh-gateway-identity': repeated } })).toHaveProperty('peer')
  expect(open.authentication.authenticate({ headers: { 'x-dsh-gateway-identity': repeated } })).toHaveProperty('peer')
})

// Key material is resolved while the plugin loads (`apply`), not by the plain config
// schema, so every one of these refusals is observed by mounting the plugin.
it('rejects an Ed25519 configuration without a public key at load', async () => {
  await expect(mounted({ algorithm: 'ed25519' })).rejects.toThrow(/publicKey or publicKeyFile/)
})

it('rejects an unparseable or non-Ed25519 public key at load', async () => {
  await expect(mounted({ algorithm: 'ed25519', publicKey: 'not a pem key' })).rejects.toThrow(/parseable/)
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey
    .export({ type: 'spki', format: 'pem' }).toString()
  await expect(mounted({ algorithm: 'ed25519', publicKey: rsa })).rejects.toThrow(/Ed25519/)
})

/** The shared fixture without its secret, for the case that must omit the key entirely. */
const deploymentWithoutSecret: Gateway.Config = {
  audience: config.audience,
  subject: config.subject,
  headerName: config.headerName,
  clockSkewSeconds: config.clockSkewSeconds,
  maxLifetimeSeconds: config.maxLifetimeSeconds,
}

it('rejects an HMAC configuration without a usable secret at load', async () => {
  await expect(mounted({ algorithm: 'hmac-sha256' }, deploymentWithoutSecret)).rejects.toThrow(/secret/)
})

it('rejects an unreadable publicKeyFile at load', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-gateway-key-'))
  keyDirectories.push(directory)
  await expect(mounted({ algorithm: 'ed25519', publicKeyFile: join(directory, 'missing.pem') }))
    .rejects.toThrow(/could not be read/)
})

it('rejects a private key configured as the Ed25519 public key', async () => {
  const privateKeyPem = signer.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  await expect(mounted({ algorithm: 'ed25519', publicKey: privateKeyPem })).rejects.toThrow(/not a private key/)
})
