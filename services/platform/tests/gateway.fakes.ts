/** Self-contained fakes for gateway tests: identity, runtime manager, targets, WebSocket peers. */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signBytes,
  type KeyObject,
} from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { createPlatformConfig, type GatewayConfig, type PlatformConfig } from '../src/config.ts'
import type {
  IdentityService,
  IntegrationService,
  PlatformAuditEvent,
  PlatformHttpRequest,
  PlatformHttpResult,
  PlatformUser,
  RuntimeEnsureResult,
  RuntimeManager,
  RuntimeStatusView,
  RuntimeTarget,
  SessionLookup,
  SetCookie,
  ValidatedSession,
} from '../src/contracts.ts'
import type { AssertionSigner } from '../src/gateway/signer.ts'
import type { GatewayHandle } from '../src/gateway/index.ts'
import type { GatewayLogger } from '../src/gateway/log.ts'
import type { GatewayAssertionPolicy } from '../../../packages/host/authentication-gateway/src/assertion.ts'
import type { ReplayWindow } from '../../../packages/host/authentication-gateway/src/replay.ts'
import { createGateway } from '../src/gateway/index.ts'

/**
 * Parse one PEM Ed25519 private key.
 * @param pem - PEM text.
 * @returns the key object.
 */
function createPrivateKeyFromPem(pem: string): KeyObject {
  return createPrivateKey(pem)
}

/**
 * Export the public half of one private key as PEM.
 * @param privateKey - private key object.
 * @returns PEM public key text.
 */
function createPublicKeyFromPem(privateKey: KeyObject): string {
  return createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()
}

/** Origin every test deployment presents to browsers. */
export const TEST_PUBLIC_ORIGIN = 'http://127.0.0.1:7777'

/**
 * Create one isolated platform configuration for a gateway test.
 * @param overrides - optional gateway config overrides.
 * @returns a testing configuration with an ephemeral listener and test origin.
 */
export function createGatewayTestConfig(overrides: Partial<GatewayConfig> = {}): PlatformConfig {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-platform-gateway-'))
  return createPlatformConfig({
    dataDir,
    gateway: {
      publicOrigin: TEST_PUBLIC_ORIGIN,
      listenHost: '127.0.0.1',
      listenPort: 0,
      ...overrides,
    },
  })
}

/** Remove the temporary directory one test configuration owns. */
export function removeGatewayTestConfig(config: PlatformConfig): void {
  rmSync(config.dataDir, { recursive: true, force: true })
}

/** A signing key pair plus the gateway signer built on it. */
export interface TestSigner {
  readonly signer: AssertionSigner
  readonly privateKey: KeyObject
  readonly publicKeyPem: string
}

/**
 * Generate an Ed25519 signer and write its private key where the gateway config points.
 * @param config - platform configuration naming the key files.
 * @param overrides - issuer, audience, key id, or TTL overrides.
 * @returns the signer and its public PEM.
 */
export function createTestSigner(
  config: PlatformConfig,
  overrides: { issuer?: string; audience?: string; keyId?: string; assertionTtlSeconds?: number } = {},
): TestSigner {
  const pair = generateKeyPairSync('ed25519')
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const privateKeyFile = config.gateway.privateKeyFile
  mkdirSync(join(privateKeyFile, '..'), { recursive: true })
  writeFileSync(privateKeyFile, privateKeyPem, { mode: 0o600 })
  writeFileSync(config.gateway.publicKeyFile, publicKeyPem, { mode: 0o644 })
  return {
    privateKey: pair.privateKey,
    publicKeyPem,
    signer: createGatewaySignerFromPem(config, privateKeyPem, overrides),
  }
}

/**
 * Build a signer directly from PEM text, without touching the configured key files.
 * @param config - platform configuration providing issuer, audience, key id, and TTL.
 * @param privateKeyPem - PEM private key.
 * @param overrides - claim overrides.
 * @returns the signer.
 */
