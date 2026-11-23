// @vitest-environment jsdom
/**
 * Platform identity surfaces: the generated avatar and account menu, the
 * read-only account panel, model-provider settings navigation, sign-out
 * feedback, and the personal-runtime overlay states. Every asserted string is
 * the plugin's own dictionary entry, so component copy cannot drift from the
 * locale dictionaries.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  PlatformIdentitySnapshot, PlatformLauncherComponentProps, PlatformUser, RuntimeOverlayComponentProps, RuntimeView,
} from '../src/client/contract.ts'
import { PlatformLauncher } from '../src/client/PlatformLauncher.tsx'
import { RuntimeOverlay } from '../src/client/RuntimeOverlay.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const USER: PlatformUser = {
  id: 'user-1', subject: 'w3-subject-1', uid: '10086', displayName: '张三', email: null,
}
const READY_IDENTITY: PlatformIdentitySnapshot['identity'] = { status: 'ready', user: USER }

function snapshotOf(runtime: RuntimeView = { status: 'ready' }): PlatformIdentitySnapshot {
  return { identity: READY_IDENTITY, runtime }
}

interface LauncherOptions {
  wide?: boolean
  withSettingsNavigation?: boolean
  snapshot?: PlatformIdentitySnapshot
  logout?: () => Promise<'ok' | 'failed'>
  logoutAll?: () => Promise<'ok' | 'failed'>
  openSettingsFallback?: () => void
}

function launcherProps(options: LauncherOptions = {}): {
  props: PlatformLauncherComponentProps
  openSettings: ReturnType<typeof vi.fn<(sectionId?: string) => void>>
} {
  const openSettings = vi.fn<(sectionId?: string) => void>()
  const props: PlatformLauncherComponentProps = {
    ...({} as GlobalStandardProps),
    wide: options.wide ?? true,
    settingsOpen: false,
    ...(options.withSettingsNavigation === false ? {} : { openSettings }),
    usePlatformIdentity: selector => selector(options.snapshot ?? snapshotOf()),
    logout: options.logout ?? (async () => 'ok'),
    logoutAll: options.logoutAll ?? (async () => 'ok'),
    openSettingsFallback: options.openSettingsFallback ?? vi.fn(),
    t: makeTranslate(en),
  }
  return { props, openSettings }
}

/** The trailing gray uid line the launcher renders, as the dictionary spells it. */
function uidLine(): string {
  return en['menu.uid'].replace('{uid}', USER.uid)
}

function openLauncherMenu(): void {
  fireEvent.click(screen.getByRole('button'))
}

describe('PlatformLauncher', () => {
  it('shows the platform display name, work id, and generated initial', () => {
    const { props } = launcherProps()
    render(<PlatformLauncher {...props} />)
    expect(screen.getByText(USER.displayName)).toBeTruthy()
    expect(screen.getByText(uidLine())).toBeTruthy()
    expect(screen.getByText('张')).toBeTruthy()
  })

  it('never presents the platform user as a model-provider profile', () => {
    const { props } = launcherProps()
    render(<PlatformLauncher {...props} />)
    for (const copy of [en['menu.account'], en['menu.modelSettings'], en['menu.signOut']]) {
      expect(screen.queryByText(copy)).toBeNull()
    }
  })

  it('offers the account panel, model-provider settings, and platform sign-out', () => {
    const { props, openSettings } = launcherProps()
    render(<PlatformLauncher {...props} />)
    openLauncherMenu()
    const rows = screen.getAllByRole('menuitem').map(row => row.textContent)
    expect(rows).toEqual([en['menu.account'], en['menu.modelSettings'], en['menu.signOut'], en['menu.signOutAll']])

    fireEvent.click(screen.getByRole('menuitem', { name: en['menu.account'] }))
    const dialog = screen.getByRole('dialog', { name: en['account.title'] })
    expect(dialog).toBeTruthy()
    expect(screen.getByText(USER.subject)).toBeTruthy()
    expect(screen.getByText(USER.uid)).toBeTruthy()
    expect(screen.getByText(en['account.notice'])).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: en['account.close'] })[0]!)
    expect(screen.queryByRole('dialog')).toBeNull()

    openLauncherMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: en['menu.modelSettings'] }))
    expect(openSettings).toHaveBeenCalledExactlyOnceWith('models')
  })

  it('falls back to the plugin settings entry when the shell supplies no navigation', () => {
    const openSettingsFallback = vi.fn()
    const { props } = launcherProps({ withSettingsNavigation: false, openSettingsFallback })
    render(<PlatformLauncher {...props} />)
    openLauncherMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: en['menu.modelSettings'] }))
    expect(openSettingsFallback).toHaveBeenCalledOnce()
  })

  it('signs out through the platform session and reports a failed request', async () => {
    const logout = vi.fn(async () => 'failed' as const)
    const { props } = launcherProps({ logout })
    render(<PlatformLauncher {...props} />)
    openLauncherMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: en['menu.signOut'] }))
    expect(logout).toHaveBeenCalledOnce()
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain(en['error.logoutFailed'])
  })

  it('does not report a toast when sign-out is navigating to the sign-in page', async () => {
    const logout = vi.fn(async () => 'ok' as const)
    const { props } = launcherProps({ logout })
    render(<PlatformLauncher {...props} />)
    openLauncherMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: en['menu.signOut'] }))
    await Promise.resolve()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('confirms before signing out of every platform session', async () => {
    const logoutAll = vi.fn(async () => 'ok' as const)
    const { props } = launcherProps({ logoutAll })
    render(<PlatformLauncher {...props} />)
    openLauncherMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: en['menu.signOutAll'] }))
    expect(screen.getByRole('dialog', { name: en['signOutAll.title'] })).toBeTruthy()
    expect(screen.getByText(en['signOutAll.body'])).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: en['signOutAll.cancel'] })[0]!)
    expect(logoutAll).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()

    openLauncherMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: en['menu.signOutAll'] }))
    fireEvent.click(screen.getByRole('button', { name: en['signOutAll.confirm'] }))
    expect(logoutAll).toHaveBeenCalledOnce()
  })

  it('reports a failed sign-out of every platform session', async () => {
    const logoutAll = vi.fn(async () => 'failed' as const)
    const { props } = launcherProps({ logoutAll })
    render(<PlatformLauncher {...props} />)
    openLauncherMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: en['menu.signOutAll'] }))
    fireEvent.click(screen.getByRole('button', { name: en['signOutAll.confirm'] }))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain(en['error.signOutAllFailed'])
  })

  it('renders only the avatar in the collapsed rail, named for assistive technology', () => {
    const { props } = launcherProps({ wide: false })
    render(<PlatformLauncher {...props} />)
    expect(screen.queryByText(USER.displayName)).toBeNull()
    expect(screen.getByRole('button', { name: `${USER.displayName} · ${USER.uid}` })).toBeTruthy()
  })

  it.each([
    ['loading', { status: 'loading' }],
    ['unauthorized', { status: 'unauthorized' }],
    ['disabled', { status: 'disabled' }],
    ['unavailable', { status: 'unavailable' }],
  ] as const)('renders nothing while the platform identity is %s', (_label, identity) => {
    const { props } = launcherProps({ snapshot: { identity, runtime: { status: 'idle' } } })
    const view = render(<PlatformLauncher {...props} />)
    expect(view.container.innerHTML).toBe('')
  })
})

