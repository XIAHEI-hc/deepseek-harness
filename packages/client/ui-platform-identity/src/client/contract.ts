/**
 * Platform identity contract: the wire values the identity UI renders, and the
 * derived component props of the two surfaces this plugin contributes.
 *
 * The identity is the DSH platform account behind the gateway (`/auth/me`);
 * it is never a model-provider account. The personal runtime is the gateway's
 * per-user DSH instance (`/api/runtime/*`), separate from the model provider's
 * own sign-in state.
 */
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the settings shell declares and renders 'settings.platform-launcher'.
import type { SettingsPlatformLauncherOwnerProps } from '@deepseek-ai/dsh-client-ui-settings-general/client'
// Type-only: the layout shell declares and renders 'shell.overlay'.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

/** The W3-backed platform user as `/auth/me` reports it. */
export interface PlatformUser {
  /** Stable internal user id. */
  readonly id: string
  /** Stable W3 subject. */
  readonly subject: string
  /** W3 account id shown as the work id (工号). */
  readonly uid: string
  /** User display name; may be empty when W3 publishes none. */
  readonly displayName: string
  /** Optional email published by W3. */
  readonly email: string | null
}

/** Platform sign-in state, one branch per answer the gateway can give. */
export type PlatformIdentityState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly user: PlatformUser }
  /** 401: the browser session ended; the plugin clears local state and returns to sign-in. */
  | { readonly status: 'unauthorized' }
  /** 403: the platform account is disabled. */
  | { readonly status: 'disabled' }
  /** 404, network failure, or a malformed answer: the platform surface is not reachable. */
  | { readonly status: 'unavailable' }

/** Runtime states the gateway reports. */
export type RuntimePhase =
  | 'UNALLOCATED'
  | 'PROVISIONING'
  | 'STARTING'
  | 'READY'
  | 'STOPPING'
  | 'STOPPED'
  | 'FAILED'

/** The personal runtime as the overlay presents it. */
export type RuntimeView =
  /** No runtime check ran yet (identity is not ready). */
  | { readonly status: 'idle' }
  /** A status check is in flight. */
  | { readonly status: 'checking' }
  /** The runtime is being prepared; the overlay polls until it settles. */
  | { readonly status: 'starting'; readonly phase: RuntimePhase }
  /** The runtime failed; `retryable` mirrors the gateway's retry permission. */
  | { readonly status: 'failed'; readonly errorCode?: string; readonly retryable: boolean }
  /** The runtime surface answered nothing usable; the overlay offers a recheck. */
  | { readonly status: 'unavailable' }
  /** The runtime is ready; the native client stays fully interactive with no overlay. */
  | { readonly status: 'ready' }

/** One observable snapshot carrying both facts the two surfaces read. */
export interface PlatformIdentitySnapshot {
  readonly identity: PlatformIdentityState
  readonly runtime: RuntimeView
}

/** Registrant-private face of the sidebar platform launcher. */
export interface PlatformLauncherInjected {
  hooks: {
    /** Platform identity and runtime state owned by the plugin body. */
    platformIdentity: HostObservable<PlatformIdentitySnapshot>
  }
  /**
   * Revoke the platform browser session and return to the sign-in page.
   * @returns `'ok'` when the page is navigating to sign-in, `'failed'` when the
   * request did not complete and the caller should report it.
   */
  logout(): Promise<'ok' | 'failed'>
  /**
   * Revoke every platform browser session of this identity, including this
   * browser, and return to the sign-in page.
   * @returns `'ok'` when the page is navigating to sign-in, `'failed'` when the
   * request did not complete and the caller should report it.
   */
  logoutAll(): Promise<'ok' | 'failed'>
  /**
   * Open the model-provider settings when the shell occupant supplies no
   * settings navigation. Reaching the native settings surface is the owner's
   * capability; without it, this returns to the application root.
   */
  openSettingsFallback(): void
}

/** Owner share the settings shell supplies: sidebar geometry and its settings navigation. */
export type PlatformLauncherOwnerProps = SettingsPlatformLauncherOwnerProps

/** Props of the platform launcher the settings shell renders beside its own launcher. */
export type PlatformLauncherComponentProps =
  & PropsRuntime<'settings.platform-launcher'>
  & InjectFace<PlatformLauncherInjected>
  & PropsLocale<'platform'>

/** Registrant-private face of the personal-runtime overlay. */
export interface RuntimeOverlayInjected {
  hooks: {
    /** Platform identity and runtime state owned by the plugin body. */
    platformIdentity: HostObservable<PlatformIdentitySnapshot>
  }
  /** Retry a failed runtime (`POST /api/runtime/retry`) or recheck an unreachable one. */
  retry(): void
}

/** Props of the full-viewport personal-runtime overlay. */
export type RuntimeOverlayComponentProps =
  & PropsRuntime<'shell.overlay'>
  & InjectFace<RuntimeOverlayInjected>
  & PropsLocale<'platform'>