function createGatewaySignerFromPem(
  config: PlatformConfig,
  privateKeyPem: string,
  overrides: { issuer?: string; audience?: string; keyId?: string; assertionTtlSeconds?: number } = {},
): AssertionSigner {
  const privateKey = createPrivateKeyFromPem(privateKeyPem)
  const publicKeyPem = createPublicKeyFromPem(privateKey)
  const issuer = overrides.issuer ?? config.gateway.issuer
  const audience = overrides.audience ?? config.gateway.audience
  const keyId = overrides.keyId ?? config.gateway.keyId
  const ttl = overrides.assertionTtlSeconds ?? config.gateway.assertionTtlSeconds
  return {
    issuer,
    audience,
    keyId,
    publicKeyPem,
    sign(claims, nowMs = Date.now()) {
      const issuedAt = Math.floor(nowMs / 1000)
      const segment = Buffer.from(JSON.stringify({
        v: 2,
        iss: issuer,
        aud: audience,
        sub: claims.subject,
        sid: claims.sessionId,
        pv: claims.permissionVersion,
        gen: claims.generation,
        iat: issuedAt,
        exp: issuedAt + ttl,
        jti: 'jti-' + createHash('sha256').update(`${String(nowMs)}:${String(Math.random())}`).digest('hex').slice(0, 16),
        kid: keyId,
      }), 'utf8').toString('base64url')
      const signature = signBytes(null, Buffer.from(`dsh-gateway-identity.2.${segment}`, 'utf8'), privateKey)
      return `${segment}.${signature.toString('base64url')}`
    },
  }
}

/** One test user. */
export function testUser(id: string, subject = `w3-${id}`): PlatformUser {
  return { id, subject, uid: `uid-${id}`, displayName: `User ${id}`, email: null }
}

/** One stored fake session. */
export interface StoredFakeSession {
  readonly token: string
  readonly csrfToken: string
  readonly session: ValidatedSession
  revoked: boolean
}

/** Programmable identity service implementing the platform contract. */
export class FakeIdentityService implements IdentityService {
  readonly mode = 'mock' as const
  readonly sessions = new Map<string, StoredFakeSession>()
  readonly handled: PlatformHttpRequest[] = []
  readonly auditEvents: PlatformAuditEvent[] = []
  csrfValid = true
  healthBody = '{"ok":true}'
  closed = false
  #sequence = 0

  /** Store a session token for a user. */
  issueSession(
    user: PlatformUser,
    options: { sessionId?: string; permissionVersion?: number; expiresAt?: number } = {},
  ): StoredFakeSession {
    this.#sequence += 1
    const token = `session-token-${String(this.#sequence)}`
    const csrfToken = `csrf-token-${String(this.#sequence)}`
    const session: ValidatedSession = {
      user,
      sessionId: options.sessionId ?? `session-${String(this.#sequence)}`,
      permissionVersion: options.permissionVersion ?? 1,
      expiresAt: options.expiresAt ?? Date.now() + 3_600_000,
      absoluteExpiresAt: Date.now() + 7_200_000,
    }
    const stored: StoredFakeSession = { token, csrfToken, session, revoked: false }
    this.sessions.set(token, stored)
    return stored
  }

  /** @inheritDoc */
  recordAudit(event: PlatformAuditEvent): void {
    this.auditEvents.push(event)
  }

  /** Mark a session revoked (logout or administrator revocation). */
  revoke(token: string): void {
    const stored = this.sessions.get(token)
    if (stored !== undefined) stored.revoked = true
  }

  /** Cookie name the session token is stored under. */
  sessionCookieName = 'dsh_session'
  /** Cookie name the CSRF token is stored under. */
  csrfCookieName = 'dsh_csrf'

