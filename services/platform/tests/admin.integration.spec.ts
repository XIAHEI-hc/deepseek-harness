/** Fusion admin status: disabled, ready, and metadata counts. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPlatformConfig } from '../src/config.ts'
import { readIntegrationJobs, readIntegrationStatus } from '../src/admin/integration.ts'
import { mockSystemsDocument } from './integration.testkit.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('readIntegrationStatus', () => {
  it('reports disabled without touching the filesystem', async () => {
    const config = createPlatformConfig()
    const report = await readIntegrationStatus(config)
    expect(report).toMatchObject({ enabled: false, state: 'disabled', systems: 0, counts: null })
  })

  it('reports ready and zero counts for an empty fusion database', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-admin-integration-'))
    roots.push(root)
    const systemsFile = join(root, 'systems.json')
    writeFileSync(systemsFile, JSON.stringify(mockSystemsDocument()), 'utf8')
    const config = createPlatformConfig({
      dataDir: join(root, 'data'),
      integration: {
        enabled: true,
        systemsFile,
        runnerKind: 'container',
        jobImage: 'dsh-analysis-test:local',
        jobNetwork: 'none',
      },
    })
    const report = await readIntegrationStatus(config, {
      probeDocker: async () => true,
      allowUnsupportedHost: true,
    })
    expect(report.state).toBe('ready')
    expect(report.systems).toBe(1)
    expect(report.counts).toEqual({ workspaces: 0, snapshots: 0, jobs: 0, artifacts: 0, activeJobs: 0 })
    expect(readIntegrationJobs(config, 100)).toEqual([])
  })

  it('returns no jobs when fusion is disabled', () => {
    expect(readIntegrationJobs(createPlatformConfig(), 100)).toEqual([])
  })
})
