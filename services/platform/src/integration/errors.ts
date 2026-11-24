/**
 * Stable failures raised by the system-fusion service.
 *
 * `code` is safe to return to the browser; `message` is for logs and local
 * diagnosis and must never contain a host path, token, or upstream body.
 *
 * @module @deepseek-ai/dsh-platform-services/integration/errors
 */

/** Machine-stable fusion failure codes. */
export type IntegrationErrorCode =
  | 'integration-disabled'
  | 'integration-blocked'
  | 'integration-not-found'
  | 'method-not-allowed'
  | 'invalid-request'
  | 'resource-forbidden'
  | 'resource-not-found'
  | 'snapshot-too-large'
  | 'snapshot-failed'
  | 'workspace-not-found'
  | 'workspace-invalid'
  | 'job-not-found'
  | 'job-limit'
  | 'job-failed'
  | 'job-cancelled'
  | 'artifact-not-found'
  | 'runner-unavailable'
  | 'storage-failed'
  | 'internal-error'

/** One fusion failure with its HTTP status and stable code. */
export class IntegrationError extends Error {
  readonly code: IntegrationErrorCode
  readonly status: number

  /**
   * @param code - stable failure code.
   * @param message - local diagnostic message; never browser-visible.
   * @param status - HTTP status to return.
   */
  constructor(code: IntegrationErrorCode, message: string, status = 400) {
    super(message)
    this.name = 'IntegrationError'
    this.code = code
    this.status = status
  }
}

/**
 * Classify an unexpected error as an internal failure without exposing its text.
 * @param error - thrown value.
 * @returns the stable code and browser status to return.
 */
export function classifyIntegrationError(error: unknown): { code: IntegrationErrorCode; status: number } {
  if (error instanceof IntegrationError) return { code: error.code, status: error.status }
  return { code: 'internal-error', status: 500 }
}