  async handle(request: PlatformHttpRequest): Promise<PlatformHttpResult | undefined> {
    this.handled.push(request)
    const path = request.url.pathname
    if (!path.startsWith('/auth/')) return undefined
    if (path === '/auth/health' && request.method === 'GET') {
      return { status: 200, headers: { 'content-type': 'application/json' }, body: this.healthBody }
    }
    if (path === '/auth/login' && request.method === 'GET') {
      const token = request.cookies[this.sessionCookieName]
      void token
      const user = testUser('login-user')
      const stored = this.issueSession(user)
      const returnTo = request.url.searchParams.get('return_to')
      return {
        status: 302,
        headers: { location: returnTo ?? '/' },
        cookies: [
          this.cookie(this.sessionCookieName, stored.token, true),
          this.cookie(this.csrfCookieName, stored.csrfToken, false),
        ],
      }
    }
    if (path === '/auth/me' && request.method === 'GET') {
      const token = request.cookies[this.sessionCookieName]
      const lookup = await this.authenticate(token)
      if (!lookup.ok) return { status: 401, headers: { 'content-type': 'application/json' }, body: `{"error":{"code":"${lookup.code}"}}` }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user: lookup.session.user, sessionExpiresAt: new Date(lookup.session.expiresAt).toISOString() }),
      }
    }
    if (path === '/auth/logout' && request.method === 'POST') {
      const token = request.cookies[this.sessionCookieName]
      if (token !== undefined) this.revoke(token)
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
        cookies: [
          this.cookie(this.sessionCookieName, '', true, 0),
          this.cookie(this.csrfCookieName, '', false, 0),
        ],
      }
    }
    return { status: 404, headers: { 'content-type': 'application/json' }, body: '{"error":{"code":"not-found"}}' }
  }

  async authenticate(sessionToken: string | undefined): Promise<SessionLookup> {
    if (sessionToken === undefined) return { ok: false, code: 'no-session' }
    const stored = this.sessions.get(sessionToken)
    if (stored === undefined) return { ok: false, code: 'session-invalid' }
    if (stored.revoked) return { ok: false, code: 'session-revoked' }
    if (stored.session.expiresAt <= Date.now()) return { ok: false, code: 'session-expired' }
    return { ok: true, session: stored.session }
  }

  isSessionActive(sessionId: string, userId: string, permissionVersion: number): boolean {
    for (const stored of this.sessions.values()) {
      if (stored.session.sessionId !== sessionId) continue
      return !stored.revoked
        && stored.session.user.id === userId
        && stored.session.permissionVersion === permissionVersion
        && stored.session.expiresAt > Date.now()
    }
    return false
  }

  verifyCsrf(session: ValidatedSession, csrfHeader: string | undefined, csrfCookie: string | undefined): boolean {
    if (!this.csrfValid) return false
    for (const stored of this.sessions.values()) {
      if (stored.session.sessionId !== session.sessionId) continue
      return csrfHeader === stored.csrfToken && csrfCookie === stored.csrfToken
    }
    return false
  }

  async close(): Promise<void> {
    this.closed = true
  }

  /** Build one platform cookie descriptor. */
  cookie(name: string, value: string, httpOnly: boolean, maxAgeSeconds?: number): SetCookie {
    return { name, value, httpOnly, secure: false, sameSite: 'Lax', path: '/', maxAgeSeconds }
  }
}

/** One registered fake runtime. */
export interface FakeRuntimeEntry {
  status: RuntimeStatusView
  target: RuntimeTarget | undefined
}

/** Programmable runtime manager implementing the platform contract. */
export class FakeRuntimeManager implements RuntimeManager {
  readonly entries = new Map<string, FakeRuntimeEntry>()
  readonly ensureCalls: string[] = []
  readonly retryCalls: string[] = []
  readonly restartCalls: string[] = []
  readonly touchCalls: string[] = []
  readonly statusCalls: string[] = []
  leaseCount = 0
  leaseReleases = 0
  liveLeases = 0
  ensureError: Error | undefined
  retryError: Error | undefined
  statusError: Error | undefined
  closed = false

  /** Register a READY runtime for one user. */
  addRuntime(userId: string, target: RuntimeTarget, status: Partial<RuntimeStatusView> = {}): void {
    this.entries.set(userId, {
      status: {
        state: 'READY',
        generation: target.generation,
        retryable: false,
        errorCode: null,
        ...status,
      },
      target,
    })
  }

  /** Store a non-READY runtime state for one user. */
  setStatus(userId: string, status: RuntimeStatusView): void {
    const entry = this.entries.get(userId)
    if (entry === undefined) {
      this.entries.set(userId, { status, target: undefined })
      return
    }
    entry.status = status
    if (status.state !== 'READY') entry.target = undefined
  }

  async ensure(userId: string): Promise<RuntimeEnsureResult> {
    this.ensureCalls.push(userId)
    if (this.ensureError !== undefined) throw this.ensureError
    const entry = this.entries.get(userId)
    if (entry === undefined) {
      return { state: 'UNALLOCATED', generation: 0, retryable: true, errorCode: null }
    }
    return { ...entry.status, target: entry.target }
  }

  async retry(userId: string): Promise<RuntimeEnsureResult> {
    this.retryCalls.push(userId)
    if (this.retryError !== undefined) throw this.retryError
    return this.ensure(userId)
  }

  async restart(userId: string): Promise<RuntimeEnsureResult> {
    this.restartCalls.push(userId)
    return this.ensure(userId)
  }

  async status(userId: string): Promise<RuntimeStatusView> {
    this.statusCalls.push(userId)
    if (this.statusError !== undefined) throw this.statusError
    return this.entries.get(userId)?.status ?? { state: 'UNALLOCATED', generation: 0, retryable: true, errorCode: null }
  }

