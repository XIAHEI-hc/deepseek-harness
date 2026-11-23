/**
 * Public gateway for the DSH multi-user platform.
 *
 * The gateway is the only public entry point. It authenticates every request
 * against the platform identity service, resolves the session user's private
 * runtime through the runtime manager, and proxies HTTP/SSE/WebSocket traffic
 * to that runtime only, attaching a fresh short-lived Ed25519 version 2
 * assertion. It also owns the platform surfaces that must never be proxied:
 * the login page, `/health`, `/auth/*`, and `/api/runtime/*`.
 *
 * Browser-supplied identity facts never select a route: the target always comes
 * from the validated session's user and the runtime manager's record of it.
 *
 * @module @deepseek-ai/dsh-platform-services/gateway
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { ensureGatewayKeyPair, type PlatformConfig } from '../config.ts'
import type {
  IdentityService,
  IntegrationService,
  PlatformHttpRequest,
  RuntimeEnsureResult,
  RuntimeManager,
  RuntimeStatusView,
  SessionLookup,
  ValidatedSession,
} from '../contracts.ts'
import { INTEGRATION_API_PREFIX } from '../integration/service.ts'
import { parseCookieHeader } from './cookies.ts'
import { hashUserId, noopGatewayLogger, type GatewayLogger } from './log.ts'
import {
  normalizeReturnTo,
  renderLoginPage,
  renderStatusPage,
  resolvePageLanguage,
  type StatusPageOptions,
} from './pages.ts'
import { proxyHttpRequest, type ProxyFacts } from './proxy.ts'
import {
  BodyTooLargeError,
  headerValue,
  readRequestBody,
  sendApiError,
  sendHtml,
  sendIdentityResult,
  sendJson,
} from './responses.ts'
import { createAssertionSigner, type AssertionSigner } from './signer.ts'
import { proxyWebSocketUpgrade, refuseUpgrade } from './websocket.ts'

/** Deployment health path. */
const HEALTH_PATH = '/health'
/** Deployment readiness path. */
const READY_PATH = '/ready'
/** Platform runtime status API prefix. */
const RUNTIME_API_PREFIX = '/api/runtime/'
/** Runtime status API returning the caller's own runtime state. */
const RUNTIME_ME_PATH = '/api/runtime/me'
/** Runtime wake API. */
const RUNTIME_WAKE_PATH = '/api/runtime/wake'
/** Runtime retry API. */
const RUNTIME_RETRY_PATH = '/api/runtime/retry'
/** Internal service surface; never reachable from the public listener. */
const INTERNAL_PREFIX = '/internal'
/** Identity surface handled by the identity service. */
const AUTH_PREFIX = '/auth'

/** Dependencies composed into the gateway. */
export interface GatewayDeps {
  /** Platform identity service. */
  readonly identity: IdentityService
  /** Per-user runtime lifecycle owner. */
  readonly runtime: RuntimeManager
  /** Optional system-fusion API; absent when fusion is disabled. */
  readonly integration?: IntegrationService | undefined
  /**
   * Injected signer; tests and embedded deployments may supply one instead of
   * the key pair named by the gateway configuration.
   */
  readonly signer?: AssertionSigner | undefined
  /** Stable-code log sink; the default discards every event. */
  readonly log?: GatewayLogger | undefined
}

/** Running public gateway handle. */
export interface GatewayHandle {
  /** The HTTP server; not listening until {@link GatewayHandle.listen}. */
  readonly server: Server
  /**
   * Bind the configured host and port.
   * @returns the actual bound host and port (the OS-chosen port when 0 was configured).
   */
  listen(): Promise<{ host: string; port: number }>
  /** Stop the listener and destroy every connection it owns. */
  close(): Promise<void>
  /** Assertion signer this gateway issues identity assertions with. */
  readonly signer: AssertionSigner
}

/**
 * Report whether a request is an API request that must receive JSON errors
 * instead of the login redirect.
 * @param request - incoming request.
 * @param pathname - request pathname.
 * @returns true for `/api/` paths and JSON-accepting requests.
 */
function wantsJson(request: IncomingMessage, pathname: string): boolean {
  if (pathname === '/api' || pathname.startsWith('/api/')) return true
  const accept = headerValue(request.headers, 'accept')
  return accept !== undefined && accept.includes('application/json')
}

/**
 * Report whether a method reads state.
 * @param method - upper-case request method.
 * @returns true for GET and HEAD.
 */
function isReadMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD'
}

