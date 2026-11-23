/** System-fusion service: authorization, snapshots, workspaces, jobs, and source metadata. */
import { afterEach, describe, expect, it } from 'vitest'
import type { IntegrationService } from '../src/contracts.ts'
import {
  FakeAnalysisExecutor,
  USER_A,
  USER_B,
  callFusion,
  createIntegrationTestEnvironment,
  sessionFor,
  waitForJob,
  type IntegrationTestEnvironment,
} from './integration.testkit.ts'

let environment: IntegrationTestEnvironment | undefined

afterEach(async () => {
  await environment?.close()
  environment = undefined
})

/**
 * Read one string field from a JSON object.
 * @param value - object to inspect.
 * @param field - field name.
 * @returns the string value.
 */
function requireString(value: Record<string, unknown>, field: string): string {
  const entry = value[field]
  if (typeof entry !== 'string') throw new Error(`missing string field ${field}`)
  return entry
}

/**
 * Create one workspace and return its id.
 * @param service - fusion service.
 * @param userId - owner.
 * @param name - display name.
 * @returns the workspace id.
 */
async function createWorkspace(service: IntegrationService, userId: string, name: string): Promise<string> {
  const response = await callFusion(service, sessionFor(userId), 'POST', '/api/integration/workspaces', { name })
  expect(response.status).toBe(201)
  const workspace = response.body?.['workspace']
  if (workspace === undefined || typeof workspace !== 'object' || workspace === null || Array.isArray(workspace)) {
    throw new Error('workspace response is missing')
  }
  return requireString(workspace as Record<string, unknown>, 'id')
}

/**
 * Capture one snapshot and return its id.
 * @param service - fusion service.
 * @param userId - owner.
 * @param resourceId - Mock resource id.
 * @param resourceType - resource type.
 * @returns the snapshot id.
 */
async function captureSnapshot(
  service: IntegrationService,
  userId: string,
  resourceId: string,
  resourceType = 'dataset',
): Promise<string> {
  const response = await callFusion(service, sessionFor(userId), 'POST', '/api/integration/snapshots', {
    systemId: 'mock-erp',
    resourceId,
    resourceType,
  })
  expect(response.status).toBe(201)
  const snapshot = response.body?.['snapshot']
  if (snapshot === undefined || typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new Error('snapshot response is missing')
  }
  return requireString(snapshot as Record<string, unknown>, 'id')
}

describe('fusion discovery and authorization', () => {
  it('reports ready and lists only systems with an authorized resource', async () => {
    environment = await createIntegrationTestEnvironment()
    const status = await callFusion(environment.service, sessionFor(USER_A), 'GET', '/api/integration/status')
    expect(status.status).toBe(200)
    expect(status.body?.['state']).toBe('ready')
    const systems = await callFusion(environment.service, sessionFor(USER_A), 'GET', '/api/integration/systems')
    expect(systems.status).toBe(200)
    const list = systems.body?.['systems']
    expect(Array.isArray(list)).toBe(true)
    expect((list as unknown[]).length).toBe(1)
  })

  it('shows each user only the resources their ACL permits', async () => {
    environment = await createIntegrationTestEnvironment()
    const asA = await callFusion(environment.service, sessionFor(USER_A), 'GET', '/api/integration/resources?systemId=mock-erp')
    expect(asA.status).toBe(200)
    const aItems = asA.body?.['items'] as { locator: { resourceId: string } }[]
    expect(aItems.map(item => item.locator.resourceId).sort()).toEqual(['sales-2026', 'secret-plan'])
    const asB = await callFusion(environment.service, sessionFor(USER_B), 'GET', '/api/integration/resources?systemId=mock-erp')
    const bItems = asB.body?.['items'] as { locator: { resourceId: string } }[]
    expect(bItems.map(item => item.locator.resourceId)).toEqual(['sales-2026'])
  })

  it('refuses a snapshot for a resource the user cannot read', async () => {
    environment = await createIntegrationTestEnvironment()
    const response = await callFusion(environment.service, sessionFor(USER_B), 'POST', '/api/integration/snapshots', {
      systemId: 'mock-erp',
      resourceId: 'secret-plan',
      resourceType: 'source',
    })
    expect(response.status).toBe(403)
    expect(environment.audit.some(event => event.outcome === 'failure')).toBe(true)
  })

  it('records a stable hash and source version on each snapshot', async () => {
    environment = await createIntegrationTestEnvironment()
    const response = await callFusion(environment.service, sessionFor(USER_A), 'POST', '/api/integration/snapshots', {
      systemId: 'mock-erp',
      resourceId: 'sales-2026',
      resourceType: 'dataset',
    })
    expect(response.status).toBe(201)
    const snapshot = response.body?.['snapshot'] as Record<string, unknown>
    expect(requireString(snapshot, 'sha256')).toMatch(/^[0-9a-f]{64}$/u)
    expect(snapshot['sourceVersion']).toBe('3')
    expect(environment.audit.some(event => event.action === 'SNAPSHOT_CREATE' && event.outcome === 'success')).toBe(true)
  })
})

