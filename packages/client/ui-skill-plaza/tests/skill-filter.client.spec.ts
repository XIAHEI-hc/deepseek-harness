import { describe, expect, it } from 'vitest'
import type { PlazaSkillEntry } from '@deepseek-ai/dsh-skill-plaza/types'
import { filterSkills } from '../src/client/skill-filter.ts'

const entry = (over: Partial<PlazaSkillEntry>): PlazaSkillEntry => ({
  skillId: 'skill',
  slug: 'skill',
  title: 'Skill',
  description: 'Purpose of the skill.',
  version: 1,
  updatedAt: '2026-11-16T00:00:00.000Z',
  ...over,
})

const ENTRIES: readonly PlazaSkillEntry[] = [
  entry({ skillId: 's1', slug: 'release-metrics-compare', title: '发布记录指标对比', description: '比较两次发布记录的指标' }),
  entry({ skillId: 's2', slug: 'commit-helper', title: 'Commit helper', description: 'Writes a conventional commit message' }),
  entry({ skillId: 's3', slug: 'deploy-check', title: 'Deploy check', description: 'Verifies a release before deployment' }),
]

describe('filterSkills', () => {
  it('returns the list unchanged for a blank query', () => {
    expect(filterSkills(ENTRIES, '')).toEqual(ENTRIES)
    expect(filterSkills(ENTRIES, '   ')).toEqual(ENTRIES)
  })

  it('matches a kebab-case name from a word start', () => {
    expect(filterSkills(ENTRIES, 'rc').map(item => item.skillId)).toEqual(['s1'])
    expect(filterSkills(ENTRIES, 'deploy').map(item => item.skillId)).toEqual(['s3'])
  })

  it('matches a localized title', () => {
    expect(filterSkills(ENTRIES, '发布').map(item => item.skillId)).toEqual(['s1'])
  })

  it('matches a description as a contiguous substring', () => {
    expect(filterSkills(ENTRIES, 'conventional').map(item => item.skillId)).toEqual(['s2'])
  })

  it('returns nothing when no entry matches', () => {
    expect(filterSkills(ENTRIES, 'zzzz')).toEqual([])
  })

  it('keeps list order among equally ranked matches', () => {
    const matched = filterSkills(ENTRIES, 'e')
    expect(matched.map(item => item.skillId)).toEqual(['s1', 's2', 's3'])
  })
})
