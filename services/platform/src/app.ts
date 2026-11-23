/**
 * Composition root for the DSH platform services.
 *
 * One process serves the public gateway, the identity service, and the per-user
 * runtime supervisor. Splitting them into separate processes is a deployment
 * choice the modules already allow: each factory takes its own config and its
 * dependencies as values.
 *
 * @module @deepseek-ai/dsh-platform-services/app
 */

import { join } from 'node:path'
import { createPlatformConfig, ensureGatewayKeyPair, loadPlatformConfig, type PlatformConfig } from './config.ts'
import { createGateway, type GatewayHandle } from './gateway/index.ts'
import { createIdentityService } from './identity/index.ts'
import { createIntegrationService, runPreflight } from './integration/index.ts'
import { createRuntimeManager } from './runtime/index.ts'
import type { IdentityService, IntegrationService, RuntimeManager } from './contracts.ts'

/** Everything a running platform process owns. */
export interface PlatformApp {
  readonly config: PlatformConfig
  readonly identity: IdentityService
  readonly runtime: RuntimeManager
  /** Present only when `DSH_INTEGRATION_ENABLED=true`. */
  readonly integration: IntegrationService | undefined
  readonly gateway: GatewayHandle
  /**
   * Start the public listener.
   * @returns the actual bound host and port.
   */
  listen(): Promise<{ host: string; port: number }>
  /** Stop the listener, every runtime this supervisor started, and the databases. */
  close(): Promise<void>
}

/** Explicit composition overrides for embedded deployments and probes. */
export interface PlatformAppOptions {
  /**
   * Extra environment copied into every runtime when the process backend runs.
   * Used by embedded deployments to supply model-provider settings and by
   * probes to point the runtime at a scripted provider; the container backend
   * rejects it.
   */
  readonly runtimeEnv?: Readonly<Record<string, string>>
}

/**
 * Wire the identity, runtime, and gateway services from one configuration.
 * @param config - resolved platform configuration; defaults to the environment.
 * @param options - explicit composition overrides for embedded deployments and probes.
 * @returns the composed application, not yet listening.
 */
export async function createPlatformApp(
  config: PlatformConfig = loadPlatformConfig(),
  options: PlatformAppOptions = {},
): Promise<PlatformApp> {
  const keys = ensureGatewayKeyPair(config.gateway)
  const identity = await createIdentityService(config.identity)
  const runtime = await createRuntimeManager(
    { ...config.runtime, dataDir: config.dataDir, realm: config.realm },
    {
      // Assertion facts the supervisor stamps on every runtime it starts.
      runtimeAuth: {
        publicKeyFile: keys.publicKeyFile,
        issuer: config.gateway.issuer,
        audience: config.gateway.audience,
        keyId: config.gateway.keyId,
        replayWindowSeconds: config.gateway.replayWindowSeconds,
        maxLifetimeSeconds: config.gateway.maxAssertionLifetimeSeconds,
      },
      publicOrigin: config.gateway.publicOrigin,
      publicAuthority: config.runtime.publicAuthority,
      dataDir: join(config.dataDir, 'runtime'),
      audit: (event) => {
        identity.recordAudit({
          action: event.action,
          outcome: event.outcome,
          userId: event.userId,
          detail: {
            generation: event.generation,
            errorCode: event.errorCode,
            runtimeId: event.runtimeId,
          },
        })
      },
      ...(options.runtimeEnv === undefined ? {} : { runtimeEnv: options.runtimeEnv }),
    },
  )
  let integration: IntegrationService | undefined
  if (config.integration.enabled) {
    const preflight = await runPreflight(config.integration)
    integration = createIntegrationService(config.integration, preflight, {
      audit: (event) => {
        identity.recordAudit(event)
      },
    })
  }
  const gateway = await createGateway(config, {
    identity,
    runtime,
    ...(integration === undefined ? {} : { integration }),
  })
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await gateway.close().catch(() => undefined)
    await integration?.close().catch(() => undefined)
    await runtime.close().catch(() => undefined)
    await identity.close().catch(() => undefined)
  }
  return {
    config,
    identity,
    runtime,
    integration,
    gateway,
    listen: () => gateway.listen(),
    close,
  }
}

/** Build a testing configuration without reading the process environment. */
export { createPlatformConfig }
