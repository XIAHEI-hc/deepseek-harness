/**
 * W3/Mock identity core for the standalone multi-user platform.
 *
 * The service owns the DSH user, session, OAuth login transaction, and CSRF state
 * in an SQLite database under `config.dataDir`, exposing the `/auth/*` and
 * `/internal/*` surfaces plus session resolution and CSRF verification to the
 * gateway. The lookup helpers serve one-shot administrative commands.
 *
 * @module @deepseek-ai/dsh-platform-services/identity
 */

export { createIdentityService } from './http.ts'
export type { CreateIdentityServiceOptions } from './http.ts'
export { findPlatformUserById, findPlatformUserBySubject } from './lookup.ts'
