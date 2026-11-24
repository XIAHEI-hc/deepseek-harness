/** Gateway routing, session admission, CSRF, platform pages, and health surfaces. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PlatformConfig } from '../src/config.ts'
import { PAGE_CONTENT_SECURITY_POLICY, normalizeReturnTo } from '../src/gateway/pages.ts'
import {
  FakeIdentityService,
  FakeRuntimeManager,
  TEST_PUBLIC_ORIGIN,
  createGatewayTestConfig,
  createTestSigner,
  removeGatewayTestConfig,
  sessionCookieHeader,
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
let session: StoredFakeSession

beforeEach(async () => {
  config = createGatewayTestConfig()
  identity = new FakeIdentityService()
  runtime = new FakeRuntimeManager()
  signer = createTestSigner(config)
  gateway = await startTestGateway(config, { identity, runtime, signer: signer.signer })
  const user = testUser('user-a')
  session = identity.issueSession(user)
  runtime.addRuntime(user.id, { host: '127.0.0.1', port: 9, generation: 3 })
})

afterEach(async () => {
  await gateway.close()
  removeGatewayTestConfig(config)
})

/** Fetch one gateway path, optionally authenticated. */
async function call(
  path: string,
  init: RequestInit = {},
  authenticated?: StoredFakeSession,
): Promise<Response> {
  const headers = new Headers(init.headers ?? {})
  if (authenticated !== undefined) headers.set('cookie', sessionCookieHeader(authenticated))
  return fetch(`${gateway.url}${path}`, { ...init, headers, redirect: 'manual' })
}

/** Read a JSON response body without assuming its concrete type. */
async function readJson(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('response is not a JSON object')
  return value as Record<string, unknown>
}

/** Read one JSON error code from a platform error response. */
async function errorCode(response: Response): Promise<string> {
  const body = await readJson(response)
  const error = body.error
  if (typeof error !== 'object' || error === null || Array.isArray(error)) throw new Error('missing error object')
  const code = (error as Record<string, unknown>).code
  if (typeof code !== 'string') throw new Error('missing error code')
  return code
}

describe('deployment health', () => {
  it('answers /health with anonymous, non-sensitive facts', async () => {
    const response = await call('/health')
    expect(response.status).toBe(200)
    const body = await readJson(response)
    expect(body).toEqual({ ok: true, mode: 'mock', runtimeKind: 'process' })
    expect(body).not.toHaveProperty('dataDir')
    expect(body).not.toHaveProperty('listenPort')
  })

  it('answers /ready with a liveness fact', async () => {
    const response = await call('/ready')
    expect(response.status).toBe(200)
    expect(await readJson(response)).toEqual({ ok: true })
  })

  it('rejects non-read methods on health endpoints', async () => {
    expect((await call('/health', { method: 'POST' })).status).toBe(405)
    expect((await call('/ready', { method: 'POST' })).status).toBe(405)
  })
})

