/** Fusion workbench API client: availability, CSRF, parsing, and download paths. */
import { describe, expect, it } from 'vitest'
import {
  artifactDownloadPath,
  FusionApiError,
  loadFusionStatus,
  loadOverview,
  startJob,
  type FusionTransport,
} from '../src/client/api.ts'

interface RecordedRequest {
  readonly input: string
  readonly init: RequestInit | undefined
}

/**
 * Build a transport answering from a queue of responses.
 * @param responses - responses in call order.
 * @param csrf - cookie value returned to the client.
 * @returns the transport and its recorded requests.
 */
function fakeTransport(responses: readonly Response[], csrf = 'csrf-token'): {
  readonly transport: FusionTransport
  readonly requests: RecordedRequest[]
} {
  const requests: RecordedRequest[] = []
  let index = 0
  return {
    requests,
    transport: {
      fetch: async (input, init) => {
        requests.push({ input, init })
        const response = responses[index]
        index += 1
        if (response === undefined) throw new Error('unexpected extra request')
        return response
      },
      cookie: name => name === 'dsh_csrf' ? csrf : undefined,
    },
  }
}

/**
 * Build one JSON response.
 * @param status - HTTP status.
 * @param body - JSON body.
 * @returns the response.
 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('fusion API client', () => {
  it('reports unavailable when the deployment has no fusion API', async () => {
    const { transport } = fakeTransport([new Response(null, { status: 404 })])
    await expect(loadFusionStatus(transport)).resolves.toBeUndefined()
  })

  it('reads the status and overview', async () => {
    const { transport, requests } = fakeTransport([
      jsonResponse(200, { state: 'ready', enabled: true, issues: [] }),
      jsonResponse(200, { systems: [{ id: 'mock-erp', name: 'Mock ERP', health: 'ready' }] }),
      jsonResponse(200, { workspaces: [{ id: 'w1', name: 'Main', createdAt: '2026-01-01T00:00:00.000Z' }] }),
      jsonResponse(200, { jobs: [] }),
    ])
    const overview = await loadOverview(transport)
    expect(overview.status.state).toBe('ready')
    expect(overview.systems).toHaveLength(1)
    expect(overview.workspaces[0]?.name).toBe('Main')
    expect(requests).toHaveLength(4)
  })

  it('echoes the CSRF cookie on a mutation', async () => {
    const { transport, requests } = fakeTransport([
      jsonResponse(202, {
        job: {
          id: 'j1',
          workspaceId: 'w1',
          status: 'queued',
          inputSnapshotIds: ['s1'],
          language: 'shell',
          createdAt: '2026-01-01T00:00:00.000Z',
          startedAt: null,
          finishedAt: null,
          errorCode: null,
        },
      }),
    ])
    const job = await startJob(transport, {
      workspaceId: 'w1',
      inputSnapshotIds: ['s1'],
      language: 'shell',
      script: 'echo ok\n',
    })
    expect(job.status).toBe('queued')
    expect((requests[0]?.init?.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-token')
    expect(requests[0]?.init?.method).toBe('POST')
  })

  it('classifies a service error by its stable code', async () => {
    const { transport } = fakeTransport([jsonResponse(403, { error: { code: 'resource-forbidden' } })])
    await expect(loadFusionStatus(transport)).rejects.toMatchObject({ code: 'resource-forbidden', status: 403 })
  })

  it('rejects a malformed status body', async () => {
    const { transport } = fakeTransport([jsonResponse(200, { state: 'sideways' })])
    await expect(loadFusionStatus(transport)).rejects.toBeInstanceOf(FusionApiError)
  })

  it('builds a same-origin download path', () => {
    expect(artifactDownloadPath('a b')).toBe('/api/integration/artifacts/a%20b/download')
  })
})
