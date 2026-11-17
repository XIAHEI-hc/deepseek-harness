/** Trusted-proxy identity provider for instances reached only through a gateway. */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ConnectionTrustRequest, PeerScope } from '@deepseek-ai/dsh-client-connection'
import { readAssertion, verifyAssertion, type AssertionPolicy } from './assertion.ts'

/** Stable plugin name. */
export const name = 'host-authentication-gateway'
/** Admitted requests speak for a Peer this plugin owns, so Connection must be present. */
export const inject = ['connection', 'connection.authentication']

/** Deployment identity this instance accepts from its trusted proxy. */
export interface Config {
  /** Shared HMAC secret with the proxy; at least 32 characters. */
  secret: string
  /** Deployment audience the proxy signs; one audience per fleet. */
  audience: string
  /** The identity-provider subject this instance serves; every other subject is refused. */
  subject: string
  /** Header carrying the assertion; default `x-dsh-gateway-identity`. */
  headerName: string
  /** Accepted clock difference in seconds; default 30. */
  clockSkewSeconds: number
  /** Longest accepted assertion lifetime in seconds; default 300. */
  maxLifetimeSeconds: number
}

/** Validate the deployment identity before any request is admitted. */
export const Config: z<Config> = z.object({
  secret: z.string().min(32).required(),
  audience: z.string().min(1).required(),
  subject: z.string().min(1).required(),
  headerName: z.string().min(1).default('x-dsh-gateway-identity'),
  clockSkewSeconds: z.natural().default(30),
  maxLifetimeSeconds: z.natural().min(1).default(300),
})

/**
 * Register an authentication provider that admits only requests carrying a verifiable
 * assertion for this instance's audience and subject.
 * @param ctx - plugin scope owning the Peer and the provider registration.
 * @param config - secret, audience, served subject, and accepted time window.
 */
export function apply(ctx: Context, config: Config): void {
  const policy: AssertionPolicy = {
    secret: config.secret,
    audience: config.audience,
    subject: config.subject,
    clockSkewSeconds: config.clockSkewSeconds,
    maxLifetimeSeconds: config.maxLifetimeSeconds,
  }
  // One Peer per instance: the gateway already resolved the browser to this subject, and
  // an owner Peer is what keeps approvals, questions, and remote access working.
  const peer: PeerScope = ctx.connection.createPeer({ principal: { kind: 'owner' } })
  ctx.connection.authentication.register({
    authenticate(request: ConnectionTrustRequest) {
      const assertion = readAssertion(request.headers, config.headerName)
      if (assertion === undefined) return undefined
      const result = verifyAssertion(assertion, policy)
      if (!result.ok) {
        ctx.logger.warn(`host-authentication-gateway: refused assertion (${result.reason})`)
        return undefined
      }
      return peer
    },
  })
}
