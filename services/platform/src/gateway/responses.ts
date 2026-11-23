/**
 * Small HTTP response and request-body helpers for the platform gateway.
 *
 * Every platform-owned response carries `Cache-Control: no-store` and a
 * `nosniff` content-type hint; rendered pages additionally carry the strict
 * page Content-Security-Policy.
 *
 * @module @deepseek-ai/dsh-platform-services/gateway/responses
 */

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { PlatformHttpResult } from '../contracts.ts'
import { serializeCookies } from './cookies.ts'
import { PAGE_SECURITY_HEADERS } from './pages.ts'

/** Raised when a request body exceeds the configured buffered limit. */
export class BodyTooLargeError extends Error {
  /** @param limit - the configured limit in bytes. */
  constructor(limit: number) {
    super(`gateway: request body exceeds ${String(limit)} bytes`)
    this.name = 'BodyTooLargeError'
  }
}

/**
 * Read one request header as a single string.
 * @param headers - request headers.
 * @param name - lower-case header name.
 * @returns the first value, or undefined when absent or repeated ambiguously.
 */
export function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : value.length === 1 ? value[0] : undefined
}

/** Headers every platform JSON response sets. */
const JSON_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

/**
 * Send one JSON response.
 * @param response - response to write.
 * @param status - HTTP status code.
 * @param value - JSON-serializable body.
 */
export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, JSON_HEADERS)
  response.end(body)
}

/**
 * Send one stable error response: `{ "error": { "code": ... } }`.
 * @param response - response to write.
 * @param status - HTTP status code.
 * @param code - stable machine-readable error code.
 * @param details - additional safe fields; never include host, port, path, or upstream text.
 */
export function sendApiError(
  response: ServerResponse,
  status: number,
  code: string,
  details: Readonly<Record<string, string | number | boolean | null>> = {},
): void {
  sendJson(response, status, { error: { code, ...details } })
}

/**
 * Send one HTML page with the platform page security headers.
 * @param response - response to write.
 * @param status - HTTP status code.
 * @param html - complete HTML document.
 */
export function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, { ...PAGE_SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' })
  response.end(html)
}

/**
 * Send one plain-text protocol response, used for WebSocket refusals.
 * @param response - response to write.
 * @param status - HTTP status code.
 * @param text - short machine-stable body.
 */
export function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(text)
}

/**
 * Write the response an identity-service `handle` result describes.
 * @param response - browser response to write.
 * @param result - status, headers, cookies, and body the identity service returned.
 */
export function sendIdentityResult(response: ServerResponse, result: PlatformHttpResult): void {
  const headers: Record<string, string | string[]> = { ...result.headers }
  const cookies = serializeCookies(result.cookies)
  if (cookies.length > 0) headers['set-cookie'] = cookies
  if (headers['content-type'] === undefined && result.body !== undefined) {
    headers['content-type'] = 'text/plain; charset=utf-8'
  }
  if (headers['cache-control'] === undefined) headers['cache-control'] = 'no-store'
  response.writeHead(result.status, headers)
  response.end(result.body ?? '')
}

/**
 * Buffer a small request body for the platform JSON surfaces.
 *
 * The body is read with a hard byte cap so a public request cannot exhaust
 * memory; larger bodies are refused instead of truncated.
 * @param request - incoming request.
 * @param limitBytes - configured maximum buffered body size.
 * @returns the UTF-8 body text, or undefined when the request carried no body.
 * @throws {BodyTooLargeError} when the body or its declared length exceeds the limit.
 */
export async function readRequestBody(request: IncomingMessage, limitBytes: number): Promise<string | undefined> {
  const declared = headerValue(request.headers, 'content-length')
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > limitBytes) {
    throw new BodyTooLargeError(limitBytes)
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    total += buffer.byteLength
    if (total > limitBytes) throw new BodyTooLargeError(limitBytes)
    chunks.push(buffer)
  }
  if (total === 0) return undefined
  return Buffer.concat(chunks).toString('utf8')
}
