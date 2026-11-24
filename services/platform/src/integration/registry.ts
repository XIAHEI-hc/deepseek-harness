/**
 * Administrator-maintained connector registry.
 *
 * The registry is the only place connector endpoints and per-user ACLs are
 * declared. Nothing a browser or model sends can add a system, endpoint, user,
 * action, or URL: request values only select entries loaded here.
 *
 * @module @deepseek-ai/dsh-platform-services/integration/registry
 */

import { readFileSync } from 'node:fs'
import type {
  ResourceAction,
  ResourceClassification,
  ResourceType,
} from './types.ts'

/** JSON values accepted as offline Mock host content. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }

/** One per-user ACL entry. */
export type ResourceAcl = Readonly<Record<string, readonly ResourceAction[]>>

/** One endpoint exposed by a read-only HTTP connector. */
export interface HttpEndpointConfig {
  readonly id: string
  readonly name: string
  /** Absolute path on the configured origin; no query, fragment, or traversal. */
  readonly path: string
  readonly resourceType: ResourceType
  readonly version: string
  readonly classification: ResourceClassification
  readonly acl: ResourceAcl
}

/** One offline resource served by the Mock connector. */
export interface MockResourceConfig {
  readonly id: string
  readonly name: string
  readonly resourceType: ResourceType
  readonly version: string
  readonly classification: ResourceClassification
  readonly acl: ResourceAcl
  readonly content: JsonValue
}

/** One registered host system. */
export interface IntegrationSystemConfig {
  readonly id: string
  readonly name: string
  readonly adapter: 'mock' | 'http'
  /** HTTP connector origin; absent for Mock. */
  readonly baseUrl?: string | undefined
  /** Mock resources; absent for HTTP. */
  readonly mockResources?: readonly MockResourceConfig[] | undefined
  /** HTTP endpoints; absent for Mock. */
  readonly endpoints?: readonly HttpEndpointConfig[] | undefined
}

/** Parsed system registry. */
export interface SystemRegistry {
  readonly version: 1
  readonly systems: readonly IntegrationSystemConfig[]
}

/** Raised when the registry file is absent or does not match the declared format. */
export class SystemRegistryError extends Error {
  /** @param message - actionable description of the invalid entry. */
  constructor(message: string) {
    super(message)
    this.name = 'SystemRegistryError'
  }
}

/** Resource kinds accepted from configuration or requests. */
export const RESOURCE_TYPES: readonly ResourceType[] = ['api', 'source', 'dataset', 'log', 'artifact']
/** Read-only actions accepted from configuration. */
export const RESOURCE_ACTIONS: readonly ResourceAction[] = ['list', 'read', 'export']
/** Classifications accepted from configuration. */
export const RESOURCE_CLASSIFICATIONS: readonly ResourceClassification[] = ['public', 'internal', 'confidential']

/**
 * Report whether a value is a non-array object.
 * @param value - value to inspect.
 * @returns true for a plain record.
 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one required string field.
 * @param record - source object.
 * @param field - field name.
 * @param where - location used in the error message.
 * @returns the string value.
 */
function requireString(record: Readonly<Record<string, unknown>>, field: string, where: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SystemRegistryError(`${where}: ${field} must be a non-empty string`)
  }
  return value.trim()
}

/**
 * Read one optional string field.
 * @param record - source object.
 * @param field - field name.
 * @param where - location used in the error message.
 * @returns the string value or an empty string.
 */
function optionalString(record: Readonly<Record<string, unknown>>, field: string, where: string): string {
  const value = record[field]
  if (value === undefined) return ''
  if (typeof value !== 'string') throw new SystemRegistryError(`${where}: ${field} must be a string`)
  return value.trim()
}

/**
 * Validate a resource type.
 * @param value - candidate value.
 * @param where - location used in the error message.
 * @returns the validated resource type.
 */
function parseResourceType(value: unknown, where: string): ResourceType {
  if (typeof value !== 'string') throw new SystemRegistryError(`${where}: resourceType must be a string`)
  for (const type of RESOURCE_TYPES) {
    if (type === value) return type
  }
  throw new SystemRegistryError(`${where}: unknown resourceType ${JSON.stringify(value)}`)
}

/**
 * Validate a classification.
 * @param value - candidate value.
 * @param where - location used in the error message.
 * @returns the validated classification.
 */
