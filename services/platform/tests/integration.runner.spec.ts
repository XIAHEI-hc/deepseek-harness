/** Analysis container argv: every physical boundary is present. */
import { describe, expect, it } from 'vitest'
import { loadIntegrationConfig } from '../src/integration/config.ts'
import { analysisContainerName, buildAnalysisRunArguments } from '../src/integration/runner.ts'

const config = loadIntegrationConfig({
  APP_ENV: 'testing',
  DSH_INTEGRATION_ENABLED: 'true',
  DSH_INTEGRATION_JOB_RUNNER_KIND: 'container',
  DSH_INTEGRATION_JOB_IMAGE: 'dsh-analysis@sha256:' + 'a'.repeat(64),
  DSH_INTEGRATION_JOB_NETWORK: 'none',
  DSH_INTEGRATION_JOB_UID: '1000',
  DSH_INTEGRATION_JOB_CPU_LIMIT: '2',
  DSH_INTEGRATION_JOB_MEMORY_MB: '512',
  DSH_INTEGRATION_JOB_PIDS_LIMIT: '128',
}, { appEnv: 'testing', dataDir: 'C:/tmp/platform', runtimeDockerCommand: 'docker' })

const spec = {
  jobId: '11111111-2222-3333-4444-555555555555',
  inputsDirectory: 'C:/tmp/job/inputs',
  outputDirectory: 'C:/tmp/job/output',
  scratchDirectory: 'C:/tmp/job/scratch',
  language: 'shell' as const,
}

describe('analysis container argv', () => {
  it('denies network, privilege, and host writes by construction', () => {
    const args = buildAnalysisRunArguments(config, spec)
    expect(args.slice(0, 2)).toEqual(['run', '--rm'])
    expect(args).toContain('--network')
    expect(args[args.indexOf('--network') + 1]).toBe('none')
    expect(args).toContain('--read-only')
    expect(args).toContain('--user')
    expect(args[args.indexOf('--user') + 1]).toBe('1000:1000')
    expect(args).toContain('--cap-drop')
    expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL')
    expect(args).toContain('--security-opt')
    expect(args[args.indexOf('--security-opt') + 1]).toBe('no-new-privileges:true')
    expect(args).toContain('--pids-limit')
    expect(args[args.indexOf('--pids-limit') + 1]).toBe('128')
    expect(args).toContain('--memory')
    expect(args[args.indexOf('--memory') + 1]).toBe('512m')
    expect(args).toContain('--cpus')
    expect(args[args.indexOf('--cpus') + 1]).toBe('2')
    expect(args).toContain('C:/tmp/job/inputs:/inputs:ro')
    expect(args).toContain('C:/tmp/job/output:/work:rw')
    expect(args).toContain('C:/tmp/job/scratch:/scratch:rw')
    expect(args).toContain('--entrypoint')
    expect(args[args.indexOf('--entrypoint') + 1]).toBe('')
    expect(args.join(' ')).not.toContain('docker.sock')
    expect(args.join(' ')).not.toContain('/var/run')
    expect(args).toContain('dsh-analysis@sha256:' + 'a'.repeat(64))
  })

  it('adds proxy variables only when a controlled broker is configured', () => {
    const brokered = loadIntegrationConfig({
      APP_ENV: 'testing',
      DSH_INTEGRATION_ENABLED: 'true',
      DSH_INTEGRATION_JOB_RUNNER_KIND: 'container',
      DSH_INTEGRATION_JOB_IMAGE: 'dsh-analysis@sha256:' + 'a'.repeat(64),
      DSH_INTEGRATION_JOB_NETWORK: 'dsh-fusion-egress',
      DSH_INTEGRATION_EGRESS_BROKER_URL: 'http://fusion-broker:3128',
    }, { appEnv: 'testing', dataDir: 'C:/tmp/platform', runtimeDockerCommand: 'docker' })
    const args = buildAnalysisRunArguments(brokered, spec)
    expect(args[args.indexOf('--network') + 1]).toBe('dsh-fusion-egress')
    expect(args).toContain('HTTP_PROXY=http://fusion-broker:3128')
    expect(args).toContain('HTTPS_PROXY=http://fusion-broker:3128')
    expect(args).toContain('NO_PROXY=127.0.0.1,localhost')
  })

  it('uses the requested interpreter and a stable container name', () => {
    const python = buildAnalysisRunArguments(config, { ...spec, language: 'python' })
    expect(python.slice(-2)).toEqual(['python3', '/scratch/run.py'])
    expect(analysisContainerName(spec.jobId)).toBe('dsh-analysis-111111112222333344445555')
  })
})
