/**
 * Cookie parsing and serialization for the public gateway.
 *
 * The gateway is the transport owner: the identity service receives already
 * parsed cookies and returns cookie descriptors, so this module is the only
 * place cookie syntax is read or written.
 *
 * @module @deepseek-ai/dsh-platform-services/gateway/cookies
 */

import type { SetCookie } from '../contracts.ts'

/**
 * Decode one cookie value, falling back to the raw text when it is not
 * valid percent-encoding (a malformed cookie must never throw into routing).
 * @param raw - encoded cookie value.
 * @returns the decoded value, or the raw text.
 */
function decodeCookieValue(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch (error) {
    // Cookie syntax is attacker-controlled; an undecodable value stays opaque.
    void error
    return raw
  }
}

/**
 * Parse one `Cookie` request header.
 *
 * Repeated names keep the first occurrence: the browser emits the narrowest
 * `Path` first, and later duplicates are shadowing attempts rather than
 * credentials.
 * @param header - raw `Cookie` header value, or undefined when absent.
 * @returns cookie name to decoded value.
 */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  if (header === undefined || header === '') return cookies
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    const name = part.slice(0, separator).trim()
    if (name === '' || Object.hasOwn(cookies, name)) continue
    cookies[name] = decodeCookieValue(part.slice(separator + 1).trim())
  }
  return cookies
}

/**
 * Serialize one platform cookie descriptor.
 * @param cookie - name, value, and attributes the identity service chose.
 * @returns the `Set-Cookie` header value.
 */
export function serializeCookie(cookie: SetCookie): string {
  const attributes = [`${cookie.name}=${cookie.value}`]
  attributes.push(`Path=${cookie.path ?? '/'}`)
  if (cookie.maxAgeSeconds !== undefined) attributes.push(`Max-Age=${String(cookie.maxAgeSeconds)}`)
  if (cookie.httpOnly === true) attributes.push('HttpOnly')
  if (cookie.secure === true) attributes.push('Secure')
  if (cookie.sameSite !== undefined) attributes.push(`SameSite=${cookie.sameSite}`)
  return attributes.join('; ')
}

/**
 * Serialize every cookie the identity service returned.
 * @param cookies - cookie descriptors, or undefined when the response sets none.
 * @returns `Set-Cookie` header values, empty when none were set.
 */
export function serializeCookies(cookies: readonly SetCookie[] | undefined): string[] {
  return cookies === undefined ? [] : cookies.map(serializeCookie)
}