function parseClassification(value: unknown, where: string): ResourceClassification {
  if (typeof value !== 'string') throw new SystemRegistryError(`${where}: classification must be a string`)
  for (const classification of RESOURCE_CLASSIFICATIONS) {
    if (classification === value) return classification
  }
  throw new SystemRegistryError(`${where}: unknown classification ${JSON.stringify(value)}`)
}

/**
 * Validate one ACL map.
 * @param value - candidate ACL value.
 * @param where - location used in the error message.
 * @returns the validated ACL.
 */
function parseAcl(value: unknown, where: string): ResourceAcl {
  if (!isRecord(value)) throw new SystemRegistryError(`${where}: acl must be an object keyed by internal user id`)
  const acl: Record<string, readonly ResourceAction[]> = {}
  for (const [userId, actionsValue] of Object.entries(value)) {
    if (userId.trim() === '') throw new SystemRegistryError(`${where}: acl contains an empty user id`)
    if (!Array.isArray(actionsValue) || actionsValue.length === 0) {
      throw new SystemRegistryError(`${where}: acl[${JSON.stringify(userId)}] must be a non-empty action array`)
    }
    const actions: ResourceAction[] = []
    for (const actionValue of actionsValue) {
      const action = typeof actionValue === 'string' ? RESOURCE_ACTIONS.find(candidate => candidate === actionValue) : undefined
      if (action === undefined) {
        throw new SystemRegistryError(`${where}: acl[${JSON.stringify(userId)}] has unknown action ${JSON.stringify(actionValue)}`)
      }
      if (!actions.includes(action)) actions.push(action)
    }
    acl[userId] = actions
  }
  return acl
}

/**
 * Validate one JSON value recursively so Mock content stays serializable.
 * @param value - candidate value.
 * @param where - location used in the error message.
 * @returns the validated value.
 */
function parseJsonValue(value: unknown, where: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SystemRegistryError(`${where}: content number must be finite`)
    return value
  }
  if (Array.isArray(value)) return value.map((entry, index) => parseJsonValue(entry, `${where}[${String(index)}]`))
  if (isRecord(value)) {
    const record: Record<string, JsonValue> = {}
    for (const [key, entry] of Object.entries(value)) record[key] = parseJsonValue(entry, `${where}.${key}`)
    return record
  }
  throw new SystemRegistryError(`${where}: content must contain JSON values only`)
}

/**
 * Validate one resource id.
 * @param value - candidate id.
 * @param where - location used in the error message.
 * @returns the id.
 */
function parseResourceId(value: unknown, where: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)) {
    throw new SystemRegistryError(`${where}: id must match [a-z0-9][a-z0-9._-]{0,127}`)
  }
  return value
}

/**
 * Validate one HTTP endpoint path.
 * @param value - candidate path.
 * @param where - location used in the error message.
 * @returns the path.
 */
function parseEndpointPath(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    throw new SystemRegistryError(`${where}: path must be absolute`)
  }
  if (value.includes('?') || value.includes('#') || value.includes('\\') || value.split('/').includes('..')) {
    throw new SystemRegistryError(`${where}: path must not contain a query, fragment, backslash, or traversal`)
  }
  return value
}

/**
 * Validate one Mock resource entry.
 * @param value - candidate value.
 * @param where - location used in the error message.
 * @returns the validated resource.
 */
function parseMockResource(value: unknown, where: string): MockResourceConfig {
  if (!isRecord(value)) throw new SystemRegistryError(`${where}: resource must be an object`)
  return {
    id: parseResourceId(value['id'], where),
    name: requireString(value, 'name', where),
    resourceType: parseResourceType(value['resourceType'], where),
    version: optionalString(value, 'version', where) === '' ? '1' : optionalString(value, 'version', where),
    classification: parseClassification(value['classification'], where),
    acl: parseAcl(value['acl'], where),
    content: parseJsonValue(value['content'], `${where}.content`),
  }
}

/**
 * Validate one HTTP endpoint entry.
 * @param value - candidate value.
 * @param where - location used in the error message.
 * @returns the validated endpoint.
 */
function parseHttpEndpoint(value: unknown, where: string): HttpEndpointConfig {
  if (!isRecord(value)) throw new SystemRegistryError(`${where}: endpoint must be an object`)
  return {
    id: parseResourceId(value['id'], where),
    name: requireString(value, 'name', where),
    path: parseEndpointPath(value['path'], where),
    resourceType: parseResourceType(value['resourceType'], where),
    version: optionalString(value, 'version', where) === '' ? '1' : optionalString(value, 'version', where),
    classification: parseClassification(value['classification'], where),
    acl: parseAcl(value['acl'], where),
  }
}

