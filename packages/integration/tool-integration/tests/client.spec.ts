/** Fusion tool client: capability header, discovery, bounded reads, and errors. */
import { describe, expect, it } from 'vitest'
import { IntegrationClient, IntegrationClientError } from '../src/client.ts'

interface Recorded {
  readonly input: string
  readonly init: RequestInit | undefined
}

/**
 * Build a client over queued responses.
 * @param responses - responses in call order.
 * @returns the client and recorded requests.
 */
function clientWith(responses: readonly Response[]): { client: IntegrationClient; requests: Recorded[] } {
  const requests: Recorded[] = []
  let index = 0
  const client = new IntegrationClient({
    apiUrl: 'http://platform:8080/',
    capability: 'cap-token',
    timeoutMs: 5_000,
    maxContentChars: 12,
    fetchImplementation: async (input, init) => {
      requests.push({ input, init })
      const response = responses[index]
      index += 1
      if (response === undefined) throw new Error('unexpected request')
      return response
    },
  })
  return { client, requests }
}

/**
 * Build one JSON response.
 * @param status - HTTP status.
 * @param body - JSON body.
 * @returns the response.
 */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const SNAPSHOT = {
  id: 'snap-1',
  locator: { systemId: 'mock-erp', resourceType: 'dataset' as const, resourceId: 'sales', version: '1' },
  sha256: 'a'.repeat(64),
  sourceVersion: '1',
  classification: 'internal',
  size: 5,
}

describe('IntegrationClient', () => {
  it('lists systems and resources with the runtime capability header', async () => {
    const { client, requests } = clientWith([
      json(200, { systems: [{ id: 'mock-erp', name: 'Mock ERP', health: 'ready' }] }),
      json(200, { items: [{ locator: SNAPSHOT.locator, name: 'Sales', classification: 'internal' }], nextCursor: null }),
    ])
    const result = await client.listResources()
    expect(result.systems).toHaveLength(1)
    expect(result.resources[0]?.name).toBe('Sales')
    expect((requests[0]?.init?.headers as Record<string, string>)['authorization']).toBe('Bearer cap-token')
    expect(requests[1]?.input).toContain('/resources?systemId=mock-erp')
  })

  it('creates a snapshot and returns bounded content', async () => {
    const { client } = clientWith([
      json(201, { snapshot: SNAPSHOT }),
      json(200, { snapshot: SNAPSHOT, encoding: 'utf-8', content: '0123456789abcdef' }),
    ])
    const result = await client.readResource(SNAPSHOT.locator)
    expect(result.snapshot.sha256).toBe('a'.repeat(64))
    expect(result.content).toBe('0123456789ab\n[truncated]')
    expect(result.truncated).toBe(true)
  })

  it('starts a job and reads its status', async () => {
    const { client } = clientWith([
      json(202, { job: { id: 'job-1', workspaceId: 'w1', status: 'queued', language: 'shell', inputSnapshotIds: ['snap-1'], errorCode: null } }),
      json(200, { job: { id: 'job-1', workspaceId: 'w1', status: 'succeeded', language: 'shell', inputSnapshotIds: ['snap-1'], errorCode: null }, artifacts: [] }),
    ])
    const job = await client.startJob({ workspaceId: 'w1', inputSnapshotIds: ['snap-1'], language: 'shell', script: 'echo ok' })
    expect(job.status).toBe('queued')
    expect((await client.jobStatus(job.id)).job.status).toBe('succeeded')
  })

  it('reads an artifact as bounded text', async () => {
    const { client } = clientWith([
      new Response('artifact body text', { status: 200, headers: { 'content-type': 'text/plain' } }),
    ])
    const result = await client.readArtifact('art-1')
    expect(result.contentType).toBe('text/plain')
    expect(result.content).toBe('artifact bod\n[truncated]')
  })

  it('classifies a platform error by code', async () => {
    const { client } = clientWith([json(403, { error: { code: 'resource-forbidden' } })])
    const failure = client.listResources()
    await expect(failure).rejects.toMatchObject({ code: 'resource-forbidden', status: 403 })
    await expect(failure).rejects.toBeInstanceOf(IntegrationClientError)
  })
})
