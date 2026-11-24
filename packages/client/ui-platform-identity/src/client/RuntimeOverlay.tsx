/**
 * Personal-runtime status overlay rendered in the shell's overlay layer.
 *
 * The gateway allocates one DSH runtime per platform user. While it starts,
 * the native client is not usable yet, so this surfaces a full-viewport status
 * card and polls; a failure reports the gateway's error code and offers the
 * gateway-permitted retry. A ready runtime renders nothing, returning the
 * native client unchanged.
 */
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import {
  Button, IconLoadingOutlineMedium, IconWarningOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { RuntimeOverlayComponentProps } from './contract.ts'
import css from './RuntimeOverlay.module.css'

/**
 * Render the runtime status overlay.
 * @param props - the plugin's injected runtime face and localized copy.
 * @returns the blocking status card while the runtime is not ready; otherwise nothing.
 */
export function RuntimeOverlay({ usePlatformIdentity, retry, t }: RuntimeOverlayComponentProps) {
  const runtime = usePlatformIdentity(state => state.runtime)
  if (runtime.status === 'idle' || runtime.status === 'checking' || runtime.status === 'ready') return null
  const header = runtime.status === 'starting'
    ? t('runtime.startingTitle')
    : runtime.status === 'failed' ? t('runtime.failedTitle') : t('runtime.unavailableTitle')
  return createPortal((
    <div className={css.overlay} role="presentation" data-platform-runtime-overlay>
      <div className={css.mask} aria-hidden="true" />
      <section className={clsx(css.card)} role="status" aria-live="polite" aria-label={header}>
        <h1 className={css.title}>{header}</h1>
        {runtime.status === 'starting' && (
          <>
            <IconLoadingOutlineMedium size={20} className={css.spinner} aria-hidden="true" />
            <p className={css.body}>{t('runtime.startingBody')}</p>
          </>
        )}
        {runtime.status === 'failed' && (
          <>
            <IconWarningOutlineMedium size={20} className={css.warning} aria-hidden="true" />
            <p className={css.body}>{t('runtime.failedBody', { code: runtime.errorCode ?? t('runtime.unknownError') })}</p>
            <Button variant="primary" disabled={!runtime.retryable} data-modal-autofocus onClick={retry}>
              {t('runtime.retry')}
            </Button>
            {!runtime.retryable && <p className={css.hint}>{t('runtime.retryBlocked')}</p>}
          </>
        )}
        {runtime.status === 'unavailable' && (
          <>
            <IconWarningOutlineMedium size={20} className={css.warning} aria-hidden="true" />
            <p className={css.body}>{t('runtime.unavailableBody')}</p>
            <Button variant="primary" data-modal-autofocus onClick={retry}>
              {t('runtime.recheck')}
            </Button>
          </>
        )}
      </section>
    </div>
  ), document.body)
}
