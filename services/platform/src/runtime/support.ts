/**
 * Process, probe, and logging helpers shared by the runtime backends.
 *
 * @module @deepseek-ai/dsh-platform-services/runtime/support
 */

import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { createServer } from 'node:net'

/** Cap on the retained child-process output tail, in bytes. */
export const DIAGNOSTIC_TAIL_BYTES = 8192

/** One structured supervisor log line; it never carries paths, ports, or secrets. */
export interface RuntimeLogEntry {
  /** Stable event name, such as `runtime.start` or `runtime.reaped`. */
  readonly event: string
  /** Truncated hash of `realm:userId`, safe to correlate without naming a user. */
  readonly userRef: string
  /** Stable machine code associated with the event, when one exists. */
  readonly code?: string | undefined
  /** Generation the event belongs to, when one exists. */
  readonly generation?: number | undefined
}

/** Sink for structured supervisor log lines. */
export type RuntimeLog = (entry: RuntimeLogEntry) => void

/**
 * Hash one user reference for logs.
 * @param realm - deployment realm.
 * @param userId - internal user id.
 * @returns the first twelve hex characters of `SHA256(realm:userId)`.
 */
export function hashUserRef(realm: string, userId: string): string {
  return createHash('sha256').update(`${realm}:${userId}`).digest('hex').slice(0, 12)
}

/** Write one JSON log line to stderr; stdout stays free for the application entrypoint. */
export const stderrRuntimeLog: RuntimeLog = entry => {
  process.stderr.write(`${JSON.stringify(entry)}\n`)
}

/**
 * Allocate a currently free TCP port on a concrete bind address.
 * @param host - interface address to bind while probing.
 * @returns the port that was free when the probe listener closed.
 */
export function findFreePort(host: string): Promise<number> {
  return new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer()
    server.unref()
    server.once('error', error => {
      rejectPort(error)
    })
    server.listen({ host, port: 0 }, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        rejectPort(new Error('could not read the ephemeral port'))
        return
      }
      const port = address.port
      server.close(error => {
        if (error) rejectPort(error)
        else resolvePort(port)
      })
    })
  })
}

/**
 * Ask one runtime root whether it answers HTTP.
 * @param url - probe URL, normally the runtime root.
 * @param timeoutMs - longest accepted wait for the response.
 * @returns true when the runtime answered with a non-server-error status.
 */
export function probeHttp(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>(resolveProbe => {
    const pending = request(url, { method: 'GET', timeout: timeoutMs }, response => {
      const status = response.statusCode ?? 500
      response.resume()
      resolveProbe(status < 500)
    })
    pending.once('timeout', () => {
      pending.destroy()
      resolveProbe(false)
    })
    pending.once('error', () => {
      resolveProbe(false)
    })
    pending.end()
  })
}

/**
 * Wait for one promise to settle, or give up after a timeout.
 * @param promise - promise that settles when the underlying event happens.
 * @param timeoutMs - longest accepted wait.
 * @returns true when the promise settled in time, false on timeout.
 */
export async function waitForSettlement(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<boolean>(resolveTimeout => {
    timer = setTimeout(() => {
      resolveTimeout(false)
    }, timeoutMs)
    timer.unref()
  })
  const settled = promise.then(() => true, () => true)
  const result = await Promise.race([settled, timeout])
  if (timer !== undefined) clearTimeout(timer)
  return result
}

/**
 * Sleep for a duration without keeping the process alive.
 * @param durationMs - duration to wait.
 */
export function sleep(durationMs: number): Promise<void> {
  return new Promise<void>(resolveSleep => {
    const timer = setTimeout(resolveSleep, durationMs)
    timer.unref()
  })
}

/** Bounded tail of child-process output kept for local diagnostics. */
export class BoundedTail {
  private readonly limitBytes: number
  private buffer = Buffer.alloc(0)

  /** @param limitBytes - most bytes retained; older bytes are discarded. */
  constructor(limitBytes: number = DIAGNOSTIC_TAIL_BYTES) {
    this.limitBytes = limitBytes
  }

  /**
   * Append one output chunk, discarding the oldest bytes past the limit.
   * @param chunk - output bytes or text.
   */
  append(chunk: Buffer | string): void {
    const next = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    const combined = Buffer.concat([this.buffer, next])
    this.buffer = combined.length > this.limitBytes ? combined.subarray(combined.length - this.limitBytes) : combined
  }

  /** @returns the retained output decoded as UTF-8. */
  read(): string {
    return this.buffer.toString('utf8')
  }

  /** @returns the number of retained bytes. */
  get length(): number {
    return this.buffer.length
  }
}

/** Patterns whose values must never reach an operator-visible diagnostic line. */
const SECRET_ASSIGNMENT_PATTERN = /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE)[A-Z0-9_]*)\s*[=:]\s*\S+/gi

/**
 * Remove credential-looking values from captured child output.
 * @param text - captured output tail.
 * @returns the same text with assignment values replaced by a redaction marker.
 */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_ASSIGNMENT_PATTERN, '$1=[redacted]')
}

/**
 * Read one stable `code` property from an unknown thrown value.
 * @param error - thrown value.
 * @returns the code when it is a string, otherwise undefined.
 */
export function readErrorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const value: unknown = error.code
    return typeof value === 'string' ? value : undefined
  }
  return undefined
}

/**
 * Read one numeric `code` property from an unknown thrown value.
 * @param error - thrown value.
 * @returns the numeric code when present, otherwise undefined.
 */
export function readNumericErrorCode(error: unknown): number | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const value: unknown = error.code
    return typeof value === 'number' ? value : undefined
  }
  return undefined
}
