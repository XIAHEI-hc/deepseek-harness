/** HTTP proxy behavior: header hygiene, streaming, cross-user routing, and readiness failures. */
import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyGatewayAssertion } from '../../../packages/host/authentication-gateway/src/assertion.ts'
import type { PlatformConfig } from '../src/config.ts'
import { GATEWAY_ASSERTION_HEADER } from '../src/gateway/signer.ts'
import { PAGE_CONTENT_SECURITY_POLICY } from '../src/gateway/pages.ts'
import {
  FakeIdentityService,
  FakeRuntimeManager,
  FakeRuntimeTarget,
  TEST_PUBLIC_ORIGIN,
  buildGatewayAssertionPolicy,
  createGatewayTestConfig,
  createTestSigner,
  removeGatewayTestConfig,
  sessionCookieHeader,
  sha256Hex,
  startTestGateway,
  testUser,
  type RunningTestGateway,
  type StoredFakeSession,
  type TestSigner,
} from './gateway.fakes.ts'

let config: PlatformConfig
let identity: FakeIdentityService
let runtime: FakeRuntimeManager
let signer: TestSigner
let gateway: RunningTestGateway
let target: FakeRuntimeTarget
let session: StoredFakeSession

beforeEach(async () => {
  config = createGatewayTestConfig()
  identity = new FakeIdentityService()
  runtime = new FakeRuntimeManager()
  signer = createTestSigner(config)
  gateway = await startTestGateway(config, { identity, runtime, signer: signer.signer })
  target = new FakeRuntimeTarget('runtime-a')
  const bound = await target.start()
  const user = testUser('user-a')
  session = identity.issueSession(user)
  runtime.addRuntime(user.id, { host: bound.host, port: bound.port, generation: 3 })
  target.requests.length = 0
  target.upgrades.length = 0
})

afterEach(async () => {
  await gateway.close()
  await target.stop()
  removeGatewayTestConfig(config)
})

/** Fetch one gateway path with a browser-like request. */
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {})
  headers.set('cookie', sessionCookieHeader(session))
  return fetch(`${gateway.url}${path}`, { ...init, headers, redirect: 'manual' })
}

/** Read a JSON response body without assuming its concrete type. */
async function readJson(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('response is not a JSON object')
  return value as Record<string, unknown>
}

/** Read one error object from a platform error response. */
async function readError(response: Response): Promise<Record<string, unknown>> {
  const body = await readJson(response)
  const error = body.error
  if (typeof error !== 'object' || error === null || Array.isArray(error)) throw new Error('missing error object')
  return error as Record<string, unknown>
}

/** Send one raw HTTP request, preserving every hostile header the test attaches. */
function rawRequest(options: {
  path: string
  method?: string
  headers?: Record<string, string>
  body?: Buffer
}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  const url = new URL(gateway.url)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: url.hostname,
      port: url.port,
      path: options.path,
      method: options.method ?? 'GET',
      headers: options.headers,
    })
    request.on('response', (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) })
      })
    })
    request.on('error', reject)
    request.end(options.body)
  })
}

/** Assertion policy the target runtime would enforce for the current user. */
function targetPolicy() {
  return buildGatewayAssertionPolicy({
    signer: signer.signer,
    subject: session.session.user.id,
    audience: config.gateway.audience,
    maxLifetimeSeconds: config.gateway.maxAssertionLifetimeSeconds,
  })
}

