/** Runtime capability tokens: scope, expiry, tamper resistance, and session projection. */
import { describe, expect, it } from 'vitest'
import { mintRuntimeCapability, sessionFromCapability, verifyRuntimeCapability } from '../src/integration/capability.ts'

const SECRET = 's'.repeat(48)
const USER = { id: 'user-a', subject: 'w3-user-a', uid: 'uid-a', displayName: 'User A', email: null }
const NOW = Date.parse('2026-11-24T00:00:00.000Z')

describe('runtime capability', () => {
  it('mints and verifies a scoped token', () => {
    const token = mintRuntimeCapability(SECRET, USER, 3, NOW, 60_000)
    const claims = verifyRuntimeCapability(SECRET, token, NOW + 1_000)
    expect(claims).toMatchObject({ userId: 'user-a', permissionVersion: 3, expiresAt: NOW + 60_000 })
    const session = sessionFromCapability(claims!)
    expect(session.user.uid).toBe('uid-a')
    expect(session.sessionId).toBe('runtime:user-a')
  })

  it('refuses an expired, tampered, or foreign token', () => {
    const token = mintRuntimeCapability(SECRET, USER, 1, NOW, 60_000)
    expect(verifyRuntimeCapability(SECRET, token, NOW + 60_001)).toBeUndefined()
    expect(verifyRuntimeCapability(SECRET, `${token}x`, NOW)).toBeUndefined()
    expect(verifyRuntimeCapability('x'.repeat(48), token, NOW)).toBeUndefined()
  })

  it('refuses a weak secret at mint time', () => {
    expect(() => mintRuntimeCapability('short', USER, 1, NOW)).toThrow(/at least 32/u)
  })
})
