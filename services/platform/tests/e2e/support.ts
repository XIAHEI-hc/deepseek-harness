/**
 * End-to-end test support for the DSH platform services: a scripted W3 identity
 * provider, a cookie-keeping HTTP browser, free-port reservation, and a real
 * platform configuration over real per-user DSH runtimes.
 *
 * @module @deepseek-ai/dsh-platform-services/tests/e2e/support
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { once } from 'node:events'
import { createPlatformConfig, type PlatformConfig } from '../../src/config.ts'

/** One HTTP response captured by the test browser. */
export interface TestResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly body: string
  /** Parsed `set-cookie` values in arrival order. */
  readonly setCookies: readonly string[]
}

/** One in-memory browser: a cookie jar plus a fetch that never auto-redirects. */
export class TestBrowser {
  private readonly jar = new Map<string, string>()
  private readonly base: string

  /** @param base - origin used to resolve relative redirect locations. */
  constructor(base: string) {
    this.base = base
  }

  /** @returns the current `Cookie` header value, or undefined when the jar is empty. */
  cookieHeader(): string | undefined {
    if (this.jar.size === 0) return undefined
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  /**
   * Read one stored cookie value.
   * @param name - cookie name.
   * @returns the value, or undefined when the jar does not hold it.
   */
  cookie(name: string): string | undefined {
    return this.jar.get(name)
  }

  /** Drop every cookie the jar holds. */
  clear(): void {
    this.jar.clear()
  }

  /**
   * Send one request and absorb any response cookies.
   * @param url - absolute request URL.
   * @param options - method, extra headers, body, and whether the jar sends cookies.
   * @returns the captured response.
   */
  async request(url: string, options: {
    method?: string
    headers?: Record<string, string>
    body?: string
    sendCookies?: boolean
  } = {}): Promise<TestResponse> {
    const headers: Record<string, string> = { ...options.headers }
    const cookie = this.cookieHeader()
    if (options.sendCookies !== false && cookie !== undefined) headers.cookie = cookie
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      ...options.body === undefined ? {} : { body: options.body },
      redirect: 'manual',
    })
    const setCookies = response.headers.getSetCookie()
    for (const text of setCookies) this.absorbCookie(text)
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
      setCookies,
    }
  }

  /**
   * Follow one 302 response once.
   * @param response - response captured from {@link request}.
   * @returns the next response, or the same response when it is not a redirect.
   */
  async follow(response: TestResponse): Promise<TestResponse> {
    const location = response.headers['location']
    if (response.status !== 302 || typeof location !== 'string') return response
    return this.request(location.startsWith('/') ? new URL(location, this.base).toString() : location)
  }

  /**
   * Store or delete one `set-cookie` value.
   * @param text - raw `set-cookie` header value.
   */
  private absorbCookie(text: string): void {
    const [pair] = text.split(';')
    if (pair === undefined) return
    const separator = pair.indexOf('=')
    if (separator <= 0) return
    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    if (value === '' || /max-age=0/i.test(text)) {
      this.jar.delete(name)
      return
    }
    this.jar.set(name, value)
  }
}

/** One scripted W3 identity provider. */
export class FakeW3Provider {
  /** Request log, so tests can assert the exchange shape. */
  readonly requests: { method: string; path: string; contentType: string; body: string }[] = []
  private server: Server | undefined
  private origin = ''
  private readonly codes = new Map<string, string>()

  /**
   * Build the provider on an ephemeral loopback port.
   * @returns the provider origin.
   */
  async start(): Promise<string> {
    this.server = createHttpServer((request, response) => { void this.handle(request, response) })
    this.server.listen(0, '127.0.0.1')
    await once(this.server, 'listening')
    this.origin = `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`
    return this.origin
  }

  /** Stop the provider. */
  async stop(): Promise<void> {
    if (this.server === undefined) return
    const server = this.server
    this.server = undefined
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }

  /** @returns the provider origin. */
  get url(): string {
    return this.origin
  }

