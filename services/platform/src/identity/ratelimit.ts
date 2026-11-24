/**
 * In-memory login-attempt rate limiter.
 *
 * The platform gateway is the only public listener, so a per-process sliding
 * window over the transport-observed client address is enough to stop one
 * address from enumerating login starts. Multi-replica deployments must enforce
 * the same budget at the shared reverse proxy; the audit stream records every
 * throttled attempt so operators can see it.
 *
 * @module @deepseek-ai/dsh-platform-services/identity/ratelimit
 */

/** Sliding-window login limiter scoped to one identity process. */
export class LoginRateLimiter {
  /** Admitted attempt timestamps per address, oldest first. */
  private readonly attempts = new Map<string, number[]>()
  private readonly windowMs: number
  private readonly maxAttempts: number
  private readonly now: () => number

  /**
   * @param config - window length and attempt budget; a zero budget disables limiting.
   * @param now - clock shared with the identity service.
   */
  constructor(config: { windowMs: number; maxAttemptsPerAddress: number }, now: () => number) {
    this.windowMs = Math.max(config.windowMs, 1)
    this.maxAttempts = Math.max(config.maxAttemptsPerAddress, 0)
    this.now = now
  }

  /**
   * Admit or refuse one login attempt.
   * @param address - transport-observed client address.
   * @returns true when the attempt is admitted, false when the window is full.
   */
  allow(address: string): boolean {
    if (this.maxAttempts === 0) return true
    const now = this.now()
    const attempts = this.prune(address, now)
    if (attempts.length >= this.maxAttempts) return false
    attempts.push(now)
    this.attempts.set(address, attempts)
    return true
  }

  /**
   * Seconds until one address may retry.
   * @param address - transport-observed client address.
   * @returns whole seconds until the oldest admitted attempt leaves the window.
   */
  retryAfterSeconds(address: string): number {
    const now = this.now()
    const attempts = this.prune(address, now)
    if (attempts.length === 0) return 0
    const oldest = attempts[0] ?? now
    return Math.max(Math.ceil((oldest + this.windowMs - now) / 1000), 1)
  }

  /**
   * Drop attempts older than the window.
   * @param address - client address.
   * @param now - current time.
   * @returns the retained attempt timestamps.
   */
  private prune(address: string, now: number): number[] {
    const cutoff = now - this.windowMs
    const attempts = (this.attempts.get(address) ?? []).filter(timestamp => timestamp > cutoff)
    if (attempts.length === 0) this.attempts.delete(address)
    else this.attempts.set(address, attempts)
    return attempts
  }
}
