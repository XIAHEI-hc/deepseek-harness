/**
 * Read-only administrative access to the identity audit stream.
 *
 * The identity surface appends login, logout, rate-limit, and administrative
 * events to `dsh_audit_events`; this module exposes them for operators through
 * `dsh-platform admin audit list`, which runs against the same database file.
 *
 * @module @deepseek-ai/dsh-platform-services/admin/audit
 */

import type { IdentityConfig } from '../config.ts'
import { withIdentityStore } from '../identity/lookup.ts'
import type { AuditRow } from '../identity/store.ts'

/** One audit-list request. */
export interface AuditListRequest {
  /** Identity configuration of the deployment. */
  readonly identity: IdentityConfig
  /** Maximum rows to print; defaults to 100 and is clamped by the store. */
  readonly limit?: number | undefined
  /** Rows to skip before printing. */
  readonly offset?: number | undefined
}

/**
 * Read the newest audit events.
 * @param request - identity configuration and paging.
 * @returns audit rows, newest first.
 */
export async function listAuditEvents(request: AuditListRequest): Promise<readonly AuditRow[]> {
  return withIdentityStore(request.identity, store => store.listAudit(request.limit ?? 100, request.offset ?? 0))
}
