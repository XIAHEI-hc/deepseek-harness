/**
 * Typed failures for the per-user runtime supervisor.
 *
 * The gateway and the browser only ever see the stable {@link RuntimeErrorCode}
 * value; messages stay actionable for operators and never contain host paths,
 * ports, or provider text.
 *
 * @module @deepseek-ai/dsh-platform-services/runtime/errors
 */

/** Stable machine codes the runtime manager reports and persists. */
export type RuntimeErrorCode =
  /** The caller passed a user id that is not a safe opaque identifier. */
  | 'RUNTIME_INVALID_USER'
  /** A resolved runtime path would leave the configured space root. */
  | 'RUNTIME_PATH_ESCAPE'
  /** The supervisor configuration cannot launch a runtime. */
  | 'RUNTIME_CONFIG_INVALID'
  /** The process or container backend failed for a reason it could not classify. */
  | 'RUNTIME_BACKEND_ERROR'
  /** The runtime did not answer its readiness probe within `startTimeoutMs`. */
  | 'RUNTIME_START_TIMEOUT'
  /** The runtime exited before or after reaching READY. */
  | 'RUNTIME_EXITED'
  /** A previous instance of the same user is still running; starting would duplicate it. */
  | 'RUNTIME_INSTANCE_CONFLICT'
  /** The manager was closed and refuses further lifecycle work. */
  | 'RUNTIME_MANAGER_CLOSED'

/** Codes a runtime backend raises while starting, stopping, or inspecting one instance. */
export type RuntimeBackendErrorCode = 'RUNTIME_BACKEND_ERROR' | 'RUNTIME_START_TIMEOUT' | 'RUNTIME_EXITED'

/** A refusal raised by the runtime manager itself. */
export class RuntimeManagerError extends Error {
  /** Stable machine code; safe to persist and compare. */
  readonly code: RuntimeErrorCode

  /**
   * @param code - stable machine code.
   * @param message - operator-actionable description without sensitive values.
   */
  constructor(code: RuntimeErrorCode, message: string) {
    super(message)
    this.name = 'RuntimeManagerError'
    this.code = code
  }
}

/** A failure raised by a runtime backend for one instance. */
export class RuntimeBackendError extends Error {
  /** Stable machine code the manager persists as `last_error_code`. */
  readonly code: RuntimeBackendErrorCode

  /**
   * @param code - stable machine code.
   * @param message - operator-actionable description without sensitive values.
   * @param cause - underlying failure, kept for local diagnostics only.
   */
  constructor(code: RuntimeBackendErrorCode, message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'RuntimeBackendError'
    this.code = code
  }
}

/**
 * Classify an unknown thrown value into one stable runtime error code.
 * @param error - value thrown by a backend or by an internal step.
 * @returns the manager or backend code, or `RUNTIME_BACKEND_ERROR` when unclassified.
 */
export function runtimeErrorCode(error: unknown): RuntimeErrorCode {
  if (error instanceof RuntimeManagerError) return error.code
  if (error instanceof RuntimeBackendError) return error.code
  return 'RUNTIME_BACKEND_ERROR'
}