/**
 * Project a runtime status into the only fields a browser may see.
 * @param status - runtime status or ensure result.
 * @returns the four public fields, never the private target.
 */
function publicRuntimeStatus(status: RuntimeStatusView): {
  state: RuntimeStatusView['state']
  generation: number
  retryable: boolean
  errorCode: string | null
} {
  return {
    state: status.state,
    generation: status.generation,
    retryable: status.retryable,
    errorCode: status.errorCode,
  }
}

/**
 * Compare a browser `Origin` header with the deployment's public origin.
 * @param origin - raw header value, or undefined when absent.
 * @param publicOrigin - deployment origin.
 * @returns true only for an exact same-origin value.
 */
function isSameOrigin(origin: string | undefined, publicOrigin: URL): boolean {
  if (origin === undefined || origin === '' || origin === 'null') return false
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch (error) {
    // An unparsable Origin names no origin this deployment serves.
    void error
    return false
  }
  return parsed.origin === publicOrigin.origin
}

/** Resolved per-gateway facts routing needs. */
interface GatewayRuntimeFacts {
  readonly publicOrigin: URL
  readonly publicAuthority: string
  readonly publicProtocol: 'http:' | 'https:'
  readonly loginPath: string
  readonly sessionCookieName: string
  readonly csrfCookieName: string
  readonly maxBodyBytes: number
  readonly wsRevalidateSeconds: number
}

/**
 * Build the gateway handle from resolved configuration and composed services.
 * @param config - resolved platform configuration.
 * @param deps - identity service, runtime manager, and optional signer/logger.
 * @returns the handle, not yet listening.
 * @throws {PlatformConfigError} when the signing key is missing or unusable and
 * no signer was injected.
 */