  touch(userId: string): void {
    this.touchCalls.push(userId)
  }

  lease(userId: string): () => void {
    void userId
    this.leaseCount += 1
    this.liveLeases += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.leaseReleases += 1
      this.liveLeases -= 1
    }
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

/** One request a fake runtime target received. */
export interface RecordedTargetRequest {
  readonly method: string
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
}

/** One upgrade a fake runtime target received. */
export interface RecordedTargetUpgrade {
  readonly url: string
  readonly headers: IncomingHttpHeaders
}

/** Minimal WebSocket text-frame codec used by the test client and the echo target. */
export interface ParsedFrame {
  readonly opcode: number
  readonly payload: Buffer
  readonly rest: Buffer
}

/**
 * Parse one client-to-server (masked) or server-to-client (unmasked) frame.
 * @param buffer - accumulated bytes.
 * @returns the parsed frame and the remaining bytes, or undefined when incomplete.
 */
export function parseWebSocketFrame(buffer: Buffer): ParsedFrame | undefined {
  if (buffer.length < 2) return undefined
  const first = buffer[0] ?? 0
  const second = buffer[1] ?? 0
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return undefined
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return undefined
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  const maskBytes = masked ? 4 : 0
  if (buffer.length < offset + maskBytes + length) return undefined
  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined
  const payload = Buffer.from(buffer.subarray(offset + maskBytes, offset + maskBytes + length))
  if (mask !== undefined) {
    for (let index = 0; index < payload.length; index += 1) {
      const byte = payload[index]
      const maskByte = mask[index % 4]
      if (byte === undefined || maskByte === undefined) continue
      payload[index] = byte ^ maskByte
    }
  }
  return { opcode: first & 0x0f, payload, rest: buffer.subarray(offset + maskBytes + length) }
}

/**
 * Encode one masked text frame as a browser sends it.
 * @param text - UTF-8 text.
 * @param mask - four mask bytes.
 * @returns the wire frame.
 */
export function encodeMaskedTextFrame(text: string, mask = Buffer.from([0x12, 0x34, 0x56, 0x78])): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const header = payload.length < 126
    ? Buffer.from([0x81, 0x80 | payload.length])
    : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff])
  const masked = Buffer.from(payload)
  for (let index = 0; index < masked.length; index += 1) {
    const byte = masked[index]
    const maskByte = mask[index % 4]
    if (byte === undefined || maskByte === undefined) continue
    masked[index] = byte ^ maskByte
  }
  return Buffer.concat([header, mask, masked])
}

/**
 * Encode one unmasked text frame as a server sends it.
 * @param text - UTF-8 text.
 * @returns the wire frame.
 */
export function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
  return Buffer.concat([header, payload])
}

/** Keep only the received bytes of a `data` event. */
function dataBuffer(chunk: Buffer | string): Buffer {
  return typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
}

/** Fake per-user runtime target: an HTTP server plus a WebSocket echo upgrade. */
export class FakeRuntimeTarget {
  readonly requests: RecordedTargetRequest[] = []
  readonly upgrades: RecordedTargetUpgrade[] = []
  readonly server: Server
  readonly name: string
  readonly #upgradedSockets = new Set<Duplex>()
  #sseRelease: (() => void) | undefined
  host = '127.0.0.1'
  port = 0

  /** @param name - marker the JSON responses and recorded facts identify the target by. */
  constructor(name: string) {
    this.name = name
    this.server = createServer((request, response) => {
      void this.#handleHttp(request, response)
    })
    this.server.on('upgrade', (request, socket, head) => {
      this.#handleUpgrade(request, socket, head)
    })
  }

