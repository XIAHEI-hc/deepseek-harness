/**
 * System-fusion workbench plugin, browser half.
 *
 * The plugin reads `/api/integration/status` once after boot. A deployment
 * without the fusion API renders nothing; an available service contributes one
 * launcher into the shell overlay. All resource, workspace, job, and artifact
 * operations go through the gateway's authenticated, CSRF-guarded API.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import {
  artifactDownloadPath,
  browserTransport,
  cancelJob,
  captureSnapshot,
  createWorkspace,
  loadJob,
  loadOverview,
  loadResources,
  startJob,
} from './api.ts'
import type { FusionWorkbenchInjected } from './contract.ts'
import { createFusionAvailabilityController } from './controller.ts'
import { de, en, es, fr, ja, pt, ru, zh } from './locales.ts'
import { Workbench } from './Workbench.tsx'

export type { FusionWorkbenchInjected, FusionWorkbenchProps } from './contract.ts'
export type { FusionKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'fusion'

/** Required services: slot registration and copy. */
export const inject = ['slots', 'locale']

/**
 * Register the fusion workbench and its dictionaries, then read availability.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const transport = browserTransport()
  const controller = createFusionAvailabilityController(transport)
  ctx.effect(() => () => { controller.dispose() }, 'ui-integration-workbench: availability')
  ctx.effect(
    () => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }),
    'ui-integration-workbench: dictionaries',
  )
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'integration-workbench',
    locale: NS,
    inject: (): FusionWorkbenchInjected => ({
      hooks: { fusion: controller },
      loadOverview: () => loadOverview(transport),
      loadResources: systemId => loadResources(transport, systemId),
      capture: resource => captureSnapshot(transport, resource),
      createWorkspace: name => createWorkspace(transport, name),
      startJob: input => startJob(transport, input),
      loadJob: jobId => loadJob(transport, jobId),
      cancelJob: jobId => cancelJob(transport, jobId),
      artifactPath: artifactId => artifactDownloadPath(artifactId),
    }),
  }, Workbench))
  controller.start()
}
