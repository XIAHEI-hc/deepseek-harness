/** Shared fixtures for system-fusion service tests. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadIntegrationConfig, runPreflight } from '../src/integration/index.ts'
import { createIntegrationService } from '../src/integration/service.ts'
import type { IntegrationConfig } from '../src/integration/config.ts'
import type { PlatformAuditEvent, PlatformHttpRequest, PlatformHttpResult, ValidatedSession } from '../src/contracts.ts'
import type { IntegrationService } from '../src/contracts.ts'
import type { DockerCommandResult, DockerExecutor } from '../src/runtime/backend.ts'

/** One test user id. */
export const USER_A = 'user-a'
/** A second test user id. */
export const USER_B = 'user-b'

/**
 * Build a validated session for one test user.
 * @param userId - internal user id.
 * @param permissionVersion - session permission version.
 * @returns the session.
 */
export function sessionFor(userId: string, permissionVersion = 1): ValidatedSession {
  return {
    user: {
      id: userId,
      subject: `w3-${userId}`,
      uid: `uid-${userId}`,
      displayName: `User ${userId}`,
      email: null,
    },
    sessionId: `session-${userId}`,
    permissionVersion,
    expiresAt: Date.now() + 3_600_000,
    absoluteExpiresAt: Date.now() + 7_200_000,
  }
}

/** Build one minimal Mock system document with per-user ACLs. */
export function mockSystemsDocument(): unknown {
  return {
    version: 1,
    systems: [
      {
        id: 'mock-erp',
        name: 'Mock ERP',
        adapter: 'mock',
        mockResources: [
          {
            id: 'sales-2026',
            name: 'Sales 2026',
            resourceType: 'dataset',
            version: '3',
            classification: 'internal',
            acl: { [USER_A]: ['list', 'read', 'export'], [USER_B]: ['list', 'read', 'export'] },
            content: { rows: [{ id: 1, amount: 42 }, { id: 2, amount: 7 }] },
          },
          {
            id: 'secret-plan',
            name: 'Secret plan',
            resourceType: 'source',
            version: '1',
            classification: 'confidential',
            acl: { [USER_A]: ['list', 'read'] },
            content: 'only user-a may read this',
          },
        ],
      },
    ],
  }
}

/** Shared surface of the test Docker executors. */
export interface TestAnalysisExecutor {
  readonly calls: string[][]
  execute(args: readonly string[]): Promise<DockerCommandResult>
}

/** A fake Docker executor that writes one artifact per successful job. */
export class FakeAnalysisExecutor implements TestAnalysisExecutor {
  readonly calls: string[][] = []
  readonly removed: string[][] = []
  exitCode = 0

  /**
   * @param args - Docker argv from the runner.
   * @returns a successful or configured failure result.
   */
  async execute(args: readonly string[]): Promise<DockerCommandResult> {
    this.calls.push([...args])
    if (args[0] === 'rm') {
      this.removed.push([...args])
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    const output = mountHostPath(args, ':/work:rw')
    const jobName = valueAfter(args, '--name') ?? 'analysis'
    if (this.exitCode === 0 && output !== undefined) {
      writeFileSync(join(output, 'report.json'), JSON.stringify({ job: jobName, ok: true }), { mode: 0o600 })
    }
    return {
      stdout: 'analysis complete',
      stderr: this.exitCode === 0 ? '' : 'analysis failed',
      exitCode: this.exitCode,
    }
  }
}

/**
 * Find the host side of one `-v host:container` mount.
 * @param args - Docker argv.
 * @param container - container-side suffix such as `/work:rw`.
 * @returns the host path.
 */
function mountHostPath(args: readonly string[], container: string): string | undefined {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== '-v') continue
    const value = args[index + 1]
    if (value !== undefined && value.endsWith(container)) return value.slice(0, -container.length)
  }
  return undefined
}

/**
 * Read the value after one flag.
 * @param args - Docker argv.
 * @param flag - flag name.
 * @returns the following token.
 */
function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index < 0 ? undefined : args[index + 1]
}

/** Executor that holds one run open until it is cancelled. */
export class CancellableAnalysisExecutor implements TestAnalysisExecutor {
  readonly calls: string[][] = []
  private releaseRun: ((result: DockerCommandResult) => void) | undefined