describe('analysis jobs', () => {
  it('runs a job, records source metadata, and downloads the artifact', async () => {
    environment = await createIntegrationTestEnvironment()
    const workspaceId = await createWorkspace(environment.service, USER_A, 'Analysis A')
    const snapshotId = await captureSnapshot(environment.service, USER_A, 'sales-2026')
    const start = await callFusion(environment.service, sessionFor(USER_A), 'POST', '/api/integration/jobs', {
      workspaceId,
      inputSnapshotIds: [snapshotId],
      language: 'shell',
      script: 'echo report > /work/report.json\n',
    })
    expect(start.status).toBe(202)
    const started = start.body?.['job'] as Record<string, unknown>
    const jobId = requireString(started, 'id')
    const settled = await waitForJob(environment.service, sessionFor(USER_A), jobId)
    expect(settled['status']).toBe('succeeded')
    const view = await callFusion(environment.service, sessionFor(USER_A), 'GET', `/api/integration/jobs/${jobId}`)
    const artifacts = view.body?.['artifacts'] as Record<string, unknown>[]
    expect(artifacts).toHaveLength(1)
    const artifactId = requireString(artifacts[0] ?? {}, 'id')
    const download = await callFusion(environment.service, sessionFor(USER_A), 'GET', `/api/integration/artifacts/${artifactId}/download`)
    expect(download.status).toBe(200)
    expect(new TextDecoder().decode(download.bytes)).toContain('dsh-analysis-')
    const audit = await callFusion(environment.service, sessionFor(USER_A), 'GET', `/api/integration/audit?jobId=${jobId}`)
    expect(audit.status).toBe(200)
    const inputs = audit.body?.['inputs'] as unknown[]
    expect(inputs).toHaveLength(1)
  })

  it('reads the same authorized snapshot in a second workspace but writes only there', async () => {
    environment = await createIntegrationTestEnvironment()
    const workspaceA = await createWorkspace(environment.service, USER_A, 'Workspace A')
    const workspaceB = await createWorkspace(environment.service, USER_A, 'Workspace B')
    const snapshotId = await captureSnapshot(environment.service, USER_A, 'sales-2026')
    const first = await callFusion(environment.service, sessionFor(USER_A), 'POST', '/api/integration/jobs', {
      workspaceId: workspaceA,
      inputSnapshotIds: [snapshotId],
      language: 'shell',
      script: 'report a\n',
    })
    const second = await callFusion(environment.service, sessionFor(USER_A), 'POST', '/api/integration/jobs', {
      workspaceId: workspaceB,
      inputSnapshotIds: [snapshotId],
      language: 'shell',
      script: 'report b\n',
    })
    const jobA = requireString(first.body?.['job'] as Record<string, unknown>, 'id')
    const jobB = requireString(second.body?.['job'] as Record<string, unknown>, 'id')
    expect((await waitForJob(environment.service, sessionFor(USER_A), jobA))['workspaceId']).toBe(workspaceA)
    expect((await waitForJob(environment.service, sessionFor(USER_A), jobB))['workspaceId']).toBe(workspaceB)
    const viewA = await callFusion(environment.service, sessionFor(USER_A), 'GET', `/api/integration/jobs/${jobA}`)
    const viewB = await callFusion(environment.service, sessionFor(USER_A), 'GET', `/api/integration/jobs/${jobB}`)
    expect((viewA.body?.['artifacts'] as unknown[])).toHaveLength(1)
    expect((viewB.body?.['artifacts'] as unknown[])).toHaveLength(1)
  })

  it('does not reveal another user\'s job or artifact', async () => {
    environment = await createIntegrationTestEnvironment()
    const workspaceId = await createWorkspace(environment.service, USER_A, 'Private')
    const snapshotId = await captureSnapshot(environment.service, USER_A, 'sales-2026')
    const start = await callFusion(environment.service, sessionFor(USER_A), 'POST', '/api/integration/jobs', {
      workspaceId,
      inputSnapshotIds: [snapshotId],
      language: 'shell',
      script: 'report\n',
    })
    const jobId = requireString(start.body?.['job'] as Record<string, unknown>, 'id')
    await waitForJob(environment.service, sessionFor(USER_A), jobId)
    expect((await callFusion(environment.service, sessionFor(USER_B), 'GET', `/api/integration/jobs/${jobId}`)).status).toBe(404)
    const view = await callFusion(environment.service, sessionFor(USER_A), 'GET', `/api/integration/jobs/${jobId}`)
    const artifactId = requireString((view.body?.['artifacts'] as Record<string, unknown>[])[0] ?? {}, 'id')
    expect((await callFusion(environment.service, sessionFor(USER_B), 'GET', `/api/integration/artifacts/${artifactId}/download`)).status).toBe(404)
  })

  it('marks a nonzero container exit as failed without artifacts', async () => {
    const executor = new FakeAnalysisExecutor()
    executor.exitCode = 2
    environment = await createIntegrationTestEnvironment({ executor })
    const workspaceId = await createWorkspace(environment.service, USER_A, 'Failing')
    const snapshotId = await captureSnapshot(environment.service, USER_A, 'sales-2026')
    const start = await callFusion(environment.service, sessionFor(USER_A), 'POST', '/api/integration/jobs', {
      workspaceId,
      inputSnapshotIds: [snapshotId],
      language: 'shell',
      script: 'exit 2\n',
    })
    const jobId = requireString(start.body?.['job'] as Record<string, unknown>, 'id')
    const settled = await waitForJob(environment.service, sessionFor(USER_A), jobId)
    expect(settled['status']).toBe('failed')
    expect(settled['errorCode']).toBe('JOB_EXITED')
    const view = await callFusion(environment.service, sessionFor(USER_A), 'GET', `/api/integration/jobs/${jobId}`)
    expect(view.body?.['artifacts']).toEqual([])
  })

  it('rejects a job whose snapshot permission epoch changed', async () => {
    environment = await createIntegrationTestEnvironment()
    const workspaceId = await createWorkspace(environment.service, USER_A, 'Epoch')
    const snapshotId = await captureSnapshot(environment.service, USER_A, 'sales-2026')
    const response = await callFusion(
      environment.service,
      sessionFor(USER_A, 2),
      'POST',
      '/api/integration/jobs',
      { workspaceId, inputSnapshotIds: [snapshotId], language: 'shell', script: 'report\n' },
    )
    expect(response.status).toBe(403)
  })
})