describe('request forwarding', () => {
  it('preserves method, path, and query for the session user runtime', async () => {
    const response = await call('/files/report.txt?v=2&mode=raw')
    expect(response.status).toBe(200)
    const body = await readJson(response)
    expect(body).toMatchObject({ target: 'runtime-a', method: 'GET', url: '/files/report.txt?v=2&mode=raw' })
    expect(target.requests).toHaveLength(1)
    expect(target.requests[0]?.method).toBe('GET')
    expect(target.requests[0]?.url).toBe('/files/report.txt?v=2&mode=raw')
    expect(runtime.ensureCalls).toEqual([session.session.user.id])
    expect(runtime.touchCalls).toContain(session.session.user.id)
  })

  it('forwards every HTTP method with its body unchanged', async () => {
    const payload = Buffer.from('{"prompt":"hi"}')
    const post = await call('/api/chat', { method: 'POST', body: payload })
    expect(post.status).toBe(200)
    const recorded = target.requests.at(-1)
    expect(recorded?.method).toBe('POST')
    expect(recorded?.url).toBe('/api/chat')
    expect(sha256Hex(recorded?.body ?? Buffer.alloc(0))).toBe(sha256Hex(payload))

    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const response = await call('/api/item/1', { method })
      expect(response.status).toBe(200)
      expect(target.requests.at(-1)?.method).toBe(method)
    }
  })

  it('removes browser credentials and internal headers before forwarding', async () => {
    const forged = 'forged-payload.forged-signature'
    const response = await rawRequest({
      path: '/api/secure',
      headers: {
        cookie: sessionCookieHeader(session),
        authorization: 'Bearer browser-token',
        'proxy-authorization': 'Basic proxy',
        'x-dsh-gateway-identity': forged,
        'x-dsh-internal': 'internal',
        'x-user-id': 'user-b',
        'x-auth-token': 'token',
        'x-workbench-id': 'workbench',
        'x-forwarded-for': '203.0.113.9',
        'x-forwarded-user': 'user-b',
        'x-real-ip': '203.0.113.9',
        forwarded: 'for=203.0.113.9',
        te: 'trailers',
        'x-csrf-token': session.csrfToken,
      },
    })
    expect(response.status).toBe(200)
    const recorded = target.requests.at(-1)
    expect(recorded).toBeDefined()
    const headers = recorded?.headers ?? {}
    for (const name of [
      'cookie',
      'authorization',
      'proxy-authorization',
      'x-dsh-internal',
      'x-user-id',
      'x-auth-token',
      'x-workbench-id',
      'x-forwarded-for',
      'x-forwarded-user',
      'x-real-ip',
      'forwarded',
      'te',
      'x-csrf-token',
    ]) {
      expect(headers[name]).toBeUndefined()
    }
    const assertion = headers[GATEWAY_ASSERTION_HEADER]
    expect(typeof assertion).toBe('string')
    expect(assertion).not.toBe(forged)
    const verified = verifyGatewayAssertion(String(assertion), targetPolicy())
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(verified.identity).toMatchObject({
      subject: session.session.user.id,
      sessionId: session.session.sessionId,
      permissionVersion: session.session.permissionVersion,
      generation: 3,
    })
  })

  it('stamps the public authority, client protocol, and a request id', async () => {
    await call('/api/whoami', { headers: { accept: 'application/json' } })
    const headers = target.requests.at(-1)?.headers ?? {}
    expect(headers.host).toBe(config.runtime.publicAuthority)
    expect(headers['x-forwarded-proto']).toBe('http')
    const requestId = headers['x-request-id']
    expect(typeof requestId).toBe('string')
    expect(String(requestId)).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('keeps the origin and fetch metadata the runtime trust fence needs', async () => {
    await rawRequest({
      path: '/index.html',
      headers: {
        cookie: sessionCookieHeader(session),
        origin: TEST_PUBLIC_ORIGIN,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'navigate',
        accept: 'text/html',
      },
    })
    const headers = target.requests.at(-1)?.headers ?? {}
    expect(headers.origin).toBe(TEST_PUBLIC_ORIGIN)
    expect(headers['sec-fetch-site']).toBe('same-origin')
    expect(headers['sec-fetch-mode']).toBe('navigate')
    expect(headers.accept).toBe('text/html')
  })

  it('routes each session to its own runtime', async () => {
    const otherTarget = new FakeRuntimeTarget('runtime-b')
    const otherBound = await otherTarget.start()
    const otherUser = testUser('user-b')
    const otherSession = identity.issueSession(otherUser)
    runtime.addRuntime(otherUser.id, { host: otherBound.host, port: otherBound.port, generation: 7 })
    try {
      const first = await call('/api/whoami')
      expect((await readJson(first)).target).toBe('runtime-a')
      const second = await fetch(`${gateway.url}/api/whoami`, {
        headers: { cookie: sessionCookieHeader(otherSession) },
      })
      expect((await readJson(second)).target).toBe('runtime-b')
      const otherAssertion = otherTarget.requests.at(-1)?.headers[GATEWAY_ASSERTION_HEADER]
      const verified = verifyGatewayAssertion(String(otherAssertion), buildGatewayAssertionPolicy({
        signer: signer.signer,
        subject: otherUser.id,
        audience: config.gateway.audience,
        maxLifetimeSeconds: config.gateway.maxAssertionLifetimeSeconds,
      }))
      expect(verified).toHaveProperty('ok', true)
      expect(target.requests).toHaveLength(1)
    } finally {
      await otherTarget.stop()
    }
  })

  it('never lets a browser-supplied user id select the target', async () => {
    const otherTarget = new FakeRuntimeTarget('runtime-b')
    const otherBound = await otherTarget.start()
    const otherUser = testUser('user-b')
    runtime.addRuntime(otherUser.id, { host: otherBound.host, port: otherBound.port, generation: 9 })
    try {
      const response = await rawRequest({
        path: '/api/whoami',
        headers: {
          cookie: sessionCookieHeader(session),
          'x-user-id': otherUser.id,
          'x-dsh-user-id': otherUser.id,
        },
      })
      expect(response.status).toBe(200)
      expect(JSON.parse(response.body.toString('utf8'))).toMatchObject({ target: 'runtime-a' })
      expect(otherTarget.requests).toHaveLength(0)
    } finally {
      await otherTarget.stop()
    }
  })
})

describe('response forwarding', () => {
  it('drops Set-Cookie, internal, and hop-by-hop response headers', async () => {
    const response = await call('/api/data')
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('x-dsh-internal-target')).toBeNull()
    expect(response.headers.get('x-runtime-target')).toBe('runtime-a')
  })

  it('streams an SSE response without buffering it', async () => {
    const response = await call('/sse')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    if (reader === undefined) return
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('first SSE chunk was buffered')), 3_000)
      }),
    ])
    expect(new TextDecoder().decode(first.value)).toBe('data: first\n\n')
    target.releaseSse()
    let rest = ''
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      rest += new TextDecoder().decode(chunk.value)
    }
    expect(rest).toContain('data: second')
  })

  it('streams a 5 MiB download unchanged', async () => {
    const response = await call('/big-response')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(5 * 1024 * 1024))
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('x-dsh-internal-target')).toBeNull()
    const bytes = Buffer.from(await response.arrayBuffer())
    expect(bytes.length).toBe(5 * 1024 * 1024)
    const expected = Buffer.alloc(5 * 1024 * 1024)
    for (let index = 0; index < expected.length; index += 1) expected[index] = index % 251
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(createHash('sha256').update(expected).digest('hex'))
  })

  it('streams a 5 MiB request body unchanged', async () => {
    const payload = Buffer.alloc(5 * 1024 * 1024)
    for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 7) % 256
    const response = await call('/api/upload', { method: 'POST', body: payload })
    expect(response.status).toBe(200)
    const body = await readJson(response)
    expect(body.bytes).toBe(payload.length)
    expect(body.sha).toBe(sha256Hex(payload))
    expect(target.requests.at(-1)?.body.length).toBe(payload.length)
  })
})

