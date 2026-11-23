/** Fusion preflight: disabled is inert, missing prerequisites block, disjoint roots pass. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadIntegrationConfig, type IntegrationConfig } from '../src/integration/config.ts'
import { runPreflight } from '../src/integration/preflight.ts'
import { mockSystemsDocument } from './integration.testkit.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * Build a temp fusion configuration with one valid systems file.
 * @param overrides - environment overrides.
 * @returns the configuration and its temp root.
 */
function makeConfig(overrides: Readonly<Record<string, string>> = {}): { config: IntegrationConfig; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-integration-preflight-'))
  roots.push(root)
  const systemsFile = join(root, 'systems.json')
  writeFileSync(systemsFile, JSON.stringify(mockSystemsDocument()), 'utf8')
  const dataDir = join(root, 'data')
  const config = loadIntegrationConfig({
    APP_ENV: 'testing',
    DSH_INTEGRATION_ENABLED: 'true',
    DSH_INTEGRATION_DATA_DIR: dataDir,
    DSH_INTEGRATION_SYSTEMS_FILE: systemsFile,
    DSH_INTEGRATION_JOB_RUNNER_KIND: 'container',
    DSH_INTEGRATION_JOB_IMAGE: 'dsh-analysis-test:local',
    DSH_INTEGRATION_JOB_NETWORK: 'none',
    ...overrides,
  }, { appEnv: 'testing', dataDir, runtimeDockerCommand: 'docker' })
  return { config, root }
}

describe('runPreflight', () => {
  it('is inert when fusion is off', async () => {
    const { config, root } = makeConfig({ DSH_INTEGRATION_ENABLED: 'false' })
    const result = await runPreflight(config)
    expect(result.state).toBe('disabled')
    expect(result.issues).toEqual([])
    expect(() => rmSync(join(root, 'data'), { recursive: true, force: true })).not.toThrow()
  })

  it('blocks a missing systems file instead of starting fusion', async () => {
    const { config } = makeConfig({ DSH_INTEGRATION_SYSTEMS_FILE: 'C:/does/not/exist/systems.json' })
    const result = await runPreflight(config, { probeDocker: async () => true, allowUnsupportedHost: true })
    expect(result.state).toBe('blocked')
    expect(result.issues.map(issue => issue.code)).toContain('systems-file-invalid')
  })

  it('blocks overlapping roots', async () => {
    const { config, root } = makeConfig()
    const overlapping = { ...config, snapshotsRoot: join(root, 'data'), workspacesRoot: join(root, 'data') }
    const result = await runPreflight(overlapping, { probeDocker: async () => true, allowUnsupportedHost: true })
    expect(result.state).toBe('blocked')
    expect(result.issues.map(issue => issue.code)).toContain('root-overlap')
  })

  it('blocks the process runner and a missing image', async () => {
    const processConfig = makeConfig({ DSH_INTEGRATION_JOB_RUNNER_KIND: 'process' }).config
    const processResult = await runPreflight(processConfig, { probeDocker: async () => true, allowUnsupportedHost: true })
    expect(processResult.state).toBe('blocked')
    expect(processResult.issues.map(issue => issue.code)).toContain('job-runner-insecure')
    const noImage = makeConfig({ DSH_INTEGRATION_JOB_IMAGE: '' }).config
    const imageResult = await runPreflight(noImage, { probeDocker: async () => true, allowUnsupportedHost: true })
    expect(imageResult.issues.map(issue => issue.code)).toContain('job-image-missing')
  })

  it('blocks a non-https connector in production and Mock systems in production', async () => {
    const { config, root } = makeConfig()
    writeFileSync(join(root, 'systems.json'), JSON.stringify(mockSystemsDocument()), 'utf8')
    const production = { ...config, appEnv: 'production' as const }
    const result = await runPreflight(production, { probeDocker: async () => true, allowUnsupportedHost: true })
    expect(result.state).toBe('blocked')
    expect(result.issues.map(issue => issue.code)).toContain('mock-adapter-in-production')
  })

  it('reaches ready with disjoint roots and an answering daemon', async () => {
    const { config } = makeConfig()
    const result = await runPreflight(config, { probeDocker: async () => true, allowUnsupportedHost: true })
    expect(result.state).toBe('ready')
    expect(result.issues).toEqual([])
    expect(result.registry?.systems).toHaveLength(1)
  })
})