interface OverlayOptions {
  runtime: RuntimeView
}

function overlayProps(options: OverlayOptions): {
  props: RuntimeOverlayComponentProps
  retry: ReturnType<typeof vi.fn>
} {
  const retry = vi.fn()
  const props: RuntimeOverlayComponentProps = {
    ...({} as GlobalStandardProps),
    usePlatformIdentity: selector => selector(snapshotOf(options.runtime)),
    retry,
    t: makeTranslate(en),
  }
  return { props, retry }
}

describe('RuntimeOverlay', () => {
  it('shows the preparing-workspace status while the runtime starts', () => {
    const { props } = overlayProps({ runtime: { status: 'starting', phase: 'PROVISIONING' } })
    render(<RuntimeOverlay {...props} />)
    const status = screen.getByRole('status', { name: en['runtime.startingTitle'] })
    expect(status.textContent).toContain(en['runtime.startingBody'])
  })

  it('reports the gateway error code and retries a failed runtime', () => {
    const { props, retry } = overlayProps({
      runtime: { status: 'failed', errorCode: 'RUNTIME_BOOT_FAILED', retryable: true },
    })
    render(<RuntimeOverlay {...props} />)
    expect(screen.getByRole('status').textContent).toContain(
      en['runtime.failedBody'].replace('{code}', 'RUNTIME_BOOT_FAILED'),
    )
    fireEvent.click(screen.getByRole('button', { name: en['runtime.retry'] }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('keeps the retry disabled and explains the restriction when the gateway refuses it', () => {
    const { props } = overlayProps({ runtime: { status: 'failed', retryable: false } })
    render(<RuntimeOverlay {...props} />)
    expect(screen.getByText(en['runtime.unknownError'], { exact: false })).toBeTruthy()
    const retry = screen.getByRole('button', { name: en['runtime.retry'] }) as HTMLButtonElement
    expect(retry.disabled).toBe(true)
    expect(screen.getByText(en['runtime.retryBlocked'])).toBeTruthy()
  })

  it('offers a recheck when the runtime surface is unreachable', () => {
    const { props, retry } = overlayProps({ runtime: { status: 'unavailable' } })
    render(<RuntimeOverlay {...props} />)
    expect(screen.getByRole('status', { name: en['runtime.unavailableTitle'] }).textContent)
      .toContain(en['runtime.unavailableBody'])
    fireEvent.click(screen.getByRole('button', { name: en['runtime.recheck'] }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it.each([
    ['idle', { status: 'idle' }],
    ['checking', { status: 'checking' }],
    ['ready', { status: 'ready' }],
  ] as const)('renders nothing while the runtime is %s', (_label, runtime) => {
    const { props } = overlayProps({ runtime })
    render(<RuntimeOverlay {...props} />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(document.body.textContent).toBe('')
  })
})