  /** Bind an ephemeral loopback port. */
  async start(): Promise<{ host: string; port: number }> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('fake target bound without a TCP address')
    this.host = address.address
    this.port = address.port
    return { host: this.host, port: this.port }
  }

  /** Release the SSE request currently waiting between its two chunks. */
  releaseSse(): void {
    const release = this.#sseRelease
    this.#sseRelease = undefined
    release?.()
  }

  /** Stop the target and every open connection. */
  async stop(): Promise<void> {
    const closed = new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve()
      })
    })
    this.server.closeAllConnections()
    // node:http keeps upgraded sockets outside closeAllConnections' table.
    for (const socket of this.#upgradedSockets) socket.destroy()
    this.#upgradedSockets.clear()
    await closed
  }

  /** One public target descriptor. */
  target(generation: number): RuntimeTarget {
    return { host: this.host, port: this.port, generation }
  }

  async #handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(dataBuffer(chunk))
    this.requests.push({
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      headers: request.headers,
      body: Buffer.concat(chunks),
    })
    const url = new URL(request.url ?? '/', 'http://target')
    if (url.pathname === '/sse') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      response.write('data: first\n\n')
      await new Promise<void>((resolve) => {
        this.#sseRelease = resolve
      })
      response.write('data: second\n\n')
      response.end()
      return
    }
    if (url.pathname === '/big-response') {
      const body = Buffer.alloc(5 * 1024 * 1024, 0x61)
      for (let index = 0; index < body.length; index += 1) body[index] = index % 251
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(body.length),
        'x-dsh-internal-target': 'leak',
        'set-cookie': 'runtime_cookie=leak',
      })
      response.end(body)
      return
    }
    const body = JSON.stringify({
      target: this.name,
      method: request.method,
      url: request.url,
      bytes: Buffer.concat(chunks).length,
      sha: createHash('sha256').update(Buffer.concat(chunks)).digest('hex'),
    })
    response.writeHead(200, {
      'content-type': 'application/json',
      'x-dsh-internal-target': 'leak',
      'x-runtime-target': this.name,
      'set-cookie': 'runtime_cookie=leak',
      'cache-control': 'no-store',
    })
    response.end(body)
  }

  #handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.upgrades.push({ url: request.url ?? '/', headers: request.headers })
    this.#upgradedSockets.add(socket)
    socket.once('close', () => {
      this.#upgradedSockets.delete(socket)
    })
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n`
      + '\r\n',
    )
    if (head.length > 0) this.#echo(socket, head)
    socket.on('data', (chunk: Buffer) => {
      this.#echo(socket, chunk)
    })
    socket.on('error', () => {
      socket.destroy()
    })
  }

  /** Echo every complete client text frame back as an unmasked server frame. */
  #echo(socket: Duplex, chunk: Buffer): void {
    if (socket.destroyed) return
    let rest = chunk
    for (let frame = parseWebSocketFrame(rest); frame !== undefined; frame = parseWebSocketFrame(rest)) {
      rest = frame.rest
      if (frame.opcode === 0x8) {
        socket.end()
        return
      }
      socket.write(encodeTextFrame(frame.payload.toString('utf8')))
    }
  }
}

/** Handshake result of the minimal WebSocket test client. */
export interface WebSocketHandshake {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly socket: Duplex | undefined
  readonly body: string
}

/**
 * Send one WebSocket upgrade with browser-like headers.
 * @param options - absolute gateway URL, Origin header, and Cookie header.
 * @returns the handshake status, headers, and (on 101) the transport.
 */
export async function openWebSocketHandshake(options: {
  url: string
  origin?: string
  cookie?: string
  extraHeaders?: Record<string, string>
}): Promise<WebSocketHandshake> {
  const target = new URL(options.url)
  const key = Buffer.from('0123456789abcdef').toString('base64')
  return new Promise<WebSocketHandshake>((resolve, reject) => {
    const headers: Record<string, string> = {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': key,
      ...options.extraHeaders,
    }
    if (options.origin !== undefined) headers.origin = options.origin
    if (options.cookie !== undefined) headers.cookie = options.cookie
    const request = httpRequest({
      host: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers,
    })
    request.on('upgrade', (response, socket: Duplex) => {
      resolve({ status: response.statusCode ?? 0, headers: response.headers, socket, body: '' })
    })
    request.on('response', (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, headers: response.headers, socket: undefined, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    request.on('error', reject)
    request.end()
  })
}

/** Minimal framed WebSocket client over one upgraded transport. */
export class WebSocketTestClient {
  readonly #socket: Duplex
  readonly #messages: string[] = []
  readonly #waiters: ((message: string) => void)[] = []
  #buffer: Buffer = Buffer.alloc(0)
  readonly closed: Promise<void>
  #resolveClosed: () => void = () => {}

  /** @param socket - transport the gateway upgraded. */
  constructor(socket: Duplex) {
    this.#socket = socket
    this.closed = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve
    })
    socket.on('data', (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk])
      this.#drain()
    })
    socket.on('close', () => {
      this.#resolveClosed()
    })
    socket.on('error', () => {
      this.#resolveClosed()
    })
  }

  /** Send one text message. */
  send(text: string): void {
    this.#socket.write(encodeMaskedTextFrame(text))
  }

  /**
   * Wait for the next echoed text message.
   * @param timeoutMs - rejection deadline.
   * @returns the message text.
   */
  async nextMessage(timeoutMs = 3_000): Promise<string> {
    const queued = this.#messages.shift()
    if (queued !== undefined) return queued
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('websocket message timed out'))
      }, timeoutMs)
      this.#waiters.push((message) => {
        clearTimeout(timer)
        resolve(message)
      })
    })
  }

  /** Destroy the client transport. */
  close(): void {
    this.#socket.destroy()
  }

  #drain(): void {
    for (let frame = parseWebSocketFrame(this.#buffer); frame !== undefined; frame = parseWebSocketFrame(this.#buffer)) {
      this.#buffer = frame.rest
      if (frame.opcode !== 0x1) continue
      const text = frame.payload.toString('utf8')
      const waiter = this.#waiters.shift()
      if (waiter !== undefined) waiter(text)
      else this.#messages.push(text)
    }
  }
}

/**
 * Sign one assertion directly with a test private key, so tests can fabricate
 * hostile headers without going through the gateway signer.
 * @param privateKey - Ed25519 private key.
 * @param payload - claim set to sign.
 * @returns the wire assertion.
 */
export function signRawAssertion(privateKey: KeyObject, payload: Record<string, unknown>): string {
  const segment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = signBytes(null, Buffer.from(`dsh-gateway-identity.2.${segment}`, 'utf8'), privateKey)
  return `${segment}.${signature.toString('base64url')}`
}

/** SHA-256 hex of a buffer. */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** One running gateway plus the URL tests call it on. */
export interface RunningTestGateway {
  readonly gateway: GatewayHandle
  readonly url: string
  close(): Promise<void>
}

/**
 * Create and bind one gateway for a test.
 * @param config - platform configuration.
 * @param deps - identity, runtime, and optional signer/logger.
 * @returns the running gateway and its base URL.
 */
export async function startTestGateway(
  config: PlatformConfig,
  deps: {
    identity: IdentityService
    runtime: RuntimeManager
    signer: AssertionSigner
    log?: GatewayLogger
    integration?: IntegrationService
  },
): Promise<RunningTestGateway> {
  const gateway = await createGateway(config, {
    identity: deps.identity,
    runtime: deps.runtime,
    signer: deps.signer,
    ...(deps.log === undefined ? {} : { log: deps.log }),
    ...(deps.integration === undefined ? {} : { integration: deps.integration }),
  })
  const bound = await gateway.listen()
  return {
    gateway,
    url: `http://${bound.host}:${String(bound.port)}`,
    async close(): Promise<void> {
      await gateway.close()
      await deps.runtime.close()
      await deps.identity.close()
    },
  }
}