describe('blocked fusion', () => {
  it('serves status but refuses data routes when preflight fails', async () => {
    const { createIntegrationService } = await import('../src/integration/service.ts')
    const { loadIntegrationConfig } = await import('../src/integration/config.ts')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = mkdtempSync(join(tmpdir(), 'dsh-integration-blocked-'))
    const dataDir = join(root, 'data')
    const config = loadIntegrationConfig({
      APP_ENV: 'testing',
      DSH_INTEGRATION_ENABLED: 'true',
      DSH_INTEGRATION_DATA_DIR: dataDir,
      DSH_INTEGRATION_JOB_RUNNER_KIND: 'container',
      DSH_INTEGRATION_JOB_IMAGE: 'test',
    }, { appEnv: 'testing', dataDir, runtimeDockerCommand: 'docker' })
    const service: IntegrationService = createIntegrationService(config, {
      state: 'blocked',
      issues: [{ code: 'docker-unavailable', message: 'no daemon' }],
    })
    try {
      const status = await callFusion(service, sessionFor(USER_A), 'GET', '/api/integration/status')
      expect(status.status).toBe(200)
      expect(status.body?.['state']).toBe('blocked')
      const systems = await callFusion(service, sessionFor(USER_A), 'GET', '/api/integration/systems')
      expect(systems.status).toBe(503)
      expect(systems.body?.['error']).toMatchObject({ code: 'integration-blocked' })
    } finally {
      await service.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('has no side effects when disabled', async () => {
    const { createIntegrationService } = await import('../src/integration/service.ts')
    const { loadIntegrationConfig } = await import('../src/integration/config.ts')
    const config = loadIntegrationConfig({}, { appEnv: 'testing', dataDir: 'C:/tmp/none', runtimeDockerCommand: 'docker' })
    const service = createIntegrationService(config, { state: 'disabled', issues: [] }, {})
    try {
      const status = await callFusion(service, sessionFor(USER_A), 'GET', '/api/integration/status')
      expect(status.body?.['state']).toBe('disabled')
      expect((await callFusion(service, sessionFor(USER_A), 'GET', '/api/integration/systems')).status).toBe(503)
    } finally {
      await service.close()
    }
  })
})