/**
 * Validate one system entry.
 * @param value - candidate value.
 * @param where - location used in the error message.
 * @returns the validated system.
 */
function parseSystem(value: unknown, where: string): IntegrationSystemConfig {
  if (!isRecord(value)) throw new SystemRegistryError(`${where}: system must be an object`)
  const id = parseResourceId(value['id'], where)
  const name = requireString(value, 'name', where)
  const adapter = requireString(value, 'adapter', where)
  if (adapter === 'mock') {
    const resources = value['mockResources']
    if (!Array.isArray(resources) || resources.length === 0) {
      throw new SystemRegistryError(`${where}: mock system requires at least one mockResources entry`)
    }
    return {
      id,
      name,
      adapter,
      mockResources: resources.map((entry, index) => parseMockResource(entry, `${where}.mockResources[${String(index)}]`)),
    }
  }
  if (adapter === 'http') {
    const baseUrl = requireString(value, 'baseUrl', where)
    let parsed: URL
    try {
      parsed = new URL(baseUrl)
    } catch {
      throw new SystemRegistryError(`${where}: baseUrl must be an absolute HTTP(S) URL`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new SystemRegistryError(`${where}: baseUrl must use http or https`)
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new SystemRegistryError(`${where}: baseUrl must not embed credentials`)
    }
    if (parsed.search !== '' || parsed.hash !== '' || parsed.pathname !== '/') {
      throw new SystemRegistryError(`${where}: baseUrl must be a bare origin`)
    }
    const endpoints = value['endpoints']
    if (!Array.isArray(endpoints) || endpoints.length === 0) {
      throw new SystemRegistryError(`${where}: http system requires at least one endpoints entry`)
    }
    return {
      id,
      name,
      adapter,
      baseUrl: parsed.origin,
      endpoints: endpoints.map((entry, index) => parseHttpEndpoint(entry, `${where}.endpoints[${String(index)}]`)),
    }
  }
  throw new SystemRegistryError(`${where}: adapter must be mock or http`)
}

/**
 * Parse a registry document.
 * @param value - parsed JSON value.
 * @returns the validated registry.
 * @throws {SystemRegistryError} when the document does not match the declared format.
 */
export function parseSystemRegistry(value: unknown): SystemRegistry {
  if (!isRecord(value)) throw new SystemRegistryError('systems file must be a JSON object')
  if (value['version'] !== 1) throw new SystemRegistryError('systems file version must be 1')
  const systemsValue = value['systems']
  if (!Array.isArray(systemsValue) || systemsValue.length === 0) {
    throw new SystemRegistryError('systems file must declare at least one system')
  }
  const systems = systemsValue.map((entry, index) => parseSystem(entry, `systems[${String(index)}]`))
  const ids = new Set<string>()
  for (const system of systems) {
    if (ids.has(system.id)) throw new SystemRegistryError(`systems file repeats system id ${JSON.stringify(system.id)}`)
    ids.add(system.id)
    const resourceIds = new Set<string>()
    const resources = system.mockResources ?? system.endpoints ?? []
    for (const resource of resources) {
      if (resourceIds.has(resource.id)) {
        throw new SystemRegistryError(`system ${JSON.stringify(system.id)} repeats resource id ${JSON.stringify(resource.id)}`)
      }
      resourceIds.add(resource.id)
    }
  }
  return { version: 1, systems }
}

/**
 * Read and parse the configured registry file.
 * @param file - absolute registry file path.
 * @returns the validated registry.
 * @throws {SystemRegistryError} when the file cannot be read or parsed.
 */
export function loadSystemRegistry(file: string): SystemRegistry {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new SystemRegistryError(`systems file ${JSON.stringify(file)} could not be read`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new SystemRegistryError(`systems file ${JSON.stringify(file)} is not valid JSON`)
  }
  return parseSystemRegistry(parsed)
}

/**
 * Find one registered system.
 * @param registry - parsed registry.
 * @param systemId - system id from the request.
 * @returns the system, or undefined.
 */
export function findSystem(registry: SystemRegistry, systemId: string): IntegrationSystemConfig | undefined {
  return registry.systems.find(system => system.id === systemId)
}
