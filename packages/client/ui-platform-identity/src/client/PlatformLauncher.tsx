/**
 * Platform identity launcher rendered in the native sidebar foot, beside the
 * settings launcher.
 *
 * It shows the W3-backed platform user's display name, work id, and a
 * generated initial avatar, and offers the read-only account panel, the
 * model-provider settings entry, platform sign-out, and sign-out of every
 * platform session. Model-provider sign-in, balance, and profile stay in the
 * settings account surface: this entry never reads or reuses them.
 */
import { useState } from 'react'
import clsx from 'clsx'
import {
  Button, Menu, Modal, Toast, Tooltip,
  IconSettingsOutlineMedium, IconUserOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PlatformLauncherComponentProps } from './contract.ts'
import { initialOf } from './initials.ts'
import css from './PlatformLauncher.module.css'

/** One read-only account-panel row. */
function AccountRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className={css.detailLabel}>{label}</dt>
      <dd className={css.detailValue}>{value}</dd>
    </>
  )
}

/**
 * Render the platform identity entry and its menu.
 * @param props - sidebar geometry, settings navigation, the plugin's injected
 * face, and localized copy.
 * @returns the launcher while a platform user is signed in; otherwise nothing.
 */
export function PlatformLauncher({
  wide, openSettings, usePlatformIdentity, logout, logoutAll, openSettingsFallback, t,
}: PlatformLauncherComponentProps) {
  const [open, setOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [signOutAllOpen, setSignOutAllOpen] = useState(false)
  const [logoutFailures, setLogoutFailures] = useState(0)
  const [signOutAllFailures, setSignOutAllFailures] = useState(0)
  const identity = usePlatformIdentity(state => state.identity)
  if (identity.status !== 'ready') return null
  const user = identity.user
  const name = user.displayName.trim() === '' ? user.uid : user.displayName
  const initials = initialOf(name)
  const requestSignOut = (): void => {
    setOpen(false)
    void logout().then((outcome) => {
      if (outcome === 'failed') setLogoutFailures(count => count + 1)
    })
  }
  const confirmSignOutAll = (): void => {
    setSignOutAllOpen(false)
    void logoutAll().then((outcome) => {
      if (outcome === 'failed') setSignOutAllFailures(count => count + 1)
    })
  }
  const openModelSettings = (): void => {
    setOpen(false)
    if (openSettings === undefined) openSettingsFallback()
    else openSettings('models')
  }
  const trigger = (
    <button
      type="button"
      className={clsx(css.trigger, !wide && css.rail)}
      {...(wide ? {} : { 'aria-label': `${user.displayName} · ${user.uid}` })}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => { setOpen(value => !value) }}
    >
      <span className={css.avatar} aria-hidden="true">{initials}</span>
      {wide && (
        <span className={css.identity}>
          <span className={css.name}>{name}</span>
          <span className={css.uid}>{t('menu.uid', { uid: user.uid })}</span>
        </span>
      )}
    </button>
  )
  return (
    <div className={css.root} data-platform-identity-launcher>
      {logoutFailures > 0 && (
        <Toast key={`logout-${String(logoutFailures)}`} text={t('error.logoutFailed')} onDone={() => { setLogoutFailures(0) }} />
      )}
      {signOutAllFailures > 0 && (
        <Toast key={`logout-all-${String(signOutAllFailures)}`} text={t('error.signOutAllFailed')} onDone={() => { setSignOutAllFailures(0) }} />
      )}
      <Menu
        open={open}
        side="top"
        portal
        className={css.anchor}
        anchor={wide ? trigger : <Tooltip label={`${user.displayName} · ${user.uid}`}>{trigger}</Tooltip>}
        items={[
          { id: 'account', label: t('menu.account'), icon: <IconUserOutlineMedium size={16} /> },
          { id: 'models', label: t('menu.modelSettings'), icon: <IconSettingsOutlineMedium size={16} /> },
          { id: 'signout', label: t('menu.signOut'), danger: true },
          { id: 'signout-all', label: t('menu.signOutAll'), danger: true },
        ]}
        onClose={() => { setOpen(false) }}
        onSelect={(id) => {
          if (id === 'account') {
            setOpen(false)
            setAccountOpen(true)
          } else if (id === 'models') {
            openModelSettings()
          } else if (id === 'signout') {
            requestSignOut()
          } else if (id === 'signout-all') {
            setOpen(false)
            setSignOutAllOpen(true)
          }
        }}
      />
      <Modal
        open={accountOpen}
        title={t('account.title')}
        closeLabel={t('account.close')}
        onClose={() => { setAccountOpen(false) }}
        footer={(
          <Button variant="outline" data-modal-autofocus onClick={() => { setAccountOpen(false) }}>
            {t('account.close')}
          </Button>
        )}
      >
        <dl className={css.details}>
          <AccountRow label={t('account.displayName')} value={name} />
          <AccountRow label={t('account.uid')} value={user.uid} />
          <AccountRow label={t('account.subject')} value={user.subject} />
        </dl>
        <p className={css.notice}>{t('account.notice')}</p>
      </Modal>
      <Modal
        open={signOutAllOpen}
        title={t('signOutAll.title')}
        closeLabel={t('signOutAll.cancel')}
        onClose={() => { setSignOutAllOpen(false) }}
        footer={(
          <>
            <Button variant="outline" data-modal-autofocus onClick={() => { setSignOutAllOpen(false) }}>
              {t('signOutAll.cancel')}
            </Button>
            <Button variant="primary" onClick={confirmSignOutAll}>{t('signOutAll.confirm')}</Button>
          </>
        )}
      >
        <p className={css.notice}>{t('signOutAll.body')}</p>
      </Modal>
    </div>
  )
}
