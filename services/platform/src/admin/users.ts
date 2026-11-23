/**
 * Administrative user and session controls.
 *
 * Operators can disable an account (reject every later authentication and revoke
 * its live sessions), re-enable it, or revoke every session of one account
 * without disabling it. These commands only change the identity database; the
 * gateway re-validates each HTTP request and each WebSocket on its configured
 * revalidation period, so a running deployment observes the change without a
 * restart.
 *
 * @module @deepseek-ai/dsh-platform-services/admin/users
 */

import type { IdentityConfig } from '../config.ts'
import type { PlatformUser } from '../contracts.ts'
import { withIdentityStore } from '../identity/lookup.ts'
import { toPlatformUser } from '../identity/security.ts'

/** Stable failure codes of the administrative user commands. */
export type UserAdminFailureCode =
  /** Neither a stable W3 subject nor an internal user id selected a target. */
  | 'admin-target-required'
  /** The selector does not resolve to a platform user. */
  | 'admin-user-unknown'
  /** A destructive command was invoked without explicit confirmation. */
  | 'admin-confirm-required'

/** Typed refusal of an administrative user command. */
export class UserAdminError extends Error {
  /** Stable machine code safe to compare and print. */
  readonly code: UserAdminFailureCode

  /**
   * @param code - stable machine code.
   * @param message - operator-actionable description without user data.
   */
  constructor(code: UserAdminFailureCode, message: string) {
    super(message)
    this.name = 'UserAdminError'
    this.code = code
  }
}

/** One administrative user/session operation. */
export interface UserAdminRequest {
  /** Identity configuration of the deployment. */
  readonly identity: IdentityConfig
  /** Stable W3 subject; exclusive with `userId`. */
  readonly subject?: string | undefined
  /** Internal user id; exclusive with `subject`. */
  readonly userId?: string | undefined
  /** Confirmation required by destructive commands. */
  readonly confirm: boolean
}

/** Outcome of one administrative user/session operation. */
export interface UserAdminReport {
  /** Affected user. */
  readonly user: PlatformUser
  /** Account status after the operation. */
  readonly status: string
  /** Permission version after the operation. */
  readonly permissionVersion: number
  /** Sessions revoked by this invocation. */
  readonly sessionsRevoked: number
}

/**
 * Resolve the target user of an administrative command.
 * @param identity - identity configuration.
 * @param request - selector and confirmation.
 * @returns the resolved user row fields needed by the command.
 * @throws {UserAdminError} when the selector is missing or unknown.
 */
function requireTarget(identity: IdentityConfig, request: UserAdminRequest): PlatformUser {
  const bySubject = request.subject !== undefined && request.subject !== ''
  const byUser = request.userId !== undefined && request.userId !== ''
  if (bySubject === byUser) {
    throw new UserAdminError('admin-target-required', 'pass exactly one of --subject <w3-subject> or --user <internal-user-id>')
  }
  const user = withIdentityStore(identity, (store) => {
    const row = bySubject ? store.findUserBySubject(request.subject ?? '') : store.findUserById(request.userId ?? '')
    return row === undefined ? undefined : toPlatformUser(row)
  })
  if (user === undefined) throw new UserAdminError('admin-user-unknown', 'no platform user matches that selector')
  return user
}

/**
 * Require explicit confirmation for one destructive command.
 * @param request - administrative request.
 */
function requireConfirmation(request: UserAdminRequest): void {
  if (!request.confirm) throw new UserAdminError('admin-confirm-required', 're-run with --confirm to apply this change')
}

/**
 * Disable one account: subsequent authentication is refused and every live
 * session is revoked. The account row is kept so history stays attributable.
 * @param request - target selector and confirmation.
 * @returns the disabled user and the number of sessions revoked.
 * @throws {UserAdminError} when the target is unknown or confirmation is missing.
 */
export async function disableUser(request: UserAdminRequest): Promise<UserAdminReport> {
  const user = requireTarget(request.identity, request)
  requireConfirmation(request)
  return withIdentityStore(request.identity, (store) => {
    const now = new Date().toISOString()
    const revoked = store.revokeUserSessions(user.id, now)
    store.setUserStatus(user.id, 'disabled', now)
    const permissionVersion = store.bumpUserPermissionVersion(user.id, now)
    return { user, status: 'disabled', permissionVersion, sessionsRevoked: revoked }
  })
}

/**
 * Re-enable one disabled account. Existing sessions stay revoked; the user must
 * log in again to obtain a fresh session.
 * @param request - target selector and confirmation.
 * @returns the enabled user.
 * @throws {UserAdminError} when the target is unknown or confirmation is missing.
 */
export async function enableUser(request: UserAdminRequest): Promise<UserAdminReport> {
  const user = requireTarget(request.identity, request)
  requireConfirmation(request)
  return withIdentityStore(request.identity, (store) => {
    const now = new Date().toISOString()
    store.setUserStatus(user.id, 'active', now)
    const permissionVersion = store.bumpUserPermissionVersion(user.id, now)
    return { user, status: 'active', permissionVersion, sessionsRevoked: 0 }
  })
}

/**
 * Revoke every session of one account without disabling it. The user may log in
 * again normally; this is the "sign out of all devices" operator action.
 * @param request - target selector and confirmation.
 * @returns the affected user and the number of sessions revoked.
 * @throws {UserAdminError} when the target is unknown or confirmation is missing.
 */
export async function revokeAllUserSessions(request: UserAdminRequest): Promise<UserAdminReport> {
  const user = requireTarget(request.identity, request)
  requireConfirmation(request)
  return withIdentityStore(request.identity, (store) => {
    const now = new Date().toISOString()
    const revoked = store.revokeUserSessions(user.id, now)
    const permissionVersion = store.bumpUserPermissionVersion(user.id, now)
    return { user, status: 'active', permissionVersion, sessionsRevoked: revoked }
  })
}
