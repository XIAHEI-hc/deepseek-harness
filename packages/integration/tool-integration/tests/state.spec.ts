/** Persisted fusion-session markers survive a runtime restart. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadFusionSessions, saveFusionSessions } from '../src/index.ts'

describe('fusion-session state', () => {
  it('round-trips marked sessions and starts empty on a missing or malformed file', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-fusion-sessions-'))
    try {
      const file = join(root, 'state', 'fusion-sessions.json')
      expect(loadFusionSessions(file)).toEqual(new Set())
      saveFusionSessions(file, new Set(['s1', 's2']))
      expect(loadFusionSessions(file)).toEqual(new Set(['s1', 's2']))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps an empty state path in memory only', () => {
    expect(loadFusionSessions('')).toEqual(new Set())
    expect(() => { saveFusionSessions('', new Set(['s1'])) }).not.toThrow()
  })
})
