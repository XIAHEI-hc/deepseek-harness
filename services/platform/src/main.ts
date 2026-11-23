/**
 * Executable entry for the DSH platform services.
 *
 * `--check` validates the configuration and exits, so a deployment can fail a
 * health gate before binding a public port. `admin migrate-home` attributes a
 * legacy single-user DSH home to one platform user. The default mode starts the
 * public gateway and keeps it until SIGINT or SIGTERM.
 *
 * @module @deepseek-ai/dsh-platform-services/main
 */

import { createPlatformApp } from './app.ts'
import { migrateHome, MigrationError } from './admin/migrate-home.ts'
import { disableUser, enableUser, revokeAllUserSessions, UserAdminError, type UserAdminRequest } from './admin/users.ts'
import { loadPlatformConfig, PlatformConfigError, type PlatformConfig } from './config.ts'

/**
 * Read one `--flag value` argument.
 * @param argv - admin arguments.
 * @param name - flag name including the leading dashes.
 * @returns the value, or undefined when absent.
 */
function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

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

/**
 * Print the admin command help.
 * @returns the process exit code.
 */
function printAdminHelp(): number {
  process.stdout.write([
    'usage: dsh-platform admin <command> [options]',
    '',
    '  migrate-home --from <legacy-dsh-home> (--subject <w3-subject> | --user <user-id>) [--confirm] [--overwrite]',
    '      attribute a legacy single-user DSH home to one platform user (default dry run)',
    '',
    '  user disable (--subject <w3-subject> | --user <user-id>) --confirm',
    '      disable an account: refuse later authentication and revoke every live session',
    '  user enable (--subject <w3-subject> | --user <user-id>) --confirm',
    '      re-enable a disabled account; existing sessions stay revoked',
    '  session revoke-all (--subject <w3-subject> | --user <user-id>) --confirm',
    '      revoke every live session without disabling the account',
    '',
  ].join('\n'))
  return 0
}

/**
 * Build the selector/confirmation facts of one user admin command.
 * @param argv - admin arguments including the subcommand.
 * @returns the request fields for the admin module.
 */
function userAdminRequest(config: PlatformConfig, argv: readonly string[]): UserAdminRequest {
  return {
    identity: config.identity,
    subject: flagValue(argv, '--subject'),
    userId: flagValue(argv, '--user'),
    confirm: argv.includes('--confirm'),
  }
}

/**
 * Run one user or session administrative command.
 * @param argv - admin arguments including the subcommand.
 * @param config - validated platform configuration.
 * @returns the process exit code.
 */
async function runUserAdmin(argv: readonly string[], config: PlatformConfig): Promise<number> {
  const command = argv[0]
  const subcommand = argv[1]
  try {
    let report
    if (command === 'user' && subcommand === 'disable') {
      report = await disableUser(userAdminRequest(config, argv))
    } else if (command === 'user' && subcommand === 'enable') {
      report = await enableUser(userAdminRequest(config, argv))
    } else if (command === 'session' && subcommand === 'revoke-all') {
      report = await revokeAllUserSessions(userAdminRequest(config, argv))
    } else {
      process.stderr.write(`unknown admin command ${JSON.stringify([command, subcommand])}\n`)
      return 2
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.stdout.write(`${command} ${subcommand ?? ''}: user ${report.user.id} is ${report.status}, permission version ${String(report.permissionVersion)}, ${String(report.sessionsRevoked)} session(s) revoked\n`)
    return 0
  } catch (error) {
    if (error instanceof UserAdminError) {
      process.stderr.write(`admin ${command} ${subcommand ?? ''}: ${error.code}: ${error.message}\n`)
      return error.code === 'admin-confirm-required' ? 3 : 2
    }
    throw error
  }
}

/**
 * Run one administrative command.
 * @param argv - admin arguments without the leading `admin` token.
 * @param config - validated platform configuration.
 * @returns the process exit code.
 */
async function runAdmin(argv: readonly string[], config: PlatformConfig): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') return printAdminHelp()
  if (argv[0] === 'user' || argv[0] === 'session') return runUserAdmin(argv, config)
  if (argv[0] !== 'migrate-home') {
    process.stderr.write(`unknown admin command ${JSON.stringify(argv[0])}\n`)
    return 2
  }
  const from = flagValue(argv, '--from')
  if (from === undefined) {
    process.stderr.write('admin migrate-home: --from <path> is required\n')
    return 2
  }
  try {
    const report = await migrateHome({
      platform: {
        identity: config.identity,
        runtime: config.runtime,
        realm: config.realm,
        dataDir: config.dataDir,
      },
      from,
      subject: flagValue(argv, '--subject'),
      userId: flagValue(argv, '--user'),
      confirm: argv.includes('--confirm'),
      overwrite: argv.includes('--overwrite'),
    })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (report.dryRun) {
      process.stdout.write(`dry run: ${String(report.entries.length)} entries would be copied to ${report.targetDshHome}; re-run with --confirm to write\n`)
    } else {
      process.stdout.write(`migrated ${String(report.copied.length)} entries to ${report.targetDshHome} (manifest: ${report.manifestFile ?? 'none'})\n`)
    }
    return 0
  } catch (error) {
    if (error instanceof MigrationError) {
      process.stderr.write(`admin migrate-home: ${error.code}: ${error.message}\n`)
      return error.code === 'migration-conflicts' ? 3 : 2
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
  if (argv[0] === 'admin') {
    process.exitCode = await runAdmin(argv.slice(1), config)
    return
  }
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
