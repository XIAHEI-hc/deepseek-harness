/**
 * Startup preflight for the optional fusion service.
 *
 * Preflight checks the facts the service relies on: a parseable registry,
 * pairwise-disjoint physical roots that no agent can turn into a host path, a
 * deny-by-default job network, a fixed image, and (for the container runner) an
 * answering Docker daemon. Any unmet hard prerequisite moves the service to
 * `blocked`; the native platform keeps running, and every fusion route refuses.
 *
 * @module @deepseek-ai/dsh-platform-services/integration/preflight
 */

import { execFile } from 'node:child_process'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import type { IntegrationConfig } from './config.ts'
import type { IntegrationIssue, IntegrationState } from './types.ts'
import { loadSystemRegistry, type IntegrationSystemConfig, type SystemRegistry } from './registry.ts'

/** Result of the startup check. */
export interface PreflightResult {
  readonly state: IntegrationState
  readonly issues: readonly IntegrationIssue[]
  /** Parsed registry; present only when the registry file is valid. */
  readonly registry?: SystemRegistry | undefined
}

/** Injectable probes; tests replace the Docker check. */
export interface PreflightOptions {
  /** Docker daemon probe; defaults to `docker version`. */
  readonly probeDocker?: ((command: string) => Promise<boolean>) | undefined
  /** Test-only override for a host that cannot preserve Linux bind-mount paths. */
  readonly allowUnsupportedHost?: boolean | undefined
  /** Egress broker health probe; defaults to `GET <url>/healthz`. */
  readonly probeBroker?: ((url: string) => Promise<boolean>) | undefined
}

/**
 * Run one Docker daemon probe.
 * @param command - Docker CLI command.
 * @returns true when the daemon reported a server version.
 */
async function probeDockerDaemon(command: string): Promise<boolean> {
  return await new Promise<boolean>(resolveProbe => {
    execFile(command, ['version', '--format', '{{.Server.Version}}'], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      resolveProbe(error === null && stdout.trim() !== '')
    })
  })
}

/**
 * Ensure one security-relevant root exists as a real directory rather than a symlink.
 * @param path - configured root.
 * @throws {Error} when the path is a symlink or not a directory.
 */
function ensureRealDirectory(path: string): void {
  mkdirSync(path, { recursive: true })
  const stats = lstatSync(path)
  if (stats.isSymbolicLink()) throw new Error('root must not be a symbolic link')
  if (!stats.isDirectory()) throw new Error('root must be a directory')
}

/**
 * Report whether one path is equal to or inside another.
 * @param parent - candidate ancestor.
 * @param child - candidate descendant.
 * @returns true when they are equal or nested.
 */
function overlaps(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith('..'))
}

/**
 * Check that the physical roots are pairwise disjoint.
 * @param roots - named roots.
 * @returns issue messages.
 */
function checkRootSeparation(roots: readonly (readonly [string, string])[]): string[] {
  const issues: string[] = []
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      const [leftName, leftPath] = roots[left] ?? ['', '']
      const [rightName, rightPath] = roots[right] ?? ['', '']
      if (overlaps(leftPath, rightPath) || overlaps(rightPath, leftPath)) {
        issues.push(`${leftName} and ${rightName} must not overlap`)
      }
    }
  }
  return issues
}

/**
 * Check that one system is usable as configured.
 * @param system - registered system.
 * @param production - whether development adapters are forbidden.
 * @returns issue entries.
 */
function checkSystem(system: IntegrationSystemConfig, production: boolean): IntegrationIssue[] {
  const issues: IntegrationIssue[] = []
  if (production && system.adapter === 'mock') {
    issues.push({
      code: 'mock-adapter-in-production',
      message: `system ${system.id} uses the offline Mock adapter in production`,
    })
  }
  const resources = system.mockResources ?? system.endpoints ?? []
  for (const resource of resources) {
    if (Object.keys(resource.acl).length === 0) {
      issues.push({
        code: 'resource-acl-empty',
        message: `system ${system.id} resource ${resource.id} has no user grants`,
      })
    }
  }
  if (system.adapter === 'http' && production && system.baseUrl !== undefined && !system.baseUrl.startsWith('https://')) {
    issues.push({
      code: 'connector-insecure-transport',
      message: `system ${system.id} must use https in production`,
    })
  }
  return issues
}

/**
 * Run the full preflight.
 * @param config - resolved fusion configuration.
 * @param options - injectable probes.
 * @returns the service state, issues, and registry when valid.
 */