  /**
   * Handle one provider request.
   * @param request - incoming request.
   * @param response - response to complete.
   */
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://dsh.invalid')
    const body = request.method === 'POST' ? await this.readBody(request) : ''
    this.requests.push({
      method: request.method ?? 'GET',
      path: url.pathname,
      contentType: String(request.headers['content-type'] ?? ''),
      body,
    })
    if (url.pathname === '/__account') {
      // Test control endpoint: choose the account the next authorize represents.
      const account = url.searchParams.get('account') ?? 'a'
      response.writeHead(200, {
        'content-type': 'text/plain',
        'set-cookie': `w3_account=${account}; Path=/; HttpOnly; SameSite=Lax`,
      })
      response.end('ok')
      return
    }
    if (url.pathname === '/authorize') {
      const state = url.searchParams.get('state') ?? ''
      const redirectUri = url.searchParams.get('redirect_uri') ?? ''
      if (state === '' || redirectUri === '') {
        response.writeHead(400, { 'content-type': 'text/plain' })
        response.end('missing state or redirect_uri')
        return
      }
      const account = this.accountFromCookie(request.headers.cookie)
      const code = `${account}:${String(this.codes.size)}`
      this.codes.set(code, account)
      const target = new URL(redirectUri)
      target.searchParams.set('code', code)
      target.searchParams.set('state', state)
      response.writeHead(302, { location: target.toString() })
      response.end()
      return
    }
    if (url.pathname === '/token') {
      const parsed = this.parseBody(request.headers['content-type'], body)
      const valid = parsed.client_id === 'dsh-client'
        && parsed.client_secret === 'dsh-secret'
        && parsed.grant_type === 'authorization_code'
        && parsed.redirect_uri !== undefined
        && this.codes.has(parsed.code ?? '')
      if (!valid) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'invalid_request' }))
        return
      }
      const account = this.codes.get(parsed.code ?? '') ?? 'a'
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ access_token: `tok:${account}`, token_type: 'bearer', expires_in: 3600 }))
      return
    }
    if (url.pathname === '/userinfo') {
      const parsed = this.parseBody(request.headers['content-type'], body)
      const account = (parsed.access_token ?? '').replace('tok:', '')
      const valid = account !== ''
        && parsed.client_id === 'dsh-client'
        && parsed.scope === 'base.profile'
      if (!valid) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'invalid_request' }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        uuid: `w3-${account}`,
        uid: `uid-${account}`,
        displayName: `User ${account.toUpperCase()}`,
        email: `${account}@example.test`,
      }))
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not found')
  }

  /**
   * Read one request body.
   * @param request - incoming request.
   * @returns the buffered UTF-8 body.
   */
  private async readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks).toString('utf8')
  }

  /**
   * Parse a JSON or form request body.
   * @param contentType - request `content-type`.
   * @param body - raw body text.
   * @returns the decoded string fields; an empty object when the body is unusable.
   */
  private parseBody(contentType: string | undefined, body: string): Record<string, string> {
    if (body === '') return {}
    const result: Record<string, string> = {}
    if ((contentType ?? '').includes('application/json')) {
      const parsed: unknown = JSON.parse(body)
      if (typeof parsed !== 'object' || parsed === null) return {}
      for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string') result[key] = value
      return result
    }
    for (const [key, value] of new URLSearchParams(body)) result[key] = value
    return result
  }

  /**
   * Read the test-controlled account cookie.
   * @param cookieHeader - request `cookie` header.
   * @returns the account name, defaulting to `a`.
   */
  private accountFromCookie(cookieHeader: string | undefined): string {
    for (const part of (cookieHeader ?? '').split(';')) {
      const [name, value] = part.trim().split('=')
      if (name === 'w3_account' && value !== undefined && value !== '') return value
    }
    return 'a'
  }
}

/**
 * Reserve one loopback port by binding and releasing it.
 * @returns the port number.
 */
export async function reservePort(): Promise<number> {
  const server = createNetServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  return port
}

/**
 * Poll a condition until it is true or the budget expires.
 * @param description - assertion description used in the timeout error.
 * @param probe - condition to evaluate; returning true stops the wait.
 * @param options - total budget and interval in milliseconds.
 */
export async function waitFor(
  description: string,
  probe: () => Promise<boolean> | boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const intervalMs = options.intervalMs ?? 500
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe()) return
    await new Promise<void>((resolve) => { setTimeout(resolve, intervalMs) })
  }
  throw new Error(`timed out waiting for ${description}`)
}

/** Options that shape one end-to-end platform configuration. */
export interface PlatformTestOptions {
  /** Platform data directory; the caller creates and removes it. */
  readonly dataDir: string
  /** Loopback port the gateway binds. */
  readonly listenPort: number
  /** Fake W3 provider origin. */
  readonly providerUrl: string
  /** Repository root owning the DSH CLI and the runtime overlay. */
  readonly repoRoot: string
}

/**
 * Build one W3-mode platform configuration over a fake provider and the process
 * runtime backend.
 * @param options - data directory, gateway port, provider origin, and repo root.
 * @returns the complete platform configuration.
 */
export function w3PlatformConfig(options: PlatformTestOptions): PlatformConfig {
  const publicOrigin = `http://127.0.0.1:${String(options.listenPort)}`
  return createPlatformConfig({
    appEnv: 'testing',
    dataDir: options.dataDir,
    realm: 'dsh-e2e',
    identity: {
      mode: 'w3',
      dataDir: options.dataDir,
      w3: {
        clientId: 'dsh-client',
        clientSecret: 'dsh-secret',
        authorizeUrl: `${options.providerUrl}/authorize`,
        tokenUrl: `${options.providerUrl}/token`,
        userinfoUrl: `${options.providerUrl}/userinfo`,
        logoutUrl: '',
        redirectUri: `${publicOrigin}/auth/callback`,
        scope: 'base.profile',
        tokenRequestFormat: 'json',
      },
    },
    runtime: {
      kind: 'process',
      repoRoot: options.repoRoot,
      root: `${options.dataDir}/spaces`,
      startTimeoutMs: 180_000,
      idleSeconds: 600,
      spaceKeySecret: 'e2e-space-key-secret-0123456789abcdef',
      patchFile: `${options.repoRoot}/deploy/runtime/platform-runtime.patch.yml`,
    },
    gateway: {
      listenHost: '127.0.0.1',
      listenPort: options.listenPort,
      publicOrigin,
      privateKeyFile: `${options.dataDir}/keys/gateway-ed25519-private.pem`,
      publicKeyFile: `${options.dataDir}/keys/gateway-ed25519-public.pem`,
      wsRevalidateSeconds: 1,
      generateKeyPairIfMissing: true,
    },
  })
}
