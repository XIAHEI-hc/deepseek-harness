/**
 * WebSocket upgrade proxy from the public gateway to one user runtime.
 *
 * A browser upgrade is admitted only with a valid platform session and an
 * `Origin` equal to the deployment's public origin. The gateway then resolves
 * the session user's runtime, signs a fresh generation-bound assertion, and
 * forwards the handshake; afterwards it revalidates the session and the runtime
 * generation every `wsRevalidateSeconds` and tears the tunnel down as soon as
 * either stops matching. One runtime lease is held for the tunnel's lifetime so
 * idle reclamation cannot stop a runtime with a live connection.
 *
 * @module @deepseek-ai/dsh-platform-services/gateway/websocket
 */

import { request as httpRequest, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { IdentityService, RuntimeManager, ValidatedSession } from '../contracts.ts'
import { hashUserId, type GatewayLogger } from './log.ts'
import { buildForwardHeaders, PROXY_IDLE_TIMEOUT_MS, type ProxyFacts } from './proxy.ts'

/** HTTP reason phrases for the refusal statuses this proxy emits. */
const REFUSAL_REASONS: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
}

/** Upgrade response header names copied from the runtime handshake. */
const WEBSOCKET_PROTOCOL_HEADERS: readonly string[] = [
  'sec-websocket-accept',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
]

/**
 * Answer a refused WebSocket upgrade with a short HTTP text response, then
 * close the socket. No internal state is disclosed.
 * @param socket - transport the upgrade arrived on.
 * @param status - refusal status code.
 */
export function refuseUpgrade(socket: Duplex, status: number): void {
  const reason = REFUSAL_REASONS[status] ?? 'Error'
  const body = `${reason.toLowerCase()}\n`
  const head = `HTTP/1.1 ${String(status)} ${reason}\r\n`
    + 'Connection: close\r\n'
    + 'Cache-Control: no-store\r\n'
    + 'Content-Type: text/plain; charset=utf-8\r\n'
    + `Content-Length: ${String(Buffer.byteLength(body))}\r\n`
    + '\r\n'
    + body
  socket.end(head, () => {
    socket.destroy()
  })
}

/**
 * Title-case one lower-case header name for the handshake response.
 * @param name - lower-case header name.
 * @returns the conventional header casing.
 */
function titleCaseHeader(name: string): string {
  return name.replace(/(^|-)([a-z])/g, (_match, dash: string, letter: string) => `${dash}${letter.toUpperCase()}`)
}

/** Everything one admitted upgrade needs to reach its runtime. */
export interface WebSocketProxyOptions {
  /** Original browser upgrade request. */
  readonly request: IncomingMessage
  /** Browser transport that carried the upgrade request. */
  readonly clientSocket: Duplex
  /** Bytes the browser sent after its upgrade request headers. */
  readonly clientHead: Buffer
  /** Validated platform session that authorized the upgrade. */
  readonly session: ValidatedSession
  /** Raw session token, kept only for revalidation. */
  readonly sessionToken: string
  /** Identity service used to revalidate the token. */
  readonly identity: IdentityService
  /** Runtime manager owning the generation check and the lease. */
  readonly runtime: RuntimeManager
  /** Target runtime and deployment facts the assertion was signed for. */
  readonly facts: ProxyFacts
  /** Session revalidation period in seconds. */
  readonly revalidateSeconds: number
  /** Stable-code logger. */
  readonly log: GatewayLogger
  /** Registers a socket so gateway shutdown can destroy it. */
  readonly track: (socket: Duplex) => void
  /** Removes a previously tracked socket. */
  readonly untrack: (socket: Duplex) => void
}

/**
 * Forward one admitted WebSocket upgrade and supervise the resulting tunnel.
 *
 * The runtime generation the assertion was signed for is fixed before the
 * handshake; every revalidation compares the runtime's current generation
 * against it, so a restart, logout, or revoked session closes the tunnel within
 * one revalidation period.
 * @param options - browser transport, session, runtime facts, and lifecycle hooks.
 */
