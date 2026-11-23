/**
 * Minimal allowlisted HTTP/HTTPS egress proxy for fusion analysis jobs.
 *
 * The container joins an internal Docker network with no external route; this
 * proxy is the only member with an egress network. It accepts only exact
 * `host:port` entries from DSH_FUSION_EGRESS_ALLOWLIST, refuses redirect
 * following by never following one, and keeps cloud metadata endpoints out of
 * the allowlist even when an operator adds them by mistake.
 */

import http from 'node:http'
import net from 'node:net'

const PORT = Number(process.env.PORT ?? '3128')
const ALLOWLIST = new Set(
  (process.env.DSH_FUSION_EGRESS_ALLOWLIST ?? '')
    .split(/[\n,]+/u)
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => entry !== ''),
)
const FORBIDDEN = new Set(['169.254.169.254', 'metadata.google.internal', 'metadata'])

/**
 * Split one `host:port` authority.
 * @param {string} authority - request authority.
 * @returns {{host: string, port: number} | undefined} parsed target.
 */
function parseAuthority(authority) {
  const trimmed = authority.trim().toLowerCase()
  if (trimmed === '' || trimmed.includes('/') || trimmed.includes('@')) return undefined
  const bracket = /^\[([^\]]+)\]:(\d+)$/u.exec(trimmed)
  if (bracket !== null) {
    return { host: bracket[1], port: Number(bracket[2]) }
  }
  const separator = trimmed.lastIndexOf(':')
  if (separator <= 0) return undefined
  const host = trimmed.slice(0, separator)
  const port = Number(trimmed.slice(separator + 1))
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  if (host.includes(':') || host === '') return undefined
  return { host, port }
}

/**
 * Check one exact allowlist entry.
 * @param {{host: string, port: number}} target - destination.
 * @returns {boolean} whether the target is allowed.
 */
function allowed(target) {
  const host = target.host.toLowerCase()
  if (FORBIDDEN.has(host)) return false
  return ALLOWLIST.has(`${host}:${String(target.port)}`)
}

/**
 * Reject a request with one stable status.
 * @param {http.ServerResponse} response - response.
 * @param {number} status - HTTP status.
 * @param {string} text - short body.
 */
function reject(response, status, text) {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(text)
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('ok')
    return
  }
  if (request.url === undefined) {
    reject(response, 400, 'bad request')
    return
  }
  let targetUrl
  try {
    targetUrl = new URL(request.url)
  } catch {
    reject(response, 400, 'absolute URL required')
    return
  }
  if (targetUrl.protocol !== 'http:') {
    reject(response, 400, 'only http requests are proxied directly')
    return
  }
  const target = {
    host: targetUrl.hostname.toLowerCase(),
    port: Number(targetUrl.port === '' ? '80' : targetUrl.port),
  }
  if (!allowed(target)) {
    reject(response, 403, 'target is not allowlisted')
    return
  }
  const headers = { ...request.headers }
  delete headers['proxy-connection']
  delete headers['proxy-authorization']
  headers.host = targetUrl.host
  const upstream = http.request({
    host: target.host,
    port: target.port,
    path: `${targetUrl.pathname}${targetUrl.search}`,
    method: request.method,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
    upstreamResponse.pipe(response)
  })
  upstream.on('error', () => {
    reject(response, 502, 'upstream failed')
  })
  upstream.setTimeout(30_000, () => {
    upstream.destroy(new Error('upstream timeout'))
  })
  request.pipe(upstream)
})

server.on('connect', (request, clientSocket, head) => {
  const target = parseAuthority(request.url ?? '')
  if (target === undefined || !allowed(target)) {
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    return
  }
  const upstream = net.connect(target.port, target.host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length > 0) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })
  upstream.on('error', () => {
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })
  clientSocket.on('error', () => {
    upstream.destroy()
  })
})

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`fusion egress proxy listening on ${String(PORT)} with ${String(ALLOWLIST.size)} allowlist entry(ies)\n`)
})
