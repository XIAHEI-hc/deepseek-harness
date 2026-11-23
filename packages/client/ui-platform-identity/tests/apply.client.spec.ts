/**
 * Platform identity plugin body: seat registration and disposal, and the
 * identity/runtime state machine with its CSRF-protected mutations.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PlatformTransport } from '../src/client/api.ts'
import type { PlatformIdentitySnapshot } from '../src/client/contract.ts'
import { inject, apply } from '../src/client/index.ts'
import { PlatformLauncher } from '../src/client/PlatformLauncher.tsx'
import { RuntimeOverlay } from '../src/client/RuntimeOverlay.tsx'
import { createPlatformIdentityController, type PlatformIdentityController } from '../src/client/state.ts'
import { initialOf } from '../src/client/initials.ts'

const USER = { id: 'user-1', subject: 'w3-subject-1', uid: '10086', displayName: '张三', email: null }
const IDENTITY = { user: USER, sessionExpiresAt: '2027-01-01T00:00:00.000Z' }

function json(status: number, body?: unknown): Response {
  if (body === undefined) return new Response(null, { status })
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function runtimeBody(state: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { state, generation: 1, retryable: true, errorCode: null, ...overrides }
}

type FetchHandler = (path: string, init?: RequestInit) => Response | Promise<Response>

const contexts: Context[] = []
const controllers: PlatformIdentityController[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  for (const controller of controllers.splice(0)) controller.dispose()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** The request `fetch` was called with, for method and header assertions. */
function requestOf(fetchMock: ReturnType<typeof vi.fn<FetchHandler>>, path: string): RequestInit {
  const call = fetchMock.mock.calls.find(([input]) => input === path)
  if (call === undefined) throw new Error(`no request for ${path}`)
  return call[1] ?? {}
}

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>
}

describe('ui-platform-identity apply', () => {
  it('declares only the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers the two seats and reads the platform identity through the page transport', async () => {
    const fetchMock = vi.fn<FetchHandler>(path => path === '/auth/me'
      ? json(200, IDENTITY)
      : json(200, runtimeBody('READY')))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('location', { pathname: '/sessions/1', search: '', hash: '', assign: vi.fn() })
    vi.stubGlobal('document', { cookie: 'dsh_csrf=csrf-token' })
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: {
        'settings.platform-launcher': { kind: 'single', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
    } as never, () => null)
    contexts.push(ctx)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const launcher = slots.entries('settings.platform-launcher')
    const overlay = slots.entries('shell.overlay')
    expect(launcher.map(entry => entry.component)).toEqual([PlatformLauncher])
    expect(overlay.map(entry => entry.component)).toEqual([RuntimeOverlay])
    expect(overlay[0]!.options.id).toBe('platform-runtime-status')
    expect(launcher[0]!.locale).toBe('platform')
    expect(overlay[0]!.locale).toBe('platform')
    expect(typeof launcher[0]!.inject).toBe('function')
    expect(typeof overlay[0]!.inject).toBe('function')

    const t = ctx.locale.bind('platform')
    expect(t('menu.account')).toBe('Account information')
    expect(t('runtime.retry')).toBe('Retry')
    ctx.locale.setLocale('zh')
    expect(t('menu.account')).toBe('账号信息')
    expect(t('runtime.failedBody', { code: 'RUNTIME_BOOT_FAILED' })).toBe('错误码：RUNTIME_BOOT_FAILED')
    await vi.waitFor(() => { expect(fetchMock.mock.calls[0]?.[0]).toBe('/auth/me') })
  })

  it('removes both contributions with the plugin fiber', async () => {
    const fetchMock = vi.fn<FetchHandler>(() => json(404))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('location', { pathname: '/', search: '', hash: '', assign: vi.fn() })
    vi.stubGlobal('document', { cookie: '' })
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: {
        'settings.platform-launcher': { kind: 'single', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
    } as never, () => null)
    contexts.push(ctx)
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(slots.entries('settings.platform-launcher')).toHaveLength(1)
    await ctx.fiber.dispose()
    expect(slots.entries('settings.platform-launcher')).toEqual([])
    expect(slots.entries('shell.overlay')).toEqual([])
    expect(() => { locale.register('platform', 'zh', {})() }).not.toThrow()
  })
})

interface ControllerBench {
  controller: PlatformIdentityController
  fetchMock: ReturnType<typeof vi.fn<FetchHandler>>
  assign: ReturnType<typeof vi.fn>
  snapshot: () => PlatformIdentitySnapshot
}