  /**
   * @param args - Docker argv.
   * @returns a run that settles only when `rm -f` arrives.
   */
  async execute(args: readonly string[]): Promise<DockerCommandResult> {
    this.calls.push([...args])
    if (args[0] === 'rm') {
      const release = this.releaseRun
      this.releaseRun = undefined
      release?.({ stdout: '', stderr: '', exitCode: 1 })
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    return await new Promise<DockerCommandResult>((resolve) => {
      this.releaseRun = resolve
    })
  }
}

/** One running test environment. */
export interface IntegrationTestEnvironment {
  readonly root: string
  readonly config: IntegrationConfig
  readonly service: IntegrationService
  readonly audit: PlatformAuditEvent[]
  readonly executor: TestAnalysisExecutor
  close(): Promise<void>
}

/**
 * Build a temp fusion service with a Mock system and a fake container executor.
 * @param options - executor override and registry document override.
 * @returns the environment.
 */
export async function createIntegrationTestEnvironment(options: {
  readonly executor?: TestAnalysisExecutor
  readonly systems?: unknown
} = {}): Promise<IntegrationTestEnvironment> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-integration-'))
  const systemsFile = join(root, 'systems.json')
  writeFileSync(systemsFile, JSON.stringify(options.systems ?? mockSystemsDocument(), null, 2), 'utf8')
  const dataDir = join(root, 'data')
  const config = loadIntegrationConfig({
    APP_ENV: 'testing',
    DSH_INTEGRATION_ENABLED: 'true',
    DSH_INTEGRATION_DATA_DIR: dataDir,
    DSH_INTEGRATION_SYSTEMS_FILE: systemsFile,
    DSH_INTEGRATION_JOB_RUNNER_KIND: 'container',
    DSH_INTEGRATION_JOB_IMAGE: 'dsh-analysis-test:local',
    DSH_INTEGRATION_JOB_NETWORK: 'none',
    DSH_INTEGRATION_JOB_UID: '1000',
  }, {
    appEnv: 'testing',
    dataDir,
    runtimeDockerCommand: 'docker',
  })
  const preflight = await runPreflight(config, { probeDocker: async () => true, allowUnsupportedHost: true })
  const audit: PlatformAuditEvent[] = []
  const executor = options.executor ?? new FakeAnalysisExecutor()
  const service = createIntegrationService(config, preflight, {
    audit: event => audit.push(event),
    dockerExecutor: executor.execute.bind(executor) as DockerExecutor,
  })
  return {
    root,
    config,
    service,
    audit,
    executor,
    async close(): Promise<void> {
      await service.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** One decoded fusion response. */
export interface TestResponse {
  readonly status: number
  readonly body: Record<string, unknown> | undefined
  readonly bytes: Uint8Array | undefined
}

/**
 * Call one fusion route.
 * @param service - running fusion service.
 * @param session - authenticated session.
 * @param method - HTTP method.
 * @param path - path and query below the gateway origin.
 * @param body - optional JSON body.
 * @returns the decoded response.
 */
export async function callFusion(
  service: IntegrationService,
  session: ValidatedSession,
  method: string,
  path: string,
  body?: unknown,
): Promise<TestResponse> {
  const request: PlatformHttpRequest = {
    method,
    url: new URL(`http://platform.test${path}`),
    headers: {},
    cookies: {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
  const result: PlatformHttpResult | undefined = await service.handle(request, session)
  if (result === undefined) return { status: 0, body: undefined, bytes: undefined }
  const bodyValue: unknown = result.body === undefined ? undefined : JSON.parse(result.body)
  if (bodyValue !== undefined && (typeof bodyValue !== 'object' || bodyValue === null || Array.isArray(bodyValue))) {
    throw new Error('fusion test response body is not an object')
  }
  return {
    status: result.status,
    body: bodyValue === undefined ? undefined : bodyValue as Record<string, unknown>,
    bytes: result.bodyBytes,
  }
}

/**
 * Poll one job until it is no longer queued or running.
 * @param service - running fusion service.
 * @param session - authenticated session.
 * @param jobId - job id.
 * @returns the settled job object.
 */
export async function waitForJob(
  service: IntegrationService,
  session: ValidatedSession,
  jobId: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await callFusion(service, session, 'GET', `/api/integration/jobs/${jobId}`)
    const job = response.body?.['job']
    if (job !== undefined && typeof job === 'object' && job !== null && !Array.isArray(job)) {
      const record = job as Record<string, unknown>
      if (record['status'] !== 'queued' && record['status'] !== 'running') return record
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('analysis job did not settle')
}
