/** Gateway integration routing: authentication, CSRF, origin, and no proxy fallthrough. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IntegrationService, PlatformHttpRequest, PlatformHttpResult, ValidatedSession } from '../src/contracts.ts'
import type { PlatformConfig } from '../src/config.ts'
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

class StubIntegrationService implements IntegrationService {
  readonly calls: { readonly path: string; readonly method: string; readonly body: string | undefined; readonly userId: string }[] = []

  status(): { state: 'ready'; enabled: true; issues: [] } {
    return { state: 'ready', enabled: true, issues: [] }
  }

  async handle(request: PlatformHttpRequest, session: ValidatedSession): Promise<PlatformHttpResult | undefined> {
    if (!request.url.pathname.startsWith('/api/integration')) return undefined
    this.calls.push({ path: request.url.pathname, method: request.method, body: request.body, userId: session.user.id })
    return {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ path: request.url.pathname, method: request.method, body: request.body ?? null, userId: session.user.id }),
    }
  }

  async close(): Promise<void> {}
}

let config: PlatformConfig
let identity: FakeIdentityService
let runtime: FakeRuntimeManager
let signer: TestSigner
let integration: StubIntegrationService
let gateway: RunningTestGateway
let session: StoredFakeSession

beforeEach(async () => {
  config = createGatewayTestConfig()
  identity = new FakeIdentityService()
  runtime = new FakeRuntimeManager()
  signer = createTestSigner(config)
  integration = new StubIntegrationService()
  gateway = await startTestGateway(config, { identity, runtime, signer: signer.signer, integration })
  session = identity.issueSession(testUser('user-a'))
})

afterEach(async () => {
  await gateway.close()
  removeGatewayTestConfig(config)
})

/**
 * Call one gateway path.
 * @param path - path and query.
 * @param init - fetch options.
 * @param authenticated - session to present.
 * @returns the response.
 */
async function call(path: string, init: RequestInit = {}, authenticated?: StoredFakeSession): Promise<Response> {
  const headers = new Headers(init.headers ?? {})
  if (authenticated !== undefined) headers.set('cookie', sessionCookieHeader(authenticated))
  return fetch(`${gateway.url}${path}`, { ...init, headers, redirect: 'manual' })
}

describe('integration gateway route', () => {
  it('requires a session before forwarding anything', async () => {
    const response = await call('/api/integration/status')
    expect(response.status).toBe(401)
    expect(integration.calls).toHaveLength(0)
  })

  it('forwards an authenticated GET without touching the runtime', async () => {
    const response = await call('/api/integration/status', {}, session)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ path: '/api/integration/status', method: 'GET', userId: 'user-a' })
    expect(runtime.ensureCalls).toHaveLength(0)
  })

  it('requires CSRF on mutations', async () => {
    const response = await call('/api/integration/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'x' }),
      headers: { 'content-type': 'application/json' },
    }, session)
    expect(response.status).toBe(403)
    expect(integration.calls).toHaveLength(0)
  })

  it('forwards a CSRF-valid mutation with its body', async () => {
    const response = await call('/api/integration/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'x' }),
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': session.csrfToken,
        origin: TEST_PUBLIC_ORIGIN,
      },
    }, session)
    expect(response.status).toBe(200)
    expect(integration.calls[0]?.body).toBe('{"name":"x"}')
    expect(runtime.ensureCalls).toHaveLength(0)
  })

  it('refuses a cross-origin mutation even with a valid CSRF token', async () => {
    const response = await call('/api/integration/workspaces', {
      method: 'POST',
      body: '{}',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': session.csrfToken,
        origin: 'https://evil.example',
      },
    }, session)
    expect(response.status).toBe(403)
    expect(integration.calls).toHaveLength(0)
  })

  it('answers 404 when fusion is disabled instead of proxying to the runtime', async () => {
    const disabledConfig = createGatewayTestConfig()
    const disabled = await startTestGateway(disabledConfig, { identity, runtime, signer: signer.signer })
    try {
      const response = await fetch(`${disabled.url}/api/integration/status`, {
        headers: { cookie: sessionCookieHeader(session) },
      })
      expect(response.status).toBe(404)
      expect(runtime.ensureCalls).toHaveLength(0)
    } finally {
      await disabled.close()
      removeGatewayTestConfig(disabledConfig)
    }
  })
})
