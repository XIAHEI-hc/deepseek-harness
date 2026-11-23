/** Read-only HTTP connector: ACL, redirect, size, and metadata-host boundaries. */
import { describe, expect, it } from 'vitest'
import { HttpReadOnlyAdapter } from '../src/integration/adapters.ts'
import type { IntegrationSystemConfig } from '../src/integration/registry.ts'

const actorA = {
  userId: 'user-a',
  subject: 'w3-user-a',
  uid: 'uid-user-a',
  sessionId: 'session-user-a',
  permissionVersion: 1,
}

const system: IntegrationSystemConfig = {
  id: 'warehouse',
  name: 'Warehouse',
  adapter: 'http',
  baseUrl: 'https://warehouse.internal.example',
  endpoints: [
    {
      id: 'devices',
      name: 'Devices',
      path: '/api/devices',
      resourceType: 'api',
      version: '7',
      classification: 'internal',
      acl: { 'user-a': ['list', 'read'] },
    },
  ],
}

const locator = { systemId: 'warehouse', resourceType: 'api' as const, resourceId: 'devices', version: '7' }

describe('HttpReadOnlyAdapter', () => {
  it('lists and authorizes only the configured user and endpoint', async () => {
    const adapter = new HttpReadOnlyAdapter(system, { timeoutMs: 1000, maxBytes: 1024, now: () => 0 })
    const page = await adapter.discover(actorA, null)
    expect(page.items.map(item => item.locator.resourceId)).toEqual(['devices'])
    const grant = await adapter.authorize(actorA, locator, 'read')
    expect(grant.ownerUserId).toBe('user-a')
    expect(grant.grantId).not.toBe('')
    await expect(adapter.authorize({ ...actorA, userId: 'user-b' }, locator, 'read')).rejects.toMatchObject({ code: 'resource-forbidden' })
  })

  it('refuses redirects instead of following one', async () => {
    const adapter = new HttpReadOnlyAdapter(system, {
      timeoutMs: 1000,
      maxBytes: 1024,
      fetchImplementation: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/evil' } }),
    })
    const grant = await adapter.authorize(actorA, locator, 'read')
    await expect(adapter.snapshot(actorA, locator, grant)).rejects.toMatchObject({ code: 'snapshot-failed' })
  })

  it('caps the response body', async () => {
    const adapter = new HttpReadOnlyAdapter(system, {
      timeoutMs: 1000,
      maxBytes: 4,
      fetchImplementation: async () => new Response('12345', { status: 200, headers: { 'content-type': 'text/plain' } }),
    })
    const grant = await adapter.authorize(actorA, locator, 'read')
    await expect(adapter.snapshot(actorA, locator, grant)).rejects.toMatchObject({ code: 'snapshot-too-large' })
  })

  it('records the response etag as the source version', async () => {
    const adapter = new HttpReadOnlyAdapter(system, {
      timeoutMs: 1000,
      maxBytes: 1024,
      fetchImplementation: async () => new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json', etag: '"r42"' },
      }),
    })
    const grant = await adapter.authorize(actorA, locator, 'read')
    const payload = await adapter.snapshot(actorA, locator, grant)
    expect(payload.sourceVersion).toBe('"r42"')
    expect(new TextDecoder().decode(payload.content)).toBe('{"ok":true}')
  })

  it('refuses a metadata endpoint origin at construction', () => {
    expect(() => new HttpReadOnlyAdapter({ ...system, baseUrl: 'http://169.254.169.254' }, { timeoutMs: 1000, maxBytes: 1024 }))
      .toThrow(/metadata/u)
  })

  it('never accepts a locator from another connector', async () => {
    const adapter = new HttpReadOnlyAdapter(system, { timeoutMs: 1000, maxBytes: 1024 })
    await expect(adapter.authorize(actorA, { ...locator, systemId: 'other' }, 'read'))
      .rejects.toMatchObject({ code: 'resource-not-found' })
  })
})