export async function runPreflight(config: IntegrationConfig, options: PreflightOptions = {}): Promise<PreflightResult> {
  if (!config.enabled) return { state: 'disabled', issues: [] }
  const issues: IntegrationIssue[] = []
  let registry: SystemRegistry | undefined
  try {
    registry = loadSystemRegistry(config.systemsFile)
  } catch {
    issues.push({
      code: 'systems-file-invalid',
      message: 'the connector registry file is missing or does not match its declared format',
    })
  }
  const production = config.appEnv === 'production'
  const roots: [string, string][] = [
    ['snapshotsRoot', config.snapshotsRoot],
    ['workspacesRoot', config.workspacesRoot],
    ['jobsRoot', config.jobsRoot],
  ]
  const physical: [string, string][] = []
  for (const [name, path] of roots) {
    try {
      ensureRealDirectory(path)
      physical.push([name, realpathSync(path)])
    } catch {
      issues.push({
        code: 'root-invalid',
        message: `${name} is not an existing real directory`,
      })
    }
  }
  try {
    ensureRealDirectory(dirname(config.databaseFile))
  } catch {
    issues.push({
      code: 'database-invalid',
      message: 'the integration database directory is not writable',
    })
  }
  for (const message of checkRootSeparation(physical)) {
    issues.push({ code: 'root-overlap', message })
  }
  if (registry !== undefined) {
    for (const system of registry.systems) issues.push(...checkSystem(system, production))
  }
  if (config.runnerKind === 'container') {
    if (process.platform === 'win32' && options.allowUnsupportedHost !== true) {
      issues.push({
        code: 'host-platform-unsupported',
        message: 'analysis containers require a Linux host so bind-mount paths and isolation flags are authoritative',
      })
    }
    if (config.jobImage === '') {
      issues.push({ code: 'job-image-missing', message: 'DSH_INTEGRATION_JOB_IMAGE is not configured' })
    }
    if (config.jobNetwork !== 'none') {
      if (config.egressBrokerUrl === '') {
        issues.push({
          code: 'egress-broker-missing',
          message: 'a dedicated job network requires DSH_INTEGRATION_EGRESS_BROKER_URL',
        })
      } else {
        let brokerUrl: URL | undefined
        try {
          brokerUrl = new URL(config.egressBrokerUrl)
        } catch {
          issues.push({ code: 'egress-broker-invalid', message: 'egress broker URL is not absolute' })
        }
        if (brokerUrl !== undefined && brokerUrl.protocol !== 'http:' && brokerUrl.protocol !== 'https:') {
          issues.push({ code: 'egress-broker-invalid', message: 'egress broker URL must use http or https' })
        }
        if (brokerUrl !== undefined && (brokerUrl.username !== '' || brokerUrl.password !== '')) {
          issues.push({ code: 'egress-broker-invalid', message: 'egress broker URL must not embed credentials' })
        }
        if (brokerUrl !== undefined) {
          const probe = options.probeBroker ?? (async (url: string): Promise<boolean> => {
            try {
              const response = await fetch(`${url.replace(/\/+$/u, '')}/healthz`, { signal: AbortSignal.timeout(5_000) })
              return response.ok
            } catch {
              // A broker that does not answer is unusable; preflight reports the
              // stable issue instead of exposing the network error.
              return false
            }
          })
          let healthy = false
          try {
            healthy = await probe(config.egressBrokerUrl)
          } catch {
            healthy = false
          }
          if (!healthy) {
            issues.push({ code: 'egress-broker-unavailable', message: 'egress broker health check failed' })
          }
        }
      }
    }
    const probe = options.probeDocker ?? probeDockerDaemon
    let available = false
    try {
      available = await probe(config.dockerCommand)
    } catch {
      available = false
    }
    if (!available) {
      issues.push({ code: 'docker-unavailable', message: 'the container daemon is not reachable' })
    }
  } else {
    issues.push({
      code: 'job-runner-insecure',
      message: 'process job isolation is not a physical fusion boundary; configure a container runner',
    })
  }
  const state: IntegrationState = issues.length === 0 ? 'ready' : 'blocked'
  return state === 'ready' ? { state, issues, registry } : { state, issues, ...(registry === undefined ? {} : { registry }) }
}

/** Resolve the real path of one existing root, for callers that need the canonical value. */
export function canonicalRoot(path: string): string {
  return realpathSync(resolve(path))
}
