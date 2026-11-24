/** WebSocket admission, proxying, revalidation, and lease lifecycle. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyGatewayAssertion } from '../../../packages/host/authentication-gateway/src/assertion.ts'
import type { PlatformConfig } from '../src/config.ts'
import { GATEWAY_ASSERTION_HEADER } from '../src/gateway/signer.ts'
import {
  FakeIdentityService,
  FakeRuntimeManager,
  FakeRuntimeTarget,
  TEST_PUBLIC_ORIGIN,
  WebSocketTestClient,
  buildGatewayAssertionPolicy,
  createGatewayTestConfig,
  createTestSigner,
  openWebSocketHandshake,
  removeGatewayTestConfig,
  sessionCookieHeader,
  startTestGateway,
  testUser,
  type RunningTestGateway,
  type StoredFakeSession,
  type TestSigner,
  type WebSocketHandshake,
} from './gateway.fakes.ts'

/** Revalidation period the WebSocket tests configure. */
const REVALIDATE_SECONDS = 1

let config: PlatformConfig
let identity: FakeIdentityService
let runtime: FakeRuntimeManager
let signer: TestSigner
let gateway: RunningTestGateway
let target: FakeRuntimeTarget
let session: StoredFakeSession

beforeEach(async () => {
  config = createGatewayTestConfig({ wsRevalidateSeconds: REVALIDATE_SECONDS })
  identity = new FakeIdentityService()
  runtime = new FakeRuntimeManager()
  signer = createTestSigner(config)
  gateway = await startTestGateway(config, { identity, runtime, signer: signer.signer })
  target = new FakeRuntimeTarget('runtime-a')
  const bound = await target.start()
  const user = testUser('user-a')
  session = identity.issueSession(user)
  runtime.addRuntime(user.id, { host: bound.host, port: bound.port, generation: 3 })
})

afterEach(async () => {
  await gateway.close()
  await target.stop()
  removeGatewayTestConfig(config)
})

/** Send one upgrade to the gateway. */
function upgrade(options: { origin?: string; cookie?: string; headers?: Record<string, string> } = {}): Promise<WebSocketHandshake> {
  return openWebSocketHandshake({
    url: `${gateway.url}/api/remote.mux`,
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    ...(options.headers === undefined ? {} : { extraHeaders: options.headers }),
  })
}

