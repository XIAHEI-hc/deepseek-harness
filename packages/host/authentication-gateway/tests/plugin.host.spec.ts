/** The gateway provider admits only verified assertions and speaks as one owner Peer. */
import { createHmac } from 'node:crypto'
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

const secret = 'g'.repeat(32)
const config: Gateway.Config = {
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

/** Mount the provider over a Connection handle that records the Peers it creates. */
async function mounted(overrides: Partial<Gateway.Config> = {}) {
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
    apply(scope: Context) { Gateway.apply(scope, { ...config, ...overrides }) },
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
