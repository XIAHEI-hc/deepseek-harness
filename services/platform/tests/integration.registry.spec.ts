/** Connector registry validation. */
import { describe, expect, it } from 'vitest'
import { parseSystemRegistry, SystemRegistryError } from '../src/integration/registry.ts'
import { mockSystemsDocument } from './integration.testkit.ts'

describe('parseSystemRegistry', () => {
  it('accepts the declarative Mock document', () => {
    const registry = parseSystemRegistry(mockSystemsDocument())
    expect(registry.systems).toHaveLength(1)
    expect(registry.systems[0]?.mockResources).toHaveLength(2)
  })

  it('refuses duplicate system ids', () => {
    const document = {
      version: 1,
      systems: [
        { id: 'mock-a', name: 'A', adapter: 'mock', mockResources: [{ id: 'r', name: 'R', resourceType: 'dataset', classification: 'internal', acl: { u: ['read'] }, content: null }] },
        { id: 'mock-a', name: 'B', adapter: 'mock', mockResources: [{ id: 's', name: 'S', resourceType: 'dataset', classification: 'internal', acl: { u: ['read'] }, content: null }] },
      ],
    }
    expect(() => parseSystemRegistry(document)).toThrow(/repeats system id/u)
  })

  it('refuses endpoint traversal and embedded credentials', () => {
    const traversal = {
      version: 1,
      systems: [{
        id: 'http-a',
        name: 'A',
        adapter: 'http',
        baseUrl: 'https://host.example',
        endpoints: [{ id: 'e', name: 'E', path: '/api/../secret', resourceType: 'api', classification: 'internal', acl: { u: ['read'] } }],
      }],
    }
    expect(() => parseSystemRegistry(traversal)).toThrow(SystemRegistryError)
    const credentials = {
      version: 1,
      systems: [{
        id: 'http-a',
        name: 'A',
        adapter: 'http',
        baseUrl: 'https://user:pass@host.example',
        endpoints: [{ id: 'e', name: 'E', path: '/api', resourceType: 'api', classification: 'internal', acl: { u: ['read'] } }],
      }],
    }
    expect(() => parseSystemRegistry(credentials)).toThrow(/credentials/u)
  })

  it('refuses an unknown write action', () => {
    const document = {
      version: 1,
      systems: [{
        id: 'mock-a',
        name: 'A',
        adapter: 'mock',
        mockResources: [{
          id: 'r',
          name: 'R',
          resourceType: 'dataset',
          classification: 'internal',
          acl: { u: ['read', 'write'] },
          content: null,
        }],
      }],
    }
    expect(() => parseSystemRegistry(document)).toThrow(/unknown action/u)
  })
})