/** Wait for a promise with a deadline, failing instead of hanging. */
function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 4_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out`))
    }, timeoutMs)
    promise.then((value) => {
      clearTimeout(timer)
      resolve(value)
    }, (error: unknown) => {
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    })
  })
}

describe('upgrade admission', () => {
  it('refuses an anonymous upgrade with an HTTP 401 text response', async () => {
    const handshake = await upgrade({ origin: TEST_PUBLIC_ORIGIN })
    expect(handshake.status).toBe(401)
    expect(handshake.body).toContain('unauthorized')
    expect(handshake.socket).toBeUndefined()
    expect(target.upgrades).toHaveLength(0)
    expect(runtime.leaseCount).toBe(0)
  })

  it('refuses a missing or cross-site Origin', async () => {
    const missing = await upgrade({ cookie: sessionCookieHeader(session) })
    expect(missing.status).toBe(401)
    const crossSite = await upgrade({
      cookie: sessionCookieHeader(session),
      origin: 'https://evil.example',
    })
    expect(crossSite.status).toBe(401)
    expect(target.upgrades).toHaveLength(0)
    expect(runtime.liveLeases).toBe(0)
  })

  it('refuses a revoked session before the handshake', async () => {
    identity.revoke(session.token)
    const handshake = await upgrade({
      cookie: sessionCookieHeader(session),
      origin: TEST_PUBLIC_ORIGIN,
    })
    expect(handshake.status).toBe(401)
    expect(target.upgrades).toHaveLength(0)
  })

  it('refuses the upgrade while the runtime is not READY', async () => {
    runtime.setStatus(session.session.user.id, {
      state: 'STARTING',
      generation: 4,
      retryable: false,
      errorCode: null,
    })
    const handshake = await upgrade({
      cookie: sessionCookieHeader(session),
      origin: TEST_PUBLIC_ORIGIN,
    })
    expect(handshake.status).toBe(503)
    expect(runtime.leaseCount).toBe(0)
  })

  it('refuses the upgrade with 502 when ensure throws', async () => {
    runtime.ensureError = new Error('docker unavailable')
    const handshake = await upgrade({
      cookie: sessionCookieHeader(session),
      origin: TEST_PUBLIC_ORIGIN,
    })
    expect(handshake.status).toBe(502)
    expect(runtime.leaseCount).toBe(0)
  })
})

describe('tunnel forwarding', () => {
  it('proxies the upgraded tunnel to the session user runtime', async () => {
    const handshake = await upgrade({
      cookie: sessionCookieHeader(session),
      origin: TEST_PUBLIC_ORIGIN,
      headers: {
        'x-dsh-gateway-identity': 'forged.payload',
        'x-user-id': 'user-b',
        authorization: 'Bearer token',
      },
    })
    expect(handshake.status).toBe(101)
    expect(handshake.socket).toBeDefined()
    if (handshake.socket === undefined) return
    const client = new WebSocketTestClient(handshake.socket)
    try {
      const recorded = target.upgrades.at(-1)
      expect(recorded).toBeDefined()
      const headers = recorded?.headers ?? {}
      expect(headers.cookie).toBeUndefined()
      expect(headers.authorization).toBeUndefined()
      expect(headers['x-user-id']).toBeUndefined()
      expect(headers.host).toBe(config.runtime.publicAuthority)
      expect(headers.origin).toBe(TEST_PUBLIC_ORIGIN)
      expect(headers.upgrade?.toLowerCase()).toBe('websocket')
      expect(headers['sec-websocket-key']).toBeDefined()
      expect(headers['sec-websocket-version']).toBe('13')
      const assertion = headers[GATEWAY_ASSERTION_HEADER]
      expect(assertion).not.toBe('forged.payload')
      const verified = verifyGatewayAssertion(String(assertion), buildGatewayAssertionPolicy({
        signer: signer.signer,
        subject: session.session.user.id,
        audience: config.gateway.audience,
        maxLifetimeSeconds: config.gateway.maxAssertionLifetimeSeconds,
      }))
      expect(verified).toHaveProperty('ok', true)

      client.send('hello-over-the-gateway')
      expect(await client.nextMessage()).toBe('hello-over-the-gateway')
    } finally {
      client.close()
    }
  })

  it('holds one runtime lease for the tunnel lifetime and releases it on close', async () => {
    const handshake = await upgrade({ cookie: sessionCookieHeader(session), origin: TEST_PUBLIC_ORIGIN })
    expect(handshake.status).toBe(101)
    if (handshake.socket === undefined) return
    const client = new WebSocketTestClient(handshake.socket)
    expect(runtime.leaseCount).toBe(1)
    expect(runtime.liveLeases).toBe(1)
    client.close()
    await withTimeout(client.closed, 'client close')
    await withTimeout(new Promise<void>((resolve) => {
      setTimeout(resolve, 100)
    }), 'lease release settle')
    expect(runtime.liveLeases).toBe(0)
    expect(runtime.leaseReleases).toBe(1)
  })

  it('does not route to another user runtime through headers', async () => {
    const otherTarget = new FakeRuntimeTarget('runtime-b')
    const otherBound = await otherTarget.start()
    const otherUser = testUser('user-b')
    runtime.addRuntime(otherUser.id, { host: otherBound.host, port: otherBound.port, generation: 8 })
    try {
      const handshake = await upgrade({
        cookie: sessionCookieHeader(session),
        origin: TEST_PUBLIC_ORIGIN,
        headers: { 'x-user-id': otherUser.id, 'x-dsh-user-id': otherUser.id },
      })
      expect(handshake.status).toBe(101)
      handshake.socket?.destroy()
      expect(target.upgrades).toHaveLength(1)
      expect(otherTarget.upgrades).toHaveLength(0)
    } finally {
      await otherTarget.stop()
    }
  })
})

describe('session and generation revalidation', () => {
  it('closes a live tunnel within one revalidation period after logout', async () => {
    const handshake = await upgrade({ cookie: sessionCookieHeader(session), origin: TEST_PUBLIC_ORIGIN })
    expect(handshake.status).toBe(101)
    if (handshake.socket === undefined) return
    const client = new WebSocketTestClient(handshake.socket)
    expect(runtime.liveLeases).toBe(1)
    identity.revoke(session.token)
    await withTimeout(client.closed, 'tunnel close after logout', REVALIDATE_SECONDS * 3000 + 2_000)
    await withTimeout(new Promise<void>((resolve) => {
      setTimeout(resolve, 100)
    }), 'lease release settle')
    expect(runtime.liveLeases).toBe(0)
  })

  it('closes a live tunnel when the runtime generation changes', async () => {
    const handshake = await upgrade({ cookie: sessionCookieHeader(session), origin: TEST_PUBLIC_ORIGIN })
    expect(handshake.status).toBe(101)
    if (handshake.socket === undefined) return
    const client = new WebSocketTestClient(handshake.socket)
    runtime.setStatus(session.session.user.id, {
      state: 'READY',
      generation: 4,
      retryable: false,
      errorCode: null,
    })
    await withTimeout(client.closed, 'tunnel close after generation change', REVALIDATE_SECONDS * 3000 + 2_000)
    await withTimeout(new Promise<void>((resolve) => {
      setTimeout(resolve, 100)
    }), 'lease release settle')
    expect(runtime.liveLeases).toBe(0)
  })

  it('closes a live tunnel when the runtime leaves READY', async () => {
    const handshake = await upgrade({ cookie: sessionCookieHeader(session), origin: TEST_PUBLIC_ORIGIN })
    expect(handshake.status).toBe(101)
    if (handshake.socket === undefined) return
    const client = new WebSocketTestClient(handshake.socket)
    runtime.setStatus(session.session.user.id, {
      state: 'STOPPING',
      generation: 3,
      retryable: false,
      errorCode: null,
    })
    await withTimeout(client.closed, 'tunnel close after runtime stop', REVALIDATE_SECONDS * 3000 + 2_000)
  })

  it('closes a live tunnel when the session expires', async () => {
    const shortLived = identity.issueSession(session.session.user, { expiresAt: Date.now() + 1_200 })
    const handshake = await upgrade({ cookie: sessionCookieHeader(shortLived), origin: TEST_PUBLIC_ORIGIN })
    expect(handshake.status).toBe(101)
    if (handshake.socket === undefined) return
    const client = new WebSocketTestClient(handshake.socket)
    await withTimeout(client.closed, 'tunnel close after session expiry', 8_000)
    await withTimeout(new Promise<void>((resolve) => {
      setTimeout(resolve, 100)
    }), 'lease release settle')
    expect(runtime.liveLeases).toBe(0)
  })

  it('closes the tunnel when gateway shutdown destroys its sockets', async () => {
    const handshake = await upgrade({ cookie: sessionCookieHeader(session), origin: TEST_PUBLIC_ORIGIN })
    expect(handshake.status).toBe(101)
    if (handshake.socket === undefined) return
    const client = new WebSocketTestClient(handshake.socket)
    await gateway.gateway.close()
    await withTimeout(client.closed, 'tunnel close after gateway close', 2_000)
  })
})
