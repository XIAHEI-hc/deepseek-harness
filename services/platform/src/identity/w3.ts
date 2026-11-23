/**
 * W3 authorization-code client.
 *
 * The request shapes mirror the established W3 contract: the authorize URL keeps
 * its preconfigured query parameters before the platform parameters override
 * them, the token exchange posts either JSON or a form body, and the user-info
 * lookup always posts JSON. Every upstream failure becomes one stable
 * `w3-unavailable` error so a response body, access token, or client secret can
 * never reach a browser or a log line.
 *
 * @module @deepseek-ai/dsh-platform-services/identity/w3
 */

import type { W3Config } from '../config.ts'
import { IdentityError } from './errors.ts'

/** Longest W3 token or user-info request the platform waits for. */
const W3_REQUEST_TIMEOUT_MS = 10_000

/** Identity facts read from a W3 user-info response. */
export interface W3Profile {
  /** Stable subject (`uuid`, falling back to `sub`), already trimmed. */
  readonly subject: string
  /** W3 account identifier, already trimmed. */
  readonly uid: string
  /** Display name, falling back through `name` to the uid. */
  readonly displayName: string
  /** Email address, or an empty string when W3 returned none. */
  readonly email: string
}

/** Dependencies accepted by {@link exchangeW3Profile}. */
export interface W3ExchangeOptions {
  /** Fetch implementation; tests inject one, production uses the global fetch. */
  readonly fetch?: typeof fetch | undefined
}

/** Token exchange request body in W3 field order. */
interface TokenRequestBody {
  readonly client_id: string
  readonly client_secret: string
  readonly redirect_uri: string
  readonly grant_type: string
  readonly code: string
}

/**
 * Build the W3 authorization URL for one login transaction.
 *
 * Query parameters already present on the configured authorize URL are preserved
 * and then overridden by the platform parameters, matching the reference
 * implementation's parse-then-update behavior.
 * @param config - W3 provider configuration.
 * @param state - raw OAuth state parameter.
 * @returns the absolute authorization URL to redirect the browser to.
 */
export function authorizeUrl(config: W3Config, state: string): string {
  const target = new URL(config.authorizeUrl)
  const merged = new URLSearchParams()
  const existing = new Map<string, string>()
  for (const [name, value] of target.searchParams.entries()) existing.set(name, value)
  for (const name of existing.keys()) merged.set(name, existing.get(name) ?? '')
  merged.set('client_id', config.clientId)
  merged.set('response_type', 'code')
  merged.set('redirect_uri', config.redirectUri)
  merged.set('scope', config.scope)
  merged.set('state', state)
  target.search = merged.toString()
  return target.toString()
}

/**
 * Exchange one authorization code for a profile.
 *
 * A token response without a usable `access_token` never triggers the user-info
 * request. Missing subject or uid is rejected as `identity-incomplete`; network
 * failures, non-2xx responses, non-JSON bodies, and malformed payloads become one
 * `w3-unavailable` error without the upstream text.
 * @param config - W3 provider configuration.
 * @param code - authorization code from the callback.
 * @param options - fetch override; production uses the global fetch.
 * @returns the profile facts to synchronize.
 * @throws {IdentityError} `w3-unavailable` or `identity-incomplete`.
 */
export async function exchangeW3Profile(
  config: W3Config,
  code: string,
  options: W3ExchangeOptions = {},
): Promise<W3Profile> {
  const doFetch = options.fetch ?? globalThis.fetch
  const tokenBody: TokenRequestBody = {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
    code,
  }
  const tokenHeaders =
    config.tokenRequestFormat === 'form'
      ? { 'content-type': 'application/x-www-form-urlencoded' }
      : { 'content-type': 'application/json' }
  const tokenText =
    config.tokenRequestFormat === 'form'
      ? new URLSearchParams([
          ['client_id', tokenBody.client_id],
          ['client_secret', tokenBody.client_secret],
          ['redirect_uri', tokenBody.redirect_uri],
          ['grant_type', tokenBody.grant_type],
          ['code', tokenBody.code],
        ]).toString()
      : JSON.stringify(tokenBody)
  const tokenPayload = await postAndReadJson(doFetch, config.tokenUrl, tokenHeaders, tokenText)
  const accessToken = readAccessToken(tokenPayload)
  const userinfoBody = JSON.stringify({
    client_id: config.clientId,
    access_token: accessToken,
    scope: config.scope,
  })
  const profilePayload = await postAndReadJson(
    doFetch,
    config.userinfoUrl,
    { 'content-type': 'application/json' },
    userinfoBody,
  )
  const profile = asRecord(profilePayload)
  if (profile === undefined) {
    throw new IdentityError('w3-unavailable', 502, 'W3 identity provider returned an invalid profile')
  }
  const subject = (scalarText(profile['uuid']) || scalarText(profile['sub'])).trim()
  const uid = scalarText(profile['uid']).trim()
  if (subject === '' || uid === '') {
    throw new IdentityError('identity-incomplete', 400, 'W3 profile is missing uuid/sub or uid')
  }
  return {
    subject,
    uid,
    displayName: scalarText(profile['displayName']) || scalarText(profile['name']) || uid,
    email: scalarText(profile['email']),
  }
}

/**
 * POST one request and decode its JSON body.
 * @param doFetch - fetch implementation.
 * @param url - endpoint URL.
 * @param headers - request headers.
 * @param body - already-serialized request body.
 * @returns the decoded JSON payload.
 * @throws {IdentityError} `w3-unavailable` on any transport or decoding failure.
 */
async function postAndReadJson(
  doFetch: typeof fetch,
  url: string,
  headers: Readonly<Record<string, string>>,
  body: string,
): Promise<unknown> {
  let response: Response
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(W3_REQUEST_TIMEOUT_MS),
    })
  } catch {
    // Transport errors, timeouts, and aborts all map to the single stable code;
    // the cause could carry a URL or provider text and never leaves this module.
    throw new IdentityError('w3-unavailable', 502, 'W3 identity provider request failed')
  }
  if (!response.ok) {
    throw new IdentityError('w3-unavailable', 502, 'W3 identity provider request failed')
  }
  try {
    return await response.json()
  } catch {
    // An unparseable body is the same stable failure as an unavailable provider.
    throw new IdentityError('w3-unavailable', 502, 'W3 identity provider returned an unusable response')
  }
}

/**
 * Read the access token out of a token response.
 * @param payload - decoded token response.
 * @returns the non-empty access token.
 * @throws {IdentityError} `w3-unavailable` when the token response is unusable.
 */
function readAccessToken(payload: unknown): string {
  const record = asRecord(payload)
  const token = record === undefined ? undefined : record['access_token']
  if (typeof token !== 'string' || token === '') {
    throw new IdentityError('w3-unavailable', 502, 'W3 identity provider returned an invalid token response')
  }
  return token
}

/**
 * Narrow one JSON value to a plain object.
 * @param value - decoded JSON value.
 * @returns the object as a string-keyed record, or undefined for arrays and primitives.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * Convert one profile field to text without trimming.
 * @param value - raw profile field.
 * @returns the string value, a numeric value rendered as text, or an empty string.
 */
function scalarText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return ''
}
