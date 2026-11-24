/**
 * Stable gateway logging.
 *
 * The gateway never logs cookies, bearer tokens, private keys, assertions, or
 * upstream error text. Events carry a stable machine code and, for
 * user-scoped events, a one-way hash of the internal user id, so operators can
 * correlate activity without learning who the user is.
 *
 * @module @deepseek-ai/dsh-platform-services/gateway/log
 */

import { createHash } from 'node:crypto'

/** One stable log event. */
export interface GatewayLogEvent {
  /** Stable machine code, for example `session-invalid`. */
  readonly code: string
  /** Truncated SHA-256 of the internal user id; absent for deployment-scoped events. */
  readonly userIdHash?: string | undefined
}

/** Receives gateway log events; the default sink discards them. */
export type GatewayLogger = (event: GatewayLogEvent) => void

/** Default logger for deployments that do not install one. */
export const noopGatewayLogger: GatewayLogger = () => {}

/**
 * Hash an internal user id for logging.
 * @param userId - internal user id.
 * @returns the first twelve hex characters of its SHA-256 digest.
 */
export function hashUserId(userId: string): string {
  return createHash('sha256').update(userId, 'utf8').digest('hex').slice(0, 12)
}