describe('login page', () => {
  it('renders the English page by default with a strict CSP and no external resource', async () => {
    const response = await call('/login')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('content-security-policy')).toBe(PAGE_CONTENT_SECURITY_POLICY)
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    const html = await response.text()
    expect(html).toContain('Welcome to DSH')
    expect(html).toContain('Sign in with W3')
    expect(html).toContain('href="/auth/login"')
    expect(html).not.toContain('<script')
    expect(html).not.toMatch(/(?:src|href)="https?:/)
  })

  it('renders Chinese copy from Accept-Language', async () => {
    const response = await call('/login', { headers: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' } })
    const html = await response.text()
    expect(html).toContain('欢迎使用 DSH')
    expect(html).toContain('通过 W3 登录')
  })

  it('shows the localized message for a known error code', async () => {
    const expired = await (await call('/login?error=session-expired', { headers: { 'accept-language': 'zh-CN' } })).text()
    expect(expired).toContain('登录已过期')
    const denied = await (await call('/login?error=w3_denied', { headers: { 'accept-language': 'zh-CN' } })).text()
    expect(denied).toContain('W3 登录未完成')
    const unknown = await (await call('/login?error=surprise')).text()
    expect(unknown).toContain('Sign-in was not completed')
  })

  it('carries a safe return_to into the login button', async () => {
    const response = await call(`/login?return_to=${encodeURIComponent('/workspace/s1?view=chat')}`)
    const html = await response.text()
    expect(html).toContain('href="/auth/login?return_to=%2Fworkspace%2Fs1%3Fview%3Dchat"')
  })

  it('drops open-redirect shapes from the login button', async () => {
    for (const hostile of ['https://evil.example/steal', '//evil.example/steal', '/\\evil.example', 'javascript:alert(1)']) {
      const response = await call(`/login?return_to=${encodeURIComponent(hostile)}`)
      const html = await response.text()
      expect(html).not.toContain('evil.example')
      expect(html).toContain('href="/auth/login"')
    }
  })

  it('rejects non-read methods on the login path', async () => {
    expect((await call('/login', { method: 'POST' })).status).toBe(405)
  })
})

describe('return_to normalization', () => {
  it('keeps same-origin relative paths and normalizes dot segments', () => {
    expect(normalizeReturnTo('/workspace/s1?x=1', TEST_PUBLIC_ORIGIN)).toBe('/workspace/s1?x=1')
    expect(normalizeReturnTo('/a/../b', TEST_PUBLIC_ORIGIN)).toBe('/b')
    expect(normalizeReturnTo('/dsh#fragment', TEST_PUBLIC_ORIGIN)).toBe('/dsh')
  })

  it('refuses absolute, protocol-relative, backslash, control, and normalized escape shapes', () => {
    for (const hostile of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '\\\\evil.example',
      '/..//evil.example',
      '/\u0000evil',
      'relative/path',
      '',
      undefined,
    ]) {
      expect(normalizeReturnTo(hostile, TEST_PUBLIC_ORIGIN)).toBeUndefined()
    }
  })

  it('refuses values longer than the accepted limit', () => {
    expect(normalizeReturnTo(`/${'a'.repeat(4096)}`, TEST_PUBLIC_ORIGIN)).toBeUndefined()
  })
})

describe('session admission', () => {
  it('answers unauthenticated API requests with a JSON 401', async () => {
    const response = await call('/api/session/list')
    expect(response.status).toBe(401)
    expect(await errorCode(response)).toBe('no-session')
  })

  it('treats a JSON-accepting request as an API request', async () => {
    const response = await call('/workspace/s1', { headers: { accept: 'application/json' } })
    expect(response.status).toBe(401)
    expect(await errorCode(response)).toBe('no-session')
  })

  it('redirects an unauthenticated page request to the login page with its relative path', async () => {
    const response = await call('/workspace/s1?a=1&b=2')
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`/login?return_to=${encodeURIComponent('/workspace/s1?a=1&b=2')}`)
  })

  it('refuses the old cookie after logout', async () => {
    identity.revoke(session.token)
    const api = await call('/api/session/list', {}, session)
    expect(api.status).toBe(401)
    expect(await errorCode(api)).toBe('session-revoked')
    const page = await call('/workspace/s1', {}, session)
    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toMatch(/^\/login\?return_to=/)
  })

  it('refuses an expired session', async () => {
    const expired = identity.issueSession(testUser('user-b'), { expiresAt: Date.now() - 1000 })
    const response = await call('/api/session/list', {}, expired)
    expect(response.status).toBe(401)
    expect(await errorCode(response)).toBe('session-expired')
  })
})

describe('identity surface', () => {
  it('forwards /auth/* with parsed cookies and serializes Set-Cookie headers', async () => {
    const login = await call('/auth/login?return_to=%2Fworkspace')
    expect(login.status).toBe(302)
    expect(login.headers.get('location')).toBe('/workspace')
    const cookies = login.headers.getSetCookie()
    expect(cookies).toHaveLength(2)
    expect(cookies[0]).toMatch(/^dsh_session=session-token-\d+; Path=\/; HttpOnly; SameSite=Lax$/)
    expect(cookies[1]).toMatch(/^dsh_csrf=csrf-token-\d+; Path=\/; SameSite=Lax$/)
    expect(identity.handled).toHaveLength(1)
    expect(identity.handled[0]?.url.pathname).toBe('/auth/login')
  })

  it('passes parsed cookies to the identity service', async () => {
    const me = await call('/auth/me', {}, session)
    expect(me.status).toBe(200)
    expect(identity.handled[0]?.cookies.dsh_session).toBe(session.token)
    expect(identity.handled[0]?.cookies.dsh_csrf).toBe(session.csrfToken)
  })

  it('buffers a small request body for the identity service', async () => {
    const response = await call('/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"reason":"user-click"}',
    }, session)
    expect(response.status).toBe(200)
    expect(identity.handled[0]?.method).toBe('POST')
    expect(identity.handled[0]?.body).toBe('{"reason":"user-click"}')
  })

  it('serializes cookie deletion with Max-Age=0', async () => {
    const response = await call('/auth/logout', { method: 'POST' }, session)
    expect(response.status).toBe(200)
    const cookies = response.headers.getSetCookie()
    expect(cookies).toEqual([
      'dsh_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      'dsh_csrf=; Path=/; Max-Age=0; SameSite=Lax',
    ])
  })

  it('never exposes the internal surface', async () => {
    const response = await call('/internal/introspect', { method: 'POST' }, session)
    expect(response.status).toBe(404)
    expect(await errorCode(response)).toBe('not-found')
    expect(identity.handled).toHaveLength(0)
  })

  it('answers 404 for an identity route the identity service does not own', async () => {
    const response = await call('/auth/nope')
    expect(response.status).toBe(404)
    expect(await errorCode(response)).toBe('not-found')
  })

  it('answers 502 when the identity service throws', async () => {
    identity.handle = async () => { throw new Error('database offline') }
    const response = await call('/auth/me')
    expect(response.status).toBe(502)
    expect(await errorCode(response)).toBe('identity-unavailable')
  })
})

