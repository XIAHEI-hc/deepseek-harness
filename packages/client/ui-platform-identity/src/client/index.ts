/**
 * Platform identity plugin, browser half: the sidebar platform launcher and
 * the personal-runtime status overlay, both over the gateway's `/auth/*` and
 * `/api/runtime/*` surface. The launcher is the DSH platform account entry and
 * stays separate from the model-provider account menu; the overlay owns the
 * per-user runtime's start, failure, and readiness.
 * Export discipline: packages/client/AGENTS.md.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls ctx.locale into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the 'shell.overlay' declaration.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the 'settings.platform-launcher' declaration the settings shell renders.
import type {} from '@deepseek-ai/dsh-client-ui-settings-general/client'
import { browserTransport } from './api.ts'
import type { PlatformLauncherInjected, RuntimeOverlayInjected } from './contract.ts'
import { en, ja, es, fr, de, ru, pt, zh, type PlatformKey } from './locales.ts'
import { PlatformLauncher } from './PlatformLauncher.tsx'
import { RuntimeOverlay } from './RuntimeOverlay.tsx'
import { createPlatformIdentityController } from './state.ts'

export type {
  PlatformIdentitySnapshot, PlatformIdentityState, PlatformUser, RuntimePhase, RuntimeView,
} from './contract.ts'
export type { PlatformKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Platform account entry and personal-runtime overlay copy. */
    platform: PlatformKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'platform'

/** Required services: slot registration and copy. */
export const inject = ['slots', 'locale']

/**
 * Register the platform launcher, the runtime overlay, and the plugin's
 * dictionaries, then read the platform identity and the personal runtime.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const controller = createPlatformIdentityController(browserTransport())
  ctx.effect(() => () => { controller.dispose() }, 'ui-platform-identity: platform state')
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-platform-identity: dictionaries')
  const launcherInjected = (): PlatformLauncherInjected => ({
    hooks: { platformIdentity: controller },
    logout: () => controller.logout(),
    logoutAll: () => controller.logoutAll(),
    // The settings shell occupant owns settings navigation; a shell that does
    // not expose it returns the page to the application root instead.
    openSettingsFallback: () => { globalThis.location.assign('/') },
  })
  const overlayInjected = (): RuntimeOverlayInjected => ({
    hooks: { platformIdentity: controller },
    retry: () => { controller.retryRuntime() },
  })
  ctx.slots.inject('settings.platform-launcher', () => ctx.slots.register({
    name: 'settings.platform-launcher',
    locale: NS,
    inject: launcherInjected,
  }, PlatformLauncher))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'platform-runtime-status',
    locale: NS,
    inject: overlayInjected,
  }, RuntimeOverlay))
  controller.start()
}