export async function createGateway(config: PlatformConfig, deps: GatewayDeps): Promise<GatewayHandle> {
  const log = deps.log ?? noopGatewayLogger
  const signer = deps.signer ?? createAssertionSigner({
    ...ensureGatewayKeyPair(config.gateway),
    issuer: config.gateway.issuer,
    audience: config.gateway.audience,
    keyId: config.gateway.keyId,
    assertionTtlSeconds: config.gateway.assertionTtlSeconds,
  })
  const publicOrigin = new URL(config.gateway.publicOrigin)
  const facts: GatewayRuntimeFacts = {
    publicOrigin,
    publicAuthority: config.runtime.publicAuthority === '' ? publicOrigin.host : config.runtime.publicAuthority,
    publicProtocol: publicOrigin.protocol === 'https:' ? 'https:' : 'http:',
    loginPath: config.gateway.loginPath,
    sessionCookieName: config.identity.sessionCookieName,
    csrfCookieName: config.identity.csrfCookieName,
    maxBodyBytes: config.gateway.maxBodyBytes,
    wsRevalidateSeconds: config.gateway.wsRevalidateSeconds,
  }
  const sockets = new Set<Duplex>()

  const track = (socket: Duplex): void => {
    sockets.add(socket)
    socket.once('close', () => {
      sockets.delete(socket)
    })
  }

  /** Parse the cookies one request presented. */
  const requestCookies = (request: IncomingMessage): Readonly<Record<string, string>> =>
    parseCookieHeader(headerValue(request.headers, 'cookie'))

  /**
   * Resolve the platform session one request presented.
   * @param request - incoming request.
   * @returns the session lookup result.
   */
  const authenticate = (request: IncomingMessage): Promise<SessionLookup> =>
    deps.identity.authenticate(requestCookies(request)[facts.sessionCookieName])

  /** Render the login page for one request. */
  const sendLoginPage = (request: IncomingMessage, response: ServerResponse, url: URL): void => {
    const language = resolvePageLanguage(headerValue(request.headers, 'accept-language'))
    sendHtml(response, 200, renderLoginPage({
      language,
      returnTo: normalizeReturnTo(url.searchParams.get('return_to'), config.gateway.publicOrigin),
      errorCode: url.searchParams.get('error') ?? undefined,
    }))
  }

  /** Render and send a status page for a non-READY runtime. */
  const sendStatusPage = (request: IncomingMessage, response: ServerResponse, status: RuntimeStatusView, httpStatus = 200): void => {
    const options: StatusPageOptions = {
      language: resolvePageLanguage(headerValue(request.headers, 'accept-language')),
      status,
    }
    sendHtml(response, httpStatus, renderStatusPage(options))
  }

  /**
   * Answer one `/api/runtime/*` request; the caller has already matched the path.
   * @returns a promise settling after the response is written.
   */
  const handleRuntimeApi = async (request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> => {
    const method = (request.method ?? 'GET').toUpperCase()
    const cookies = requestCookies(request)
    let lookup: SessionLookup
    try {
      lookup = await deps.identity.authenticate(cookies[facts.sessionCookieName])
    } catch (error) {
      void error
      log({ code: 'identity-unavailable' })
      sendApiError(response, 502, 'identity-unavailable')
      return
    }
    if (!lookup.ok) {
      sendApiError(response, 401, lookup.code)
      return
    }
    const session = lookup.session
    if (pathname === RUNTIME_ME_PATH) {
      if (method !== 'GET') {
        sendApiError(response, 405, 'method-not-allowed')
        return
      }
      try {
        const status = await deps.runtime.status(session.user.id)
        sendJson(response, 200, publicRuntimeStatus(status))
      } catch (error) {
        void error
        log({ code: 'runtime-unavailable', userIdHash: hashUserId(session.user.id) })
        sendApiError(response, 502, 'runtime-unavailable')
      }
      return
    }
    if (method !== 'POST') {
      sendApiError(response, 405, 'method-not-allowed')
      return
    }
    const csrfHeader = headerValue(request.headers, 'x-csrf-token')
    const csrfCookie = cookies[facts.csrfCookieName]
    if (!deps.identity.verifyCsrf(session, csrfHeader, csrfCookie)) {
      log({ code: 'csrf-invalid', userIdHash: hashUserId(session.user.id) })
      sendApiError(response, 403, 'csrf-invalid')
      return
    }
    deps.runtime.touch(session.user.id)
    let ensured: RuntimeEnsureResult
    try {
      ensured = pathname === RUNTIME_WAKE_PATH
        ? await deps.runtime.ensure(session.user.id)
        : await deps.runtime.retry(session.user.id)
    } catch (error) {
      void error
      log({ code: 'runtime-unavailable', userIdHash: hashUserId(session.user.id) })
      sendApiError(response, 502, 'runtime-unavailable')
      return
    }
    sendJson(response, 200, publicRuntimeStatus(ensured))
  }

  /**
   * Forward one request to the platform identity service.
   * @param request - incoming request.
   * @param response - browser response.
   * @param url - parsed request URL.
   */
  const handleIdentity = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    let body: string | undefined
    try {
      body = await readRequestBody(request, facts.maxBodyBytes)
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        sendApiError(response, 413, 'body-too-large')
        return
      }
      throw error
    }
    const cookies = requestCookies(request)
    const identityRequest: PlatformHttpRequest = {
      method: request.method ?? 'GET',
      url,
      headers: request.headers,
      cookies,
      body,
      clientAddress: request.socket.remoteAddress ?? undefined,
    }
    let result
    try {
      result = await deps.identity.handle(identityRequest)
    } catch (error) {
      void error
      log({ code: 'identity-unavailable' })
      sendApiError(response, 502, 'identity-unavailable')
      return
    }
    if (result === undefined) {
      sendApiError(response, 404, 'not-found')
      return
    }
    sendIdentityResult(response, result)
  }

  /**
   * Answer one `/api/integration/*` request.
   *
   * The gateway authenticates and enforces CSRF/origin before the fusion
   * service sees a request. The service then performs every object-ownership
   * check; the route never falls through to the native runtime proxy.
   * @param request - incoming request.
   * @param response - browser response.
   * @param url - parsed request URL.
   */
  const handleIntegration = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    const method = (request.method ?? 'GET').toUpperCase()
    let lookup: SessionLookup
    try {
      lookup = await authenticate(request)
    } catch (error) {
      void error
      log({ code: 'identity-unavailable' })
      sendApiError(response, 502, 'identity-unavailable')
      return
    }
    if (!lookup.ok) {
      sendApiError(response, 401, lookup.code)
      return
    }
    if (deps.integration === undefined) {
      sendApiError(response, 404, 'not-found')
      return
    }
    const cookies = requestCookies(request)
    if (!isReadMethod(method)) {
      const csrfHeader = headerValue(request.headers, 'x-csrf-token')
      if (!deps.identity.verifyCsrf(lookup.session, csrfHeader, cookies[facts.csrfCookieName])) {
        log({ code: 'csrf-invalid', userIdHash: hashUserId(lookup.session.user.id) })
        sendApiError(response, 403, 'csrf-invalid')
        return
      }
      const origin = headerValue(request.headers, 'origin')
      if (origin !== undefined && !isSameOrigin(origin, facts.publicOrigin)) {
        log({ code: 'integration-origin-refused', userIdHash: hashUserId(lookup.session.user.id) })
        sendApiError(response, 403, 'origin-invalid')
        return
      }
    }
    let body: string | undefined
    if (!isReadMethod(method)) {
      try {
        body = await readRequestBody(request, facts.maxBodyBytes)
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          sendApiError(response, 413, 'body-too-large')
          return
        }
        throw error
      }
    }
    const integrationRequest: PlatformHttpRequest = {
      method,
      url,
      headers: request.headers,
      cookies,
      ...(body === undefined ? {} : { body }),
      ...(request.socket.remoteAddress === undefined ? {} : { clientAddress: request.socket.remoteAddress }),
    }
    let result
    try {
      result = await deps.integration.handle(integrationRequest, lookup.session)
    } catch (error) {
      void error
      log({ code: 'integration-unavailable', userIdHash: hashUserId(lookup.session.user.id) })
      sendApiError(response, 502, 'integration-unavailable')
      return
    }
    if (result === undefined) {
      sendApiError(response, 404, 'not-found')
      return
    }
    sendIdentityResult(response, result)
  }

  /**
   * Route one unauthenticated or authenticated non-platform request.
   * @param request - incoming request.
   * @param response - browser response.
   * @param url - parsed request URL.
   */
  const handleProxiedRoute = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    const apiRequest = wantsJson(request, url.pathname)
    let lookup: SessionLookup
    try {
      lookup = await authenticate(request)
    } catch (error) {
      void error
      log({ code: 'identity-unavailable' })
      sendApiError(response, 502, 'identity-unavailable')
      return
    }
    if (!lookup.ok) {
      if (apiRequest) {
        sendApiError(response, 401, lookup.code)
        return
      }
      const relative = normalizeReturnTo(`${url.pathname}${url.search}`, config.gateway.publicOrigin) ?? '/'
      response.writeHead(302, {
        location: `${facts.loginPath}?return_to=${encodeURIComponent(relative)}`,
        'cache-control': 'no-store',
      })
      response.end()
      return
    }
    const session: ValidatedSession = lookup.session
    deps.runtime.touch(session.user.id)
    let ensured: RuntimeEnsureResult
    try {
      ensured = await deps.runtime.ensure(session.user.id)
    } catch (error) {
      void error
      log({ code: 'runtime-unavailable', userIdHash: hashUserId(session.user.id) })
      if (apiRequest) {
        sendApiError(response, 502, 'runtime-unavailable')
      } else {
        sendStatusPage(request, response, {
          state: 'FAILED',
          generation: 0,
          retryable: true,
          errorCode: 'RUNTIME_UNAVAILABLE',
        }, 502)
      }
      return
    }
    if (ensured.state !== 'READY' || ensured.target === undefined) {
      if (apiRequest) {
        sendApiError(response, 503, 'runtime-not-ready', {
          state: ensured.state,
          generation: ensured.generation,
          retryable: ensured.retryable,
          errorCode: ensured.errorCode,
        })
      } else {
        sendStatusPage(request, response, ensured)
      }
      return
    }
    const proxyFacts: ProxyFacts = {
      target: ensured.target,
      publicAuthority: facts.publicAuthority,
      publicProtocol: facts.publicProtocol,
      assertion: signer.sign({
        subject: session.user.id,
        sessionId: session.sessionId,
        permissionVersion: session.permissionVersion,
        generation: ensured.target.generation,
      }),
    }
    proxyHttpRequest(request, response, proxyFacts)
  }

  /**
   * Dispatch one HTTP request.
   * @param request - incoming request.
   * @param response - browser response.
   */
  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', facts.publicOrigin)
    const pathname = url.pathname
    const method = (request.method ?? 'GET').toUpperCase()
    if (pathname === HEALTH_PATH || pathname === READY_PATH) {
      if (!isReadMethod(method)) {
        sendApiError(response, 405, 'method-not-allowed')
        return
      }
      if (pathname === HEALTH_PATH) {
        sendJson(response, 200, { ok: true, mode: deps.identity.mode, runtimeKind: config.runtime.kind })
      } else {
        sendJson(response, 200, { ok: true })
      }
      return
    }
    if (pathname === facts.loginPath) {
      if (!isReadMethod(method)) {
        sendApiError(response, 405, 'method-not-allowed')
        return
      }
      sendLoginPage(request, response, url)
      return
    }
    if (pathname === INTERNAL_PREFIX || pathname.startsWith(`${INTERNAL_PREFIX}/`)) {
      // Internal service routes stay in-process; the public listener never forwards them.
      sendApiError(response, 404, 'not-found')
      return
    }
    if (pathname === AUTH_PREFIX || pathname.startsWith(`${AUTH_PREFIX}/`)) {
      await handleIdentity(request, response, url)
      return
    }
    if (pathname === RUNTIME_ME_PATH || pathname === RUNTIME_WAKE_PATH || pathname === RUNTIME_RETRY_PATH) {
      await handleRuntimeApi(request, response, pathname)
      return
    }
    if (pathname.startsWith(RUNTIME_API_PREFIX)) {
      sendApiError(response, 404, 'not-found')
      return
    }
    if (pathname === INTEGRATION_API_PREFIX || pathname.startsWith(`${INTEGRATION_API_PREFIX}/`)) {
      await handleIntegration(request, response, url)
      return
    }
    await handleProxiedRoute(request, response, url)
  }

  /**
   * Admit and forward one WebSocket upgrade.
   * @param request - upgrade request.
   * @param socket - client transport.
   * @param head - bytes the client already sent.
   */
  const handleUpgrade = async (request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    let lookup: SessionLookup
    try {
      lookup = await authenticate(request)
    } catch (error) {
      void error
      log({ code: 'identity-unavailable' })
      refuseUpgrade(socket, 502)
      return
    }
    if (!lookup.ok) {
      log({ code: 'ws-refused-session' })
      refuseUpgrade(socket, 401)
      return
    }
    const origin = headerValue(request.headers, 'origin')
    if (!isSameOrigin(origin, facts.publicOrigin)) {
      log({ code: 'ws-refused-origin', userIdHash: hashUserId(lookup.session.user.id) })
      refuseUpgrade(socket, 401)
      return
    }
    const session = lookup.session
    deps.runtime.touch(session.user.id)
    let ensured: RuntimeEnsureResult
    try {
      ensured = await deps.runtime.ensure(session.user.id)
    } catch (error) {
      void error
      log({ code: 'runtime-unavailable', userIdHash: hashUserId(session.user.id) })
      refuseUpgrade(socket, 502)
      return
    }
    if (ensured.state !== 'READY' || ensured.target === undefined) {
      log({ code: 'runtime-not-ready', userIdHash: hashUserId(session.user.id) })
      refuseUpgrade(socket, 503)
      return
    }
    const proxyFacts: ProxyFacts = {
      target: ensured.target,
      publicAuthority: facts.publicAuthority,
      publicProtocol: facts.publicProtocol,
      assertion: signer.sign({
        subject: session.user.id,
        sessionId: session.sessionId,
        permissionVersion: session.permissionVersion,
        generation: ensured.target.generation,
      }),
    }
    const sessionToken = requestCookies(request)[facts.sessionCookieName]
    proxyWebSocketUpgrade({
      request,
      clientSocket: socket,
      clientHead: head,
      session,
      sessionToken: sessionToken ?? '',
      identity: deps.identity,
      runtime: deps.runtime,
      facts: proxyFacts,
      revalidateSeconds: facts.wsRevalidateSeconds,
      log,
      track,
      untrack: (tracked) => {
        sockets.delete(tracked)
      },
    })
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      void error
      log({ code: 'request-failed' })
      if (response.headersSent) {
        response.destroy()
        return
      }
      sendApiError(response, 500, 'internal-error')
    })
  })
  server.on('connection', (socket) => {
    track(socket)
  })
  server.on('upgrade', (request, socket, head) => {
    void handleUpgrade(request, socket, head).catch((error: unknown) => {
      void error
      log({ code: 'upgrade-failed' })
      socket.destroy()
    })
  })

  const listen = (): Promise<{ host: string; port: number }> => new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error)
    }
    server.once('error', onError)
    server.listen(config.gateway.listenPort, config.gateway.listenHost, () => {
      server.off('error', onError)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('gateway: listener bound without a TCP address'))
        return
      }
      const bound = address as AddressInfo
      resolve({ host: bound.address, port: bound.port })
    })
  })

  const close = async (): Promise<void> => {
    const closed = new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
    server.closeAllConnections()
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    await closed
  }

  return { server, listen, close, signer }
}