export function proxyWebSocketUpgrade(options: WebSocketProxyOptions): void {
  const {
    request, clientSocket, clientHead, session, sessionToken,
    identity, runtime, facts, revalidateSeconds, log, track, untrack,
  } = options
  track(clientSocket)
  const release = runtime.lease(session.user.id)
  const userIdHash = hashUserId(session.user.id)
  let backendSocket: Duplex | undefined
  let timer: NodeJS.Timeout | undefined
  let finished = false
  let settled = false
  let revalidating = false

  /**
   * Release every resource this tunnel owns exactly once.
   * @param code - stable close reason for the log.
   * @param destroyClient - false when the caller already wrote the final refusal.
   */
  const finish = (code: string, destroyClient = true): void => {
    if (finished) return
    finished = true
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
    release()
    untrack(clientSocket)
    if (backendSocket !== undefined) {
      untrack(backendSocket)
      backendSocket.destroy()
      backendSocket = undefined
    }
    if (destroyClient) clientSocket.destroy()
    log({ code, userIdHash })
  }

  clientSocket.on('error', () => {
    finish('ws-client-error')
  })

  const upstream = httpRequest({
    host: facts.target.host,
    port: facts.target.port,
    method: request.method ?? 'GET',
    path: request.url ?? '/',
    headers: buildForwardHeaders(request.headers, facts, {
      connection: 'Upgrade',
      upgrade: 'websocket',
    }),
  })
  upstream.setTimeout(PROXY_IDLE_TIMEOUT_MS, () => {
    upstream.destroy(new Error('gateway: websocket handshake timed out'))
  })
  upstream.on('upgrade', (upstreamResponse, upgradedSocket: Duplex, upstreamHead) => {
    settled = true
    backendSocket = upgradedSocket
    track(upgradedSocket)
    track(upgradedSocket)
    // The handshake finished; a WebSocket connection is long-lived by design,
    // so neither transport keeps the request idle timeout. The upgraded
    // transport is a net.Socket even though node:http types it as Duplex.
    upstream.setTimeout(0)
    const idleTimeoutTransport = upgradedSocket as Duplex & { setTimeout(ms: number): void }
    idleTimeoutTransport.setTimeout(0)
    const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade']
    for (const name of WEBSOCKET_PROTOCOL_HEADERS) {
      const value = upstreamResponse.headers[name]
      if (value === undefined) continue
      const text = Array.isArray(value) ? value.join(', ') : value
      lines.push(`${titleCaseHeader(name)}: ${text}`)
    }
    clientSocket.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (upstreamHead.length > 0) clientSocket.write(upstreamHead)
    if (clientHead.length > 0) upgradedSocket.write(clientHead)
    upgradedSocket.on('error', () => {
      finish('ws-backend-error')
    })
    upgradedSocket.on('close', () => {
      finish('ws-backend-closed')
    })
    upgradedSocket.on('end', () => {
      // The runtime half-closed the tunnel; the browser side must not stay open.
      finish('ws-backend-closed')
    })
    clientSocket.on('close', () => {
      finish('ws-client-closed')
    })
    clientSocket.on('end', () => {
      // A WebSocket close always ends both directions; a half-closed tunnel is over.
      finish('ws-client-closed')
    })
    clientSocket.pipe(upgradedSocket)
    upgradedSocket.pipe(clientSocket)
    timer = setInterval(() => {
      void revalidate()
    }, revalidateSeconds * 1000)
    timer.unref()
  })
  upstream.on('response', (upstreamResponse) => {
    // The runtime answered the handshake with an HTTP failure; its status and
    // body are internal and must not reach the browser.
    upstreamResponse.resume()
    if (settled) return
    settled = true
    refuseUpgrade(clientSocket, 502)
    finish('ws-upstream-refused', false)
  })
  upstream.on('error', () => {
    if (settled) return
    settled = true
    refuseUpgrade(clientSocket, 502)
    finish('ws-upstream-error', false)
  })
  clientSocket.on('close', () => {
    // The browser disappeared before the handshake settled; abandon the attempt.
    if (settled) return
    settled = true
    upstream.destroy()
    finish('ws-client-closed', false)
  })
  upstream.end()

  /** Revalidate the session and the runtime generation once. */
  async function revalidate(): Promise<void> {
    if (finished || revalidating) return
    revalidating = true
    try {
      const lookup = await identity.authenticate(sessionToken)
      if (!lookup.ok
        || lookup.session.user.id !== session.user.id
        || lookup.session.sessionId !== session.sessionId) {
        finish('ws-session-invalid')
        return
      }
      const status = await runtime.status(session.user.id)
      if (status.state !== 'READY' || status.generation !== facts.target.generation) {
        finish('ws-generation-changed')
      }
    } catch (error) {
      // Revalidation is fail-closed: an unavailable dependency ends the tunnel.
      void error
      finish('ws-revalidate-failed')
    } finally {
      revalidating = false
    }
  }
}
