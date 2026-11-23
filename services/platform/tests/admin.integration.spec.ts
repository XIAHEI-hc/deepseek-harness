/** Fusion admin status: disabled, ready, and metadata counts. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPlatformConfig } from '../src/config.ts'
import { cancelIntegrationJob, readIntegrationJobs, readIntegrationStatus } from '../src/admin/integration.ts'
import { IntegrationStore } from '../src/integration/store.ts'
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

  it('cancels one running container and marks the job cancelled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-admin-cancel-'))
    roots.push(root)
    const systemsFile = join(root, 'systems.json')
    writeFileSync(systemsFile, JSON.stringify(mockSystemsDocument()), 'utf8')
    const dataDir = join(root, 'data')
    const config = createPlatformConfig({
      dataDir,
      integration: {
        enabled: true,
        systemsFile,
        runnerKind: 'container',
        jobImage: 'dsh-analysis-test:local',
        jobNetwork: 'none',
      },
    })
    const now = '2026-11-24T00:00:00.000Z'
    const store = IntegrationStore.open(config.integration.databaseFile)
    try {
      store.insertJob({
        id: 'job-cancel',
        ownerUserId: 'user-a',
        sessionId: 'session-a',
        workspaceId: 'ws-1',
        inputSnapshotIds: [],
        language: 'shell',
        policyEpoch: 1,
        scriptSha256: 'd'.repeat(64),
        status: 'running',
        createdAt: now,
        startedAt: now,
        finishedAt: null,
        errorCode: null,
      })
    } finally {
      store.close()
    }
    const calls: (readonly string[])[] = []
    const job = await cancelIntegrationJob(config, 'job-cancel', {
      now: '2026-11-24T00:01:00.000Z',
      executor: async (args) => {
        calls.push(args)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })
    expect(job).toMatchObject({ id: 'job-cancel', status: 'cancelled', errorCode: 'ADMIN_CANCELLED' })
    expect(calls[0]?.[0]).toBe('rm')
  })
})
