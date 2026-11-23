/**
 * Streaming HTTP reverse proxy from the public gateway to one user runtime.
 *
 * The proxy preserves the method, path, query, request body, response status,
 * headers, and response body, so streaming responses (SSE, chunked transfers,
 * large downloads) keep their native behavior. Before forwarding it removes
 * every credential and internal-identity header the browser may have attached,
 * then adds the gateway's own assertion; on the way back it removes hop-by-hop
 * headers, `Set-Cookie`, and internal `x-dsh-*` headers.
 *
 * @module @deepseek-ai/dsh-platform-services/gateway/proxy
 */

import { randomUUID } from 'node:crypto'
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { RuntimeTarget } from '../contracts.ts'
import { GATEWAY_ASSERTION_HEADER } from './signer.ts'
import { sendApiError } from './responses.ts'

/** Request headers a browser may attach that the runtime must never receive. */
const UNTRUSTED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'cookie',
  'authorization',
  'proxy-authorization',
  'x-real-ip',
  'forwarded',
  'x-csrf-token',
  'te',
  'trailer',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'expect',
])

/** Request header name prefixes the runtime must never receive. */
const UNTRUSTED_REQUEST_PREFIXES: readonly string[] = [
  'x-dsh-',
  'x-user-',
  'x-auth-',
  'x-workbench-',
  'x-forwarded-',
  'proxy-',
]

/** Response headers that describe only the upstream connection. */
const HOP_BY_HOP_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'set-cookie',
])

/** Response header prefixes that never reach the browser. */
const INTERNAL_RESPONSE_PREFIXES: readonly string[] = ['x-dsh-']

/** Longest idle time one proxied exchange may sit without upstream progress, in milliseconds. */
export const PROXY_IDLE_TIMEOUT_MS = 120_000

/** Deployment facts every forwarded request is stamped with. */
export interface ProxyFacts {
  /** Private loopback location of the target runtime; never serialized to the browser. */
  readonly target: RuntimeTarget
  /** Public host authority the runtime accepts through its Host fence. */
  readonly publicAuthority: string
  /** Public origin protocol, stamped as `x-forwarded-proto`. */
  readonly publicProtocol: 'http:' | 'https:'
  /** Fresh version 2 assertion signed for this request. */
  readonly assertion: string
}

/**
 * Report whether a request header is stripped before forwarding.
 * @param name - header name in any casing.
 * @returns true when the header must not reach the runtime.
 */
export function isUntrustedRequestHeader(name: string): boolean {
  const lower = name.toLowerCase()
  if (UNTRUSTED_REQUEST_HEADERS.has(lower)) return true
  return UNTRUSTED_REQUEST_PREFIXES.some(prefix => lower.startsWith(prefix))
}

/**
 * Build the headers one forwarded request (or upgrade) carries.
 *
 * Browser credentials and internal identity headers are dropped; the gateway
 * then stamps the public authority, a fresh assertion, the client protocol,
 * and a new request id.
 * @param source - incoming request headers.
 * @param facts - deployment and target facts.
 * @param extra - additional trusted protocol headers, such as WebSocket upgrade fields.
 * @returns headers for the outgoing request.
 */
export function buildForwardHeaders(
  source: IncomingHttpHeaders,
  facts: ProxyFacts,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || isUntrustedRequestHeader(name)) continue
    headers[name] = value
  }
  headers.host = facts.publicAuthority
  headers[GATEWAY_ASSERTION_HEADER] = facts.assertion
  headers['x-forwarded-proto'] = facts.publicProtocol === 'https:' ? 'https' : 'http'
  headers['x-request-id'] = randomUUID()
  for (const [name, value] of Object.entries(extra)) headers[name] = value
  return headers
}

/**
 * Remove hop-by-hop, `Set-Cookie`, and internal headers from an upstream response.
 * @param source - response headers the runtime produced.
 * @returns headers safe to return to the browser.
 */
export function filterResponseHeaders(source: IncomingHttpHeaders): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (HOP_BY_HOP_RESPONSE_HEADERS.has(lower)) continue
    if (INTERNAL_RESPONSE_PREFIXES.some(prefix => lower.startsWith(prefix))) continue
    headers[name] = value
  }
  return headers
}

/**
 * Proxy one HTTP request to the user's runtime and stream the response back.
 *
 * The request body is piped without buffering. Upstream failures answer with a
 * stable error code only after headers have not been sent; a failure after the
 * response started destroys the connection instead of appending error text to
 * a partial body.
 * @param source - incoming browser request.
 * @param response - browser response that receives the proxied bytes.
 * @param facts - target runtime and deployment facts.
 */
export function proxyHttpRequest(source: IncomingMessage, response: ServerResponse, facts: ProxyFacts): void {
  const upstream = httpRequest({
    host: facts.target.host,
    port: facts.target.port,
    method: source.method ?? 'GET',
    path: source.url ?? '/',
    headers: buildForwardHeaders(source.headers, facts),
  })
  let answered = false
  const failUpstream = (): void => {
    if (answered || response.headersSent) {
      response.destroy()
      return
    }
    answered = true
    sendApiError(response, 502, 'runtime-unavailable')
  }
  upstream.setTimeout(PROXY_IDLE_TIMEOUT_MS, () => {
    upstream.destroy(new Error('gateway: runtime request timed out'))
  })
  upstream.on('response', (upstreamResponse) => {
    answered = true
    response.writeHead(upstreamResponse.statusCode ?? 502, filterResponseHeaders(upstreamResponse.headers))
    response.flushHeaders()
    upstreamResponse.on('error', () => {
      response.destroy()
    })
    response.on('close', () => {
      // The browser went away mid-download; stop pulling from the runtime.
      if (!response.writableEnded) upstreamResponse.destroy()
    })
    upstreamResponse.pipe(response)
  })
  upstream.on('error', () => {
    failUpstream()
  })
  source.on('close', () => {
    // A client that aborted before finishing its body cancels the upstream write.
    if (!source.complete) upstream.destroy()
  })
  source.on('error', () => {
    upstream.destroy()
  })
  source.pipe(upstream)
}
