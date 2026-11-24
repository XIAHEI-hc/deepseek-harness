/** Fusion metadata and snapshot bytes survive a deployment-style tar round-trip. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IntegrationStore } from '../src/integration/store.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('integration backup round-trip', () => {
  it('preserves metadata counts and snapshot bytes through tar and restore', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-fusion-backup-'))
    roots.push(root)
    const management = join(root, 'management')
    const dataDir = join(management, 'integration')
    mkdirSync(join(dataDir, 'snapshots', 'user-a'), { recursive: true })
    writeFileSync(join(dataDir, 'snapshots', 'user-a', 'snap-1.bin'), 'fusion-snapshot')
    const store = IntegrationStore.open(join(dataDir, 'integration.sqlite'))
    const now = '2026-11-24T00:00:00.000Z'
    try {
      store.insertWorkspace({ id: 'ws-1', ownerUserId: 'user-a', name: 'Workspace', createdAt: now })
      store.insertSnapshot({
        id: 'snap-1',
        ownerUserId: 'user-a',
        locator: { systemId: 'mock-erp', resourceType: 'dataset', resourceId: 'sales' },
        sourceVersion: '1',
        sha256: createHash('sha256').update('fusion-snapshot').digest('hex'),
        fetchedAt: now,
        grantId: 'grant-1',
        policyEpoch: 1,
        classification: 'internal',
        contentType: 'text/plain',
        storageKey: 'user-a/snap-1.bin',
        size: 15,
      })
      store.insertJob({
        id: 'job-1',
        ownerUserId: 'user-a',
        sessionId: 'session-user-a',
        workspaceId: 'ws-1',
        inputSnapshotIds: ['snap-1'],
        language: 'shell',
        policyEpoch: 1,
        scriptSha256: 'b'.repeat(64),
        status: 'succeeded',
        createdAt: now,
        startedAt: now,
        finishedAt: now,
        errorCode: null,
      })
      store.insertArtifact({
        id: 'artifact-1',
        jobId: 'job-1',
        workspaceId: 'ws-1',
        ownerUserId: 'user-a',
        relativePath: 'report.txt',
        sha256: 'c'.repeat(64),
        mime: 'text/plain',
        size: 5,
        createdAt: now,
        downloadScope: 'owner',
      })
    } finally {
      store.close()
    }

    const archive = join(root, 'management.tar')
    execFileSync('tar', ['-cf', archive, '-C', root, 'management'])
    const restored = join(root, 'restored')
    mkdirSync(restored, { recursive: true })
    execFileSync('tar', ['-xf', archive, '-C', restored])

    const restoredStore = IntegrationStore.open(join(restored, 'management', 'integration', 'integration.sqlite'))
    try {
      expect(restoredStore.stats()).toEqual({ workspaces: 1, snapshots: 1, jobs: 1, artifacts: 1, activeJobs: 0 })
      const snapshot = restoredStore.findSnapshot('snap-1', 'user-a')
      expect(snapshot?.storageKey).toBe('user-a/snap-1.bin')
    } finally {
      restoredStore.close()
    }
    expect(readFileSync(join(restored, 'management', 'integration', 'snapshots', 'user-a', 'snap-1.bin'), 'utf8'))
      .toBe('fusion-snapshot')
  })
})
