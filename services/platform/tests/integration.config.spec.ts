/** System-fusion configuration defaults and fail-closed parsing. */
import { describe, expect, it } from 'vitest'
import { createPlatformConfig } from '../src/config.ts'
import { IntegrationConfigError, loadIntegrationConfig } from '../src/integration/config.ts'

describe('loadIntegrationConfig', () => {
  it('is off by default and points at data-directory paths', () => {
    const config = loadIntegrationConfig({}, { appEnv: 'development', dataDir: 'C:/tmp/platform', runtimeDockerCommand: 'docker' })
    expect(config.enabled).toBe(false)
    expect(config.runnerKind).toBe('process')
    expect(config.snapshotsRoot.endsWith('integration\\snapshots') || config.snapshotsRoot.endsWith('integration/snapshots')).toBe(true)
    expect(config.jobNetwork).toBe('none')
  })

  it('ignores stale invalid fusion settings while disabled', () => {
    const config = loadIntegrationConfig({
      DSH_INTEGRATION_ENABLED: 'false',
      DSH_INTEGRATION_JOB_NETWORK: 'host',
      DSH_INTEGRATION_JOB_MEMORY_MB: 'not-a-number',
      DSH_INTEGRATION_JOB_RUNNER_KIND: 'lambda',
    }, { appEnv: 'testing', dataDir: 'C:/tmp/platform', runtimeDockerCommand: 'docker' })
    expect(config.enabled).toBe(false)
    expect(config.jobNetwork).toBe('none')
  })

  it('refuses the process runner in production even when fusion is enabled', () => {
    expect(() => loadIntegrationConfig({
      APP_ENV: 'production',
      DSH_INTEGRATION_ENABLED: 'true',
      DSH_INTEGRATION_JOB_RUNNER_KIND: 'process',
    }, { appEnv: 'production', dataDir: '/srv/dsh', runtimeDockerCommand: 'docker' })).toThrow(/container in production/u)
  })

  it('refuses a host or shared Docker network for analysis jobs', () => {
    for (const network of ['host', 'bridge', 'default']) {
      expect(() => loadIntegrationConfig({
        DSH_INTEGRATION_ENABLED: 'true',
        DSH_INTEGRATION_JOB_NETWORK: network,
      }, { appEnv: 'testing', dataDir: 'C:/tmp/platform', runtimeDockerCommand: 'docker' }))
        .toThrow(IntegrationConfigError)
    }
  })

  it('refuses unknown runner kinds and malformed integers', () => {
    expect(() => loadIntegrationConfig({
      DSH_INTEGRATION_ENABLED: 'true',
      DSH_INTEGRATION_JOB_RUNNER_KIND: 'lambda',
    }, { appEnv: 'testing', dataDir: 'C:/tmp/platform', runtimeDockerCommand: 'docker' })).toThrow(/process or container/u)
    expect(() => loadIntegrationConfig({
      DSH_INTEGRATION_ENABLED: 'true',
      DSH_INTEGRATION_JOB_MEMORY_MB: '0',
    }, { appEnv: 'testing', dataDir: 'C:/tmp/platform', runtimeDockerCommand: 'docker' })).toThrow(/positive integer/u)
  })
})

describe('createPlatformConfig integration overrides', () => {
  it('merges fusion overrides without disturbing the rest of the platform', () => {
    const config = createPlatformConfig({
      integration: {
        enabled: true,
        jobImage: 'dsh-analysis:test',
        runnerKind: 'container',
      },
    })
    expect(config.integration.enabled).toBe(true)
    expect(config.integration.jobImage).toBe('dsh-analysis:test')
    expect(config.runtime.kind).toBe('process')
  })
})
