/**
 * Fusion workbench contract: injected callbacks, observable availability, and
 * derived component props.
 */
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { FusionKey } from './locales.ts'
import type {
  FusionJob,
  FusionJobView,
  FusionOverview,
  FusionResource,
  FusionResourcePage,
  FusionSnapshot,
  FusionStatus,
  FusionTransport,
  FusionWorkspace,
} from './api.ts'
import type { FusionAvailability } from './controller.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** System-fusion workbench copy. */
    fusion: FusionKey
  }
}

/** Registrant-private face of the workbench overlay. */
export interface FusionWorkbenchInjected {
  readonly hooks: {
    /** One-shot service availability. */
    readonly fusion: HostObservable<FusionAvailability>
  }
  /**
   * Read systems, workspaces, and jobs after the panel opens.
   * @returns the overview.
   */
  loadOverview(): Promise<FusionOverview>
  /**
   * Read authorized resources for one system.
   * @param systemId - system id.
   * @returns the resource page.
   */
  loadResources(systemId: string): Promise<FusionResourcePage>
  /**
   * Capture one resource snapshot.
   * @param resource - authorized resource.
   * @returns the snapshot.
   */
  capture(resource: FusionResource): Promise<FusionSnapshot>
  /**
   * Create one analysis workspace.
   * @param name - display name.
   * @returns the workspace.
   */
  createWorkspace(name: string): Promise<FusionWorkspace>
  /**
   * Start one analysis job.
   * @param input - workspace, snapshots, language, and script.
   * @returns the queued job.
   */
  startJob(input: {
    readonly workspaceId: string
    readonly inputSnapshotIds: readonly string[]
    readonly language: 'shell' | 'python'
    readonly script: string
  }): Promise<FusionJob>
  /**
   * Read one job and its artifacts.
   * @param jobId - job id.
   * @returns the job view.
   */
  loadJob(jobId: string): Promise<FusionJobView>
  /**
   * Cancel one job.
   * @param jobId - job id.
   * @returns the updated job.
   */
  cancelJob(jobId: string): Promise<FusionJob>
  /**
   * Build one artifact download path.
   * @param artifactId - artifact id.
   * @returns the same-origin path.
   */
  artifactPath(artifactId: string): string
}

/** Props of the fusion workbench overlay. */
export type FusionWorkbenchProps =
  & PropsRuntime<'shell.overlay'>
  & InjectFace<FusionWorkbenchInjected>
  & {
    /**
     * Translate one `fusion` namespace key.
     * @param key - dictionary key.
     * @param params - placeholder values.
     * @returns the localized text.
     */
    t(key: FusionKey, params?: Readonly<Record<string, string | number>>): string
  }

/** Transport factory the plugin body passes to the injected callbacks. */
export type FusionTransportFactory = () => FusionTransport

export type { FusionStatus }