/** One controller over an injected transport: no page globals are involved. */
function benchController(handler: FetchHandler): ControllerBench {
  const fetchMock = vi.fn<FetchHandler>(handler)
  const assign = vi.fn()
  const transport: PlatformTransport = {
    fetch: (input, init) => Promise.resolve(fetchMock(input, init)),
    cookie: name => name === 'dsh_csrf' ? 'csrf-token' : undefined,
    location: { pathname: '/sessions/1', search: '?tab=chat', hash: '', assign },
  }
  const controller = createPlatformIdentityController(transport)
  controllers.push(controller)
  return {
    controller,
    fetchMock,
    assign,
    snapshot: () => controller.getSnapshot(),
  }
}

describe('platform identity state machine', () => {
  it('reads the platform identity and reports a ready runtime', async () => {
    const b = benchController(path => path === '/auth/me' ? json(200, IDENTITY) : json(200, runtimeBody('READY')))
    b.controller.start()
    await vi.waitFor(() => { expect(b.snapshot().runtime.status).toBe('ready') })
    expect(b.snapshot().identity).toEqual({ status: 'ready', user: USER })
    expect(requestOf(b.fetchMock, '/auth/me')).toMatchObject({ method: 'GET', credentials: 'same-origin' })
    expect(requestOf(b.fetchMock, '/api/runtime/me').method).toBe('GET')
  })

  it('clears local state and returns to sign-in with the current page on 401', async () => {
    const b = benchController(() => json(401))
    b.controller.start()
    await vi.waitFor(() => { expect(b.snapshot().identity.status).toBe('unauthorized') })
    expect(b.snapshot().runtime).toEqual({ status: 'idle' })
    expect(b.assign).toHaveBeenCalledExactlyOnceWith('/login?return_to=%2Fsessions%2F1%3Ftab%3Dchat')
  })

  it('marks a disabled platform account and leaves the runtime alone', async () => {
    const b = benchController(() => json(403))
    b.controller.start()
    await vi.waitFor(() => { expect(b.snapshot().identity.status).toBe('disabled') })
    expect(b.snapshot().runtime).toEqual({ status: 'idle' })
    expect(b.assign).not.toHaveBeenCalled()
  })

  it.each([
    ['404 from the gateway', () => json(404)],
    ['a network failure', () => { throw new TypeError('network down') }],
    ['a malformed identity payload', () => json(200, { user: { id: 1 } })],
  ])('reports an unavailable platform surface on %s', async (_label, respond) => {
    const b = benchController(respond)
    b.controller.start()
    await vi.waitFor(() => { expect(b.snapshot().identity.status).toBe('unavailable') })
    expect(b.snapshot().runtime).toEqual({ status: 'idle' })
    expect(b.assign).not.toHaveBeenCalled()
  })

  it('polls a starting runtime and settles when it becomes ready', async () => {
    vi.useFakeTimers()
    const states = ['STARTING', 'PROVISIONING', 'READY']
    const b = benchController(path => path === '/auth/me'
      ? json(200, IDENTITY)
      : json(200, runtimeBody(states.shift() ?? 'READY')))
    b.controller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(b.snapshot().runtime).toEqual({ status: 'starting', phase: 'STARTING' })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(b.snapshot().runtime).toEqual({ status: 'starting', phase: 'PROVISIONING' })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(b.snapshot().runtime).toEqual({ status: 'ready' })
    expect(b.fetchMock.mock.calls.filter(([input]) => input === '/api/runtime/me')).toHaveLength(3)
    // No further checks once the runtime is ready.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(b.fetchMock.mock.calls.filter(([input]) => input === '/api/runtime/me')).toHaveLength(3)
  })

  it('stops waiting for a runtime that never settles and offers a recheck', async () => {
    vi.useFakeTimers()
    const b = benchController(path => path === '/auth/me' ? json(200, IDENTITY) : json(200, runtimeBody('STARTING')))
    b.controller.start()
    for (let index = 0; index < 60; index++) await vi.advanceTimersByTimeAsync(2_000)
    expect(b.snapshot().runtime).toEqual({ status: 'unavailable' })
  })

  it('wakes an unallocated runtime with the CSRF header before polling', async () => {
    vi.useFakeTimers()
    let statusCalls = 0
    const b = benchController((path) => {
      if (path === '/auth/me') return json(200, IDENTITY)
      if (path === '/api/runtime/wake') return json(200, runtimeBody('STARTING'))
      statusCalls += 1
      return json(200, runtimeBody(statusCalls === 1 ? 'UNALLOCATED' : 'READY'))
    })
    b.controller.start()
    await vi.advanceTimersByTimeAsync(0)
    const wake = requestOf(b.fetchMock, '/api/runtime/wake')
    expect(wake).toMatchObject({ method: 'POST', credentials: 'same-origin' })
    expect(headersOf(wake)['x-csrf-token']).toBe('csrf-token')
    expect(b.snapshot().runtime).toEqual({ status: 'starting', phase: 'STARTING' })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(b.snapshot().runtime).toEqual({ status: 'ready' })
  })

  it('reports a failed runtime with its code and retries through the CSRF-protected endpoint', async () => {
    let retried = false
    const b = benchController((path) => {
      if (path === '/auth/me') return json(200, IDENTITY)
      if (path === '/api/runtime/retry') {
        retried = true
        return json(200, runtimeBody('READY'))
      }
      return retried
        ? json(200, runtimeBody('READY'))
        : json(200, runtimeBody('FAILED', { retryable: false, errorCode: 'RUNTIME_BOOT_FAILED' }))
    })
    b.controller.start()
    await vi.waitFor(() => { expect(b.snapshot().runtime.status).toBe('failed') })
    expect(b.snapshot().runtime).toEqual({
      status: 'failed', retryable: false, errorCode: 'RUNTIME_BOOT_FAILED',
    })
    b.controller.retryRuntime()
    await vi.waitFor(() => { expect(b.snapshot().runtime).toEqual({ status: 'ready' }) })
    const retry = requestOf(b.fetchMock, '/api/runtime/retry')
    expect(retry).toMatchObject({ method: 'POST', credentials: 'same-origin' })
    expect(headersOf(retry)['x-csrf-token']).toBe('csrf-token')
  })

  it('rechecks an unreachable runtime surface without waking it', async () => {
    let checks = 0
    const b = benchController((path) => {
      if (path === '/auth/me') return json(200, IDENTITY)
      checks += 1
      return checks === 1 ? json(503) : json(200, runtimeBody('READY'))
    })
    b.controller.start()
    await vi.waitFor(() => { expect(b.snapshot().runtime).toEqual({ status: 'unavailable' }) })
    b.controller.retryRuntime()
    await vi.waitFor(() => { expect(b.snapshot().runtime).toEqual({ status: 'ready' }) })
    expect(b.fetchMock.mock.calls.some(([input]) => input === '/api/runtime/wake')).toBe(false)
  })

  it('revokes the platform session with the CSRF header and returns to sign-in', async () => {
    const b = benchController((path) => {
      if (path === '/auth/me') return json(200, IDENTITY)
      if (path === '/api/runtime/me') return json(200, runtimeBody('READY'))
      return json(204)
    })
    b.controller.start()
    await vi.waitFor(() => { expect(b.snapshot().runtime.status).toBe('ready') })
    await expect(b.controller.logout()).resolves.toBe('ok')
    const logout = requestOf(b.fetchMock, '/auth/logout')
    expect(logout).toMatchObject({ method: 'POST', credentials: 'same-origin' })
    expect(headersOf(logout)['x-csrf-token']).toBe('csrf-token')
    expect(b.assign).toHaveBeenCalledExactlyOnceWith('/login')
    expect(b.snapshot().identity).toEqual({ status: 'unauthorized' })
    expect(b.snapshot().runtime).toEqual({ status: 'idle' })
  })

  it('reports a sign-out failure without navigating or clearing state', async () => {
    const b = benchController((path) => {
      if (path === '/auth/me') return json(200, IDENTITY)
      if (path === '/api/runtime/me') return json(200, runtimeBody('READY'))
      return json(500)
    })
    b.controller.start()
    await vi.waitFor(() => { expect(b.snapshot().runtime.status).toBe('ready') })
    await expect(b.controller.logout()).resolves.toBe('failed')
    expect(b.assign).not.toHaveBeenCalled()
    expect(b.snapshot().identity.status).toBe('ready')
  })

  it('stops polling and drops listeners when disposed', async () => {
    vi.useFakeTimers()
    const b = benchController(path => path === '/auth/me' ? json(200, IDENTITY) : json(200, runtimeBody('STARTING')))
    const listener = vi.fn()
    b.controller.subscribe(listener)
    b.controller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(b.snapshot().runtime.status).toBe('starting')
    const before = b.fetchMock.mock.calls.length
    b.controller.dispose()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(b.fetchMock.mock.calls.length).toBe(before)
    expect(listener).toHaveBeenCalled()
  })

  it('derives a generated avatar initial from the display name', () => {
    expect(initialOf('  alice ')).toBe('A')
    expect(initialOf('张三')).toBe('张')
    expect(initialOf('   ')).toBe('?')
  })
})