/**
 * Build the Cookie header one stored fake session presents.
 * @param stored - session record.
 * @returns a `Cookie` header value carrying the session and CSRF cookies.
 */
export function sessionCookieHeader(stored: StoredFakeSession): string {
  return `dsh_session=${stored.token}; dsh_csrf=${stored.csrfToken}`
}

/**
 * Decode one assertion's payload without verifying it.
 * @param assertion - wire assertion.
 * @returns the parsed claim object.
 */
export function decodeAssertionPayload(assertion: string): Record<string, unknown> {
  const segment = assertion.split('.')[0] ?? ''
  const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('fakes: assertion payload is not a JSON object')
  }
  return parsed as Record<string, unknown>
}

/**
 * Build the runtime verifier policy matching one test signer.
 * @param options - signer, expected subject, and optional pinned claims.
 * @returns the verification policy.
 */
export function buildGatewayAssertionPolicy(options: {
  signer: AssertionSigner
  subject: string
  audience: string
  maxLifetimeSeconds?: number
  clockSkewSeconds?: number
  issuer?: string
  keyId?: string
  generation?: number
  replay?: ReplayWindow
}): GatewayAssertionPolicy {
  return {
    algorithm: 'ed25519',
    secret: undefined,
    publicKey: createPublicKey(options.signer.publicKeyPem),
    audience: options.audience,
    subject: options.subject,
    clockSkewSeconds: options.clockSkewSeconds ?? 30,
    maxLifetimeSeconds: options.maxLifetimeSeconds ?? 300,
    issuer: options.issuer,
    keyId: options.keyId,
    generation: options.generation,
    replay: options.replay,
  }
}