describe('runtime status API', () => {
  it('requires a session', async () => {
    const response = await call('/api/runtime/me')
    expect(response.status).toBe(401)
    expect(await errorCode(response)).toBe('no-session')
  })

  it('returns only the anonymous status fields', async () => {
    const response = await call('/api/runtime/me', {}, session)
    expect(response.status).toBe(200)
    const body = await readJson(response)
    expect(body).toEqual({ state: 'READY', generation: 3, retryable: false, errorCode: null })
    const raw = JSON.stringify(body)
    expect(raw).not.toContain('127.0.0.1')
    expect(raw).not.toContain('target')
    expect(raw).not.toContain('port')
  })

  it('answers 502 when the runtime manager cannot report status', async () => {
    runtime.statusError = new Error('registry offline')
    const response = await call('/api/runtime/me', {}, session)
    expect(response.status).toBe(502)
    expect(await errorCode(response)).toBe('runtime-unavailable')
  })

  it('rejects wake and retry without a matching CSRF token', async () => {
    const noHeader = await call('/api/runtime/wake', { method: 'POST' }, session)
    expect(noHeader.status).toBe(403)
    expect(await errorCode(noHeader)).toBe('csrf-invalid')

    const wrongToken = await call('/api/runtime/wake', {
      method: 'POST',
      headers: { 'x-csrf-token': 'wrong-token' },
    }, session)
    expect(wrongToken.status).toBe(403)
    expect(runtime.ensureCalls).toHaveLength(0)
  })

  it('rejects wake without a session before checking CSRF', async () => {
    const response = await call('/api/runtime/wake', { method: 'POST' })
    expect(response.status).toBe(401)
    expect(await errorCode(response)).toBe('no-session')
  })

  it('wakes the caller runtime after CSRF verification', async () => {
    const response = await call('/api/runtime/wake', {
      method: 'POST',
      headers: { 'x-csrf-token': session.csrfToken },
    }, session)
    expect(response.status).toBe(200)
    expect(await readJson(response)).toEqual({ state: 'READY', generation: 3, retryable: false, errorCode: null })
    expect(runtime.ensureCalls).toEqual([session.session.user.id])
    expect(runtime.touchCalls).toEqual([session.session.user.id])
  })

  it('retries a failed runtime and reports a non-ready state as JSON', async () => {
    runtime.setStatus(session.session.user.id, {
      state: 'STARTING',
      generation: 4,
      retryable: true,
      errorCode: 'START_TIMEOUT',
    })
    const response = await call('/api/runtime/retry', {
      method: 'POST',
      headers: { 'x-csrf-token': session.csrfToken },
    }, session)
    expect(response.status).toBe(200)
    expect(await readJson(response)).toEqual({
      state: 'STARTING',
      generation: 4,
      retryable: true,
      errorCode: 'START_TIMEOUT',
    })
    expect(runtime.retryCalls).toEqual([session.session.user.id])
  })

  it('answers 502 when wake or retry throws', async () => {
    runtime.ensureError = new Error('docker unavailable')
    const wake = await call('/api/runtime/wake', {
      method: 'POST',
      headers: { 'x-csrf-token': session.csrfToken },
    }, session)
    expect(wake.status).toBe(502)
    expect(await errorCode(wake)).toBe('runtime-unavailable')

    runtime.retryError = new Error('docker unavailable')
    const retry = await call('/api/runtime/retry', {
      method: 'POST',
      headers: { 'x-csrf-token': session.csrfToken },
    }, session)
    expect(retry.status).toBe(502)
    expect(await errorCode(retry)).toBe('runtime-unavailable')
  })

  it('rejects unknown runtime API paths and wrong methods', async () => {
    const unknown = await call('/api/runtime/secret', {}, session)
    expect(unknown.status).toBe(404)
    expect(await errorCode(unknown)).toBe('not-found')
    const wrongMethod = await call('/api/runtime/me', { method: 'POST' }, session)
    expect(wrongMethod.status).toBe(405)
    expect(await errorCode(wrongMethod)).toBe('method-not-allowed')
  })
})

describe('request body limit', () => {
  let smallConfig: PlatformConfig
  let smallGateway: RunningTestGateway
  let smallIdentity: FakeIdentityService

  beforeEach(async () => {
    smallConfig = createGatewayTestConfig({ maxBodyBytes: 16 })
    smallIdentity = new FakeIdentityService()
    const smallRuntime = new FakeRuntimeManager()
    const smallSigner = createTestSigner(smallConfig)
    smallGateway = await startTestGateway(smallConfig, {
      identity: smallIdentity,
      runtime: smallRuntime,
      signer: smallSigner.signer,
    })
  })

  afterEach(async () => {
    await smallGateway.close()
    removeGatewayTestConfig(smallConfig)
  })

  it('refuses an oversized identity request body instead of buffering it', async () => {
    const response = await fetch(`${smallGateway.url}/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"padding":"0123456789abcdef"}',
    })
    expect(response.status).toBe(413)
    expect(await errorCode(response)).toBe('body-too-large')
    expect(smallIdentity.handled).toHaveLength(0)
  })
})
