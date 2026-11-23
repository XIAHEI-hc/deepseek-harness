/**
 * Executable entry for the DSH platform services.
 *
 * `--check` validates the configuration and exits, so a deployment can fail a
 * health gate before binding a public port. The default mode starts the public
 * gateway and keeps it until SIGINT or SIGTERM.
 *
 * @module @deepseek-ai/dsh-platform-services/main
 */

import { createPlatformApp } from './app.ts'
import { loadPlatformConfig, PlatformConfigError } from './config.ts'

/**
 * Validate and report the effective configuration without starting anything.
 * @param argv - process arguments after the script path.
 * @returns the process exit code.
 */
function runCheck(argv: readonly string[]): number {
  try {
    const config = loadPlatformConfig()
    const summary = {
      appEnv: config.appEnv,
      authMode: config.identity.mode,
      runtimeKind: config.runtime.kind,
      dataDir: config.dataDir,
      publicOrigin: config.gateway.publicOrigin,
      listen: `${config.gateway.listenHost}:${String(config.gateway.listenPort)}`,
      spacesRoot: config.runtime.root,
    }
    if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    else process.stdout.write(`dsh platform configuration is valid (${summary.appEnv}, ${summary.authMode}, ${summary.runtimeKind})\n`)
    return 0
  } catch (error) {
    if (error instanceof PlatformConfigError) {
      process.stderr.write(`${error.message}\n`)
      return 2
    }
    throw error
  }
}

/** Start the platform and wire shutdown signals. @param argv - process arguments. */
async function run(argv: readonly string[]): Promise<void> {
  if (argv.includes('--check')) {
    process.exitCode = runCheck(argv)
    return
  }
  const config = loadPlatformConfig()
  const app = await createPlatformApp(config)
  const bound = await app.listen()
  process.stdout.write(`dsh platform gateway listening on http://${bound.host}:${String(bound.port)} (mode ${config.identity.mode}, runtime ${config.runtime.kind})\n`)
  let stopping = false
  const shutdown = (signal: string): void => {
    if (stopping) return
    stopping = true
    process.stdout.write(`dsh platform: ${signal} received, shutting down\n`)
    void app.close().then(() => process.exit(0)).catch((error: unknown) => {
      process.stderr.write(`dsh platform shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    })
  }
  process.on('SIGINT', () => { shutdown('SIGINT') })
  process.on('SIGTERM', () => { shutdown('SIGTERM') })
}

await run(process.argv.slice(2))
