/**
 * Domain values exchanged by the system-fusion service.
 *
 * These types describe resources crossing the platform/Gateway boundary. They
 * intentionally contain no host paths, connector tokens, or upstream response
 * text: the browser and the model only ever see logical ids and source metadata.
 *
 * @module @deepseek-ai/dsh-platform-services/integration/types
 */

/** Classification attached to every resource and snapshot. */
export type ResourceClassification = 'public' | 'internal' | 'confidential'

/** Kinds of host resources a connector may expose. */
export type ResourceType = 'api' | 'source' | 'dataset' | 'log' | 'artifact'

/** Operations a grant may permit; there is no write operation. */
export type ResourceAction = 'list' | 'read' | 'export'

/** Logical address of one host resource. */
export interface ResourceLocator {
  readonly systemId: string
  readonly resourceType: ResourceType
  readonly resourceId: string
  /** Optional source version selected by the user; the adapter validates it. */
  readonly version?: string | undefined
}

/** Server-verified permission for one actor, resource, and action. */
export interface ResourceGrant {
  /** Opaque grant id recorded on every snapshot it authorized. */
  readonly grantId: string
  readonly connectorId: string
  readonly resourceId: string
  readonly actions: readonly ResourceAction[]
  /** ISO timestamp after which the grant is unusable. */
  readonly expiresAt: string
  /** Monotonic grant revision reported by the adapter. */
  readonly grantVersion: number
  /** Internal user id the grant was issued for. */
  readonly ownerUserId: string
  /** Session permission version at authorization time. */
  readonly policyEpoch: number
}

/** One resource the actor may discover. */
export interface ResourceView {
  readonly locator: ResourceLocator
  readonly name: string
  readonly classification: ResourceClassification
}

/** One page of discoverable resources. */
export interface ResourcePage {
  readonly items: readonly ResourceView[]
  readonly nextCursor: string | null
}

/** One immutable input snapshot with source metadata. */
export interface SnapshotRecord {
  readonly id: string
  readonly ownerUserId: string
  readonly locator: ResourceLocator
  readonly sourceVersion: string
  readonly sha256: string
  readonly fetchedAt: string
  readonly grantId: string
  readonly policyEpoch: number
  readonly classification: ResourceClassification
  /** Media type of the stored bytes. */
  readonly contentType: string
  /** Relative storage key under the snapshot root. */
  readonly storageKey: string
  readonly size: number
}

/** One analysis workspace owned by a user. */
export interface WorkspaceRecord {
  readonly id: string
  readonly ownerUserId: string
  readonly name: string
  readonly createdAt: string
}

/** Lifecycle of one analysis job. */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** Script language an analysis job accepts. */
export type JobLanguage = 'shell' | 'python'

/** One short-lived analysis job. */
export interface JobRecord {
  readonly id: string
  readonly ownerUserId: string
  readonly sessionId: string
  readonly workspaceId: string
  readonly inputSnapshotIds: readonly string[]
  readonly language: JobLanguage
  readonly scriptSha256: string
  readonly status: JobStatus
  readonly createdAt: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly errorCode: string | null
}

/** One downloadable file produced by a job. */
export interface ArtifactRecord {
  readonly id: string
  readonly jobId: string
  readonly workspaceId: string
  readonly ownerUserId: string
  readonly relativePath: string
  readonly sha256: string
  readonly mime: string
  readonly size: number
  readonly createdAt: string
  readonly downloadScope: 'owner'
}

/** One issue that prevents all or part of fusion from running. */
export interface IntegrationIssue {
  readonly code: string
  readonly message: string
}

/** Service state exposed to the browser. */
export type IntegrationState = 'disabled' | 'ready' | 'degraded' | 'blocked'

/** Anonymous fusion status. */
export interface IntegrationStatus {
  readonly state: IntegrationState
  readonly enabled: boolean
  readonly issues: readonly IntegrationIssue[]
}

/** One connector visible to the actor. */
export interface IntegrationSystemView {
  readonly id: string
  readonly name: string
  readonly health: 'ready' | 'degraded'
}

/** Facts every adapter needs about the actor, resolved from a validated session. */
export interface IntegrationActor {
  readonly userId: string
  /** W3 subject, accepted as an ACL key by administrator configuration. */
  readonly subject: string
  /** W3 account id, accepted as an ACL key by administrator configuration. */
  readonly uid: string
  readonly sessionId: string
  /** Session permission version; stored as `policyEpoch`. */
  readonly permissionVersion: number
  readonly clientAddress?: string | undefined
}

/** Result of reading one authorized resource. */
export interface SnapshotPayload {
  /** UTF-8 resource bytes; adapters never return a filesystem path. */
  readonly content: Uint8Array
  readonly contentType: string
  readonly sourceVersion: string
  readonly classification: ResourceClassification
}

/** Read-only host connector. */
export interface HostAdapter {
  readonly systemId: string
  /**
   * List resources the actor currently owns.
   * @param actor - validated session identity.
   * @param cursor - opaque page cursor, or null for the first page.
   */
  discover(actor: IntegrationActor, cursor: string | null): Promise<ResourcePage>
  /**
   * Re-check the actor's current permission for one resource and action.
   * @param actor - validated session identity.
   * @param locator - resource being requested.
   * @param action - requested read-only operation.
   * @returns the verified grant.
   */
  authorize(actor: IntegrationActor, locator: ResourceLocator, action: ResourceAction): Promise<ResourceGrant>
  /**
   * Read one authorized resource into memory, enforcing size and time limits.
   * @param actor - validated session identity.
   * @param locator - resource being read.
   * @param grant - grant returned by {@link HostAdapter.authorize}.
   */
  snapshot(actor: IntegrationActor, locator: ResourceLocator, grant: ResourceGrant): Promise<SnapshotPayload>
  /** Probe the connector without exposing upstream error text. */
  health(): Promise<'ready' | 'degraded'>
}