describe('runtime readiness failures', () => {
  beforeEach(() => {
    runtime.setStatus(session.session.user.id, {
      state: 'STARTING',
      generation: 4,
      retryable: true,
      errorCode: 'START_TIMEOUT',
    })
  })

  it('answers API requests with a 503 JSON status and no internal location', async () => {
    const response = await call('/api/session/list')
    expect(response.status).toBe(503)
    const error = await readError(response)
    expect(error).toMatchObject({
      code: 'runtime-not-ready',
      state: 'STARTING',
      generation: 4,
      retryable: true,
      errorCode: 'START_TIMEOUT',
    })
    expect(JSON.stringify(error)).not.toContain('127.0.0.1')
    expect(JSON.stringify(error)).not.toContain('port')
  })

  it('answers page requests with a self-refreshing status page', async () => {
    const response = await call('/workspace/s1', { headers: { 'accept-language': 'zh-CN' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('content-security-policy')).toBe(PAGE_CONTENT_SECURITY_POLICY)
    const html = await response.text()
    expect(html).toContain('正在启动你的个人工作区')
    expect(html).toContain('<meta http-equiv="refresh" content="3">')
    expect(html).toContain('START_TIMEOUT')
    expect(html).not.toContain('<script')
    expect(html).not.toMatch(/(?:src|href)="https?:/)
    expect(html).not.toContain('127.0.0.1')
  })

  it('does not proxy any request while the runtime is not READY', async () => {
    await call('/workspace/s1')
    await call('/api/session/list')
    expect(target.requests).toHaveLength(0)
  })
})

describe('runtime ensure failures', () => {
  it('answers 502 with a stable code for API requests', async () => {
    runtime.ensureError = new Error('docker socket unavailable')
    const response = await call('/api/session/list')
    expect(response.status).toBe(502)
    expect((await readError(response)).code).toBe('runtime-unavailable')
    expect(target.requests).toHaveLength(0)
  })

  it('answers a status page for page requests without provider details', async () => {
    runtime.ensureError = new Error('docker socket unavailable')
    const response = await call('/workspace/s1', { headers: { 'accept-language': 'en' } })
    expect(response.status).toBe(502)
    expect(response.headers.get('content-security-policy')).toBe(PAGE_CONTENT_SECURITY_POLICY)
    const html = await response.text()
    expect(html).toContain('RUNTIME_UNAVAILABLE')
    expect(html).toContain('Your personal runtime failed to start')
    expect(html).not.toContain('docker')
    expect(html).not.toContain('127.0.0.1')
  })

  it('answers 502 when the runtime target refuses the connection', async () => {
    const deadTarget = new FakeRuntimeTarget('dead')
    const bound = await deadTarget.start()
    await deadTarget.stop()
    runtime.addRuntime(session.session.user.id, { host: bound.host, port: bound.port, generation: 5 })
    const response = await call('/api/session/list')
    expect(response.status).toBe(502)
    expect((await readError(response)).code).toBe('runtime-unavailable')
  })
})
