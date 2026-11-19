/**
 * Bounded memory of assertion ids accepted within a replay window.
 *
 * One instance belongs to one plugin instance, so a reload starts with an empty window and
 * no state outlives the scope that enforces it.
 */

/**
 * Remember accepted assertion ids for a fixed number of seconds.
 *
 * Every entry shares one window, so insertion order is expiry order and a sweep stops at
 * the first live entry. Memory therefore stays proportional to the accepted assertion rate
 * times the window instead of the lifetime of the process.
 */
export class ReplayWindow {
  readonly #windowMs: number
  readonly #expiresAt = new Map<string, number>()

  /**
   * @param windowSeconds - seconds an accepted assertion id stays remembered; zero remembers nothing.
   */
  constructor(windowSeconds: number) {
    this.#windowMs = windowSeconds * 1000
  }

  /**
   * Report whether an assertion id is still remembered.
   * @param assertionId - the assertion's `jti` claim.
   * @param nowMs - current time in milliseconds.
   * @returns true when the id was remembered inside the current window.
   */
  has(assertionId: string, nowMs: number): boolean {
    this.#sweep(nowMs)
    return this.#expiresAt.has(assertionId)
  }

  /**
   * Remember an accepted assertion id until its window ends.
   * @param assertionId - the assertion's `jti` claim.
   * @param nowMs - current time in milliseconds.
   */
  remember(assertionId: string, nowMs: number): void {
    this.#sweep(nowMs)
    this.#expiresAt.set(assertionId, nowMs + this.#windowMs)
  }

  /**
   * Drop entries whose window ended, stopping at the first entry that has not expired.
   * @param nowMs - current time in milliseconds.
   */
  #sweep(nowMs: number): void {
    for (const [assertionId, expiresAt] of this.#expiresAt) {
      if (expiresAt > nowMs) return
      this.#expiresAt.delete(assertionId)
    }
  }
}
