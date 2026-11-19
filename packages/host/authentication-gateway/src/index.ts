/** Trusted-proxy identity provider for instances reached only through a gateway. */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ConnectionTrustRequest, PeerScope } from '@deepseek-ai/dsh-client-connection'
import {
  readAssertion,
  resolveVerificationMaterial,
  verifyGatewayAssertion,
  type AssertionAlgorithm,
  type GatewayAssertionPolicy,
  type VerificationConfig,
  type VerificationMaterial,
} from './assertion.ts'
import { ReplayWindow } from './replay.ts'

/** Stable plugin name. */
export const name = 'host-authentication-gateway'
/** Admitted requests speak for a Peer this plugin owns, so Connection must be present. */
export const inject = ['connection', 'connection.authentication']

/** Signature algorithm used for version 2 assertions when the config omits it. */
const DEFAULT_ALGORITHM: AssertionAlgorithm = 'hmac-sha256'
/** Replay window used when the config omits it; zero accepts repeated assertion ids. */
const DEFAULT_REPLAY_WINDOW_SECONDS = 0
/** Assertion header used when the config omits it. */
const DEFAULT_HEADER_NAME = 'x-dsh-gateway-identity'
/** Accepted clock skew used when the config omits it. */
const DEFAULT_CLOCK_SKEW_SECONDS = 30
/** Longest accepted assertion lifetime used when the config omits it. */
const DEFAULT_MAX_LIFETIME_SECONDS = 300

/** Deployment identity this instance accepts from its trusted proxy. */
export interface Config {
  /** Signature algorithm for version 2 assertions; default `hmac-sha256`. */
  algorithm?: AssertionAlgorithm
  /** Shared HMAC secret with the proxy; required for `hmac-sha256`, at least 32 characters. */
  secret?: string
  /** PEM Ed25519 public key text the proxy signs with; used for `ed25519`. */
  publicKey?: string
  /** Path to a PEM Ed25519 public key; used for `ed25519` when `publicKey` is absent. */
  publicKeyFile?: string
  /** Signing key id version 2 assertions must carry; every other `kid` is refused. */
  keyId?: string
  /** Issuer version 2 assertions must carry; every other `iss` is refused. */
  issuer?: string
  /** Runtime generation version 2 assertions must carry; every other `gen` is refused. */
  generation?: number
  /** Seconds each accepted version 2 assertion id stays remembered; default `0` disables replay rejection. */
  replayWindowSeconds?: number
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

/**
 * Validate the deployment identity before any request is admitted.
 *
 * Cross-field rules — an Ed25519 deployment needs a readable public key, an HMAC one needs
 * a usable secret — are resolved by {@link apply}, which fails the plugin load with a
 * descriptive error instead of admitting nothing. This schema stays a plain object so the
 * statically generated configuration catalog can walk it.
 */
export const Config: z<Config> = z.object({
  // Optional-by-omission fields carry no schema default: their defaults are applied when the
  // policy is resolved, which keeps the declared type honestly optional.
  algorithm: z.union(['hmac-sha256', 'ed25519'] as const),
  secret: z.string().min(32),
  publicKey: z.string().min(1),
  publicKeyFile: z.string().min(1),
  keyId: z.string().min(1),
  issuer: z.string().min(1),
  generation: z.natural().min(1),
  replayWindowSeconds: z.natural(),
  audience: z.string().min(1).required(),
  subject: z.string().min(1).required(),
  headerName: z.string().min(1).default(DEFAULT_HEADER_NAME),
  clockSkewSeconds: z.natural().default(DEFAULT_CLOCK_SKEW_SECONDS),
  maxLifetimeSeconds: z.natural().min(1).default(DEFAULT_MAX_LIFETIME_SECONDS),
})

/**
 * Narrow a config to the verification material fields.
 * @param config - deployment identity, possibly without the schema-applied algorithm default.
 * @returns the algorithm and key material the config names.
 */
function resolveVerificationConfig(config: Config): VerificationConfig {
  return {
    algorithm: config.algorithm ?? DEFAULT_ALGORITHM,
    secret: config.secret,
    publicKey: config.publicKey,
    publicKeyFile: config.publicKeyFile,
  }
}

/**
 * Resolve the config into the policy every request is verified against.
 * @param config - deployment identity and the accepted claims it configures.
 * @returns the policy, including the replay window this instance owns.
 */
function resolveAssertionPolicy(config: Config): GatewayAssertionPolicy {
  const material: VerificationMaterial = resolveVerificationMaterial(resolveVerificationConfig(config))
  const replayWindowSeconds = config.replayWindowSeconds ?? DEFAULT_REPLAY_WINDOW_SECONDS
  return {
    ...material,
    audience: config.audience,
    subject: config.subject,
    clockSkewSeconds: config.clockSkewSeconds,
    maxLifetimeSeconds: config.maxLifetimeSeconds,
    keyId: config.keyId,
    issuer: config.issuer,
    generation: config.generation,
    replay: replayWindowSeconds > 0 ? new ReplayWindow(replayWindowSeconds) : undefined,
  }
}

/**
 * Register an authentication provider that admits only requests carrying a verifiable
 * assertion for this instance's audience and subject.
 * @param ctx - plugin scope owning the Peer and the provider registration.
 * @param config - key material, accepted claims, audience, served subject, and time window.
 */
export function apply(ctx: Context, config: Config): void {
  const policy = resolveAssertionPolicy(config)
  // One Peer per instance: the gateway already resolved the browser to this subject, and
  // an owner Peer is what keeps approvals, questions, and remote access working.
  const peer: PeerScope = ctx.connection.createPeer({ principal: { kind: 'owner' } })
  ctx.connection.authentication.register({
    authenticate(request: ConnectionTrustRequest) {
      const assertion = readAssertion(request.headers, config.headerName)
      if (assertion === undefined) return undefined
      const result = verifyGatewayAssertion(assertion, policy)
      if (!result.ok) {
        ctx.logger.warn(`host-authentication-gateway: refused assertion (${result.reason})`)
        return undefined
      }
      return peer
    },
  })
}
