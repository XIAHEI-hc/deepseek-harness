/**
 * Identity failure values shared by the SQLite store, the security helpers, and
 * the W3 client.
 *
 * Every failure carries the stable machine code the HTTP surface and the gateway
 * consume. Messages are developer-facing and never contain tokens, cookies, or
 * upstream provider text.
 *
 * @module @deepseek-ai/dsh-platform-services/identity/errors
 */

import type { IdentityFailureCode } from '../contracts.ts'

/** One identity failure with a stable code and the HTTP status it maps to. */
export class IdentityError extends Error {
  /** Stable machine code shared with the HTTP surface. */
  readonly code: IdentityFailureCode
  /** HTTP status this failure maps to when surfaced directly. */
  readonly status: number

  /**
   * @param code - stable failure code.
   * @param status - HTTP status the failure maps to.
   * @param message - developer-facing description without secrets.
   */
  constructor(code: IdentityFailureCode, status: number, message: string) {
    super(message)
    this.name = 'IdentityError'
    this.code = code
    this.status = status
  }
}
