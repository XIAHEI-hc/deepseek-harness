// @vitest-environment jsdom

import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { PlazaDraftView, PlazaSkillEntry } from '@deepseek-ai/dsh-skill-plaza/types'
import { GenerateSkillButton, PlazaPanelIcon, SkillPicker } from '../src/client/Actions.tsx'
import { PlazaPage } from '../src/client/PlazaPage.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh, commonZh)

afterEach(cleanup)

const DRAFT: PlazaDraftView = {
  draftId: 'draft-1',
  revision: 2,
  updatedAt: '2026-11-16T00:00:00.000Z',
  title: '发布记录指标对比',
  slug: 'release-metrics-compare',
  description: '比较两次发布记录的指标',
  inputs: ['changelog_path'],
  steps: ['读取变更日志'],
  outputs: ['对比表'],
  verification: '数值与源行一致',
  failureHandling: '报告差异并请求补充',
  toolDependencies: ['file read'],
}

const SKILL: PlazaSkillEntry = {
  skillId: 'skill-1',
  slug: 'release-metrics-compare',
  title: '发布记录指标对比',
  description: '比较两次发布记录的指标',
  version: 3,
  updatedAt: '2026-11-16T00:00:00.000Z',
}

type PageFace = ComponentProps<typeof PlazaPage>
type PageView = typeof PlazaPage
type ActionFace = ComponentProps<typeof GenerateSkillButton>
type ActionView = typeof GenerateSkillButton
type PickerView = typeof SkillPicker

/** Render the page with the framework seats it never reads left to the cast. */
function renderPage(over: Partial<ComponentProps<PageView>> = {}) {
  const props: Partial<ComponentProps<PageView>> = {
    t,
    load: () => Promise.resolve({ drafts: [], skills: [] }),
    save: () => Promise.resolve({ ok: true }),
    publish: () => Promise.resolve({ ok: true }),
    subscribe: () => () => {},
    ...over,
  }
  return render(<PlazaPage {...props as ComponentProps<PageView>} />)
}

/** Render the finalized-assistant action. */
function renderAction(over: Partial<ComponentProps<ActionView>> = {}) {
  const props: Partial<ComponentProps<ActionView>> = {
    t,
    messageId: 'message-1' as never,
    generate: () => Promise.resolve({ ok: true }),
    openPlaza: vi.fn(),
    ...over,
  }
  return render(<GenerateSkillButton {...props as ComponentProps<ActionView>} />)
}

/** Render the composer picker. */
function renderPicker(over: Partial<ComponentProps<PickerView>> = {}) {
  const props: Partial<ComponentProps<PickerView>> = {
    t,
    catalog: () => Promise.resolve([SKILL]),
    pick: vi.fn(),
    ...over,
  }
  return render(<SkillPicker {...props as ComponentProps<PickerView>} />)
}

describe('PlazaPage', () => {
  it('states both empty collections before any draft exists', async () => {
    renderPage()
    expect(await screen.findByText(zh['noDrafts'])).toBeTruthy()
    expect(screen.getByText(zh['noSkills'])).toBeTruthy()
  })

  it('lists a draft and its published counterpart with revisions', async () => {
    renderPage({ load: () => Promise.resolve({ drafts: [DRAFT], skills: [SKILL] }) })
    expect(await screen.findByDisplayValue(DRAFT.title)).toBeTruthy()
    expect(screen.getByText(/版本 3/)).toBeTruthy()
    expect(screen.getByText(new RegExp(`${DRAFT.slug} · 修订 2`))).toBeTruthy()
  })

  it('saves the edited content against the rendered revision', async () => {
    const save = vi.fn<PageFace['save']>(() => Promise.resolve({ ok: true }))
    renderPage({ load: () => Promise.resolve({ drafts: [DRAFT], skills: [] }), save })
    const title = await screen.findByDisplayValue(DRAFT.title)
    fireEvent.change(title, { target: { value: '新标题' } })
    fireEvent.click(screen.getByRole('button', { name: zh['save'] }))
    await waitFor(() => { expect(save).toHaveBeenCalledOnce() })
    expect(save.mock.calls[0]?.[0]).toBe(DRAFT.draftId)
    expect(save.mock.calls[0]?.[1]).toMatchObject({ title: '新标题', slug: DRAFT.slug, steps: ['读取变更日志'] })
    expect(save.mock.calls[0]?.[2]).toBe(DRAFT.revision)
  })

  it('publishes the edited content', async () => {
    const publish = vi.fn<PageFace['publish']>(() => Promise.resolve({ ok: true }))
    renderPage({ load: () => Promise.resolve({ drafts: [DRAFT], skills: [] }), publish })
    fireEvent.click(await screen.findByRole('button', { name: zh['publish'] }))
    await waitFor(() => { expect(publish).toHaveBeenCalledOnce() })
    expect(publish.mock.calls[0]?.[0]).toBe(DRAFT.draftId)
    expect(publish.mock.calls[0]?.[1]).toBe(DRAFT.revision)
    expect(publish.mock.calls[0]?.[2]).toMatchObject({ slug: DRAFT.slug })
  })

  it('surfaces a failed read at page level', async () => {
    renderPage({ load: () => Promise.reject(new Error('boom')) })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('boom')
  })

  it('reports a refused save instead of claiming success', async () => {
    renderPage({
      load: () => Promise.resolve({ drafts: [DRAFT], skills: [] }),
      save: () => Promise.resolve({ ok: false, error: 'skillPlaza/conflict: moved' }),
    })
    fireEvent.click(await screen.findByRole('button', { name: zh['save'] }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('skillPlaza/conflict')
  })

  it('reloads when the plaza announces a change', async () => {
    const load = vi.fn(() => Promise.resolve({ drafts: [], skills: [] }))
    let notify = (): void => {}
    renderPage({ load, subscribe: (listener) => { notify = listener; return () => {} } })
    await waitFor(() => { expect(load).toHaveBeenCalledOnce() })
    notify()
    await waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })
  })

  it('selects a draft from the list', async () => {
    const other: PlazaDraftView = { ...DRAFT, draftId: 'draft-2', title: '第二份草稿', updatedAt: '2026-11-17T00:00:00.000Z' }
    renderPage({ load: () => Promise.resolve({ drafts: [DRAFT, other], skills: [] }) })
    const row = await screen.findByRole('button', { name: /第二份草稿/ })
    fireEvent.click(row)
    expect(await screen.findByDisplayValue(other.title)).toBeTruthy()
  })
})

describe('PlazaPage pending work', () => {
  it('drops a load that resolves or rejects after unmount', async () => {
    let resolveLoad: (value: { drafts: never[]; skills: never[] }) => void = () => {}
    const pending = new Promise<{ drafts: never[]; skills: never[] }>((resolve) => { resolveLoad = resolve })
    const view = renderPage({ load: () => pending })
    view.unmount()
    resolveLoad({ drafts: [], skills: [] })
    await Promise.resolve()

    let rejectLoad: (error: Error) => void = () => {}
    const failing = new Promise<{ drafts: never[]; skills: never[] }>((_resolve, reject) => { rejectLoad = reject })
    const second = renderPage({ load: () => failing })
    second.unmount()
    rejectLoad(new Error('late failure'))
    await Promise.resolve()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports a failed reload after a successful save', async () => {
    let calls = 0
    renderPage({
      load: () => {
        calls += 1
        return calls === 1
          ? Promise.resolve({ drafts: [DRAFT], skills: [] })
          : Promise.reject(new Error('reload failed'))
      },
      save: () => Promise.resolve({ ok: true }),
    })
    fireEvent.click(await screen.findByRole('button', { name: zh['save'] }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('reload failed')
  })

  it('reports a non-Error rejection as text', async () => {
    renderPage({ load: () => Promise.reject('plain text failure') })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('plain text failure')
  })

  it('treats a missing form field as empty', async () => {
    const save = vi.fn<PageFace['save']>(() => Promise.resolve({ ok: true }))
    renderPage({ load: () => Promise.resolve({ drafts: [DRAFT], skills: [] }), save })
    const editor = await screen.findByDisplayValue(DRAFT.title)
    editor.removeAttribute('name')
    fireEvent.click(screen.getByRole('button', { name: zh['save'] }))
    await waitFor(() => { expect(save).toHaveBeenCalledOnce() })
    expect(save.mock.calls[0]?.[1]).toMatchObject({ title: '' })
  })
})

describe('PlazaPage edge inputs', () => {
  it('treats a missing multi-line field as an empty list', async () => {
    const save = vi.fn<PageFace['save']>(() => Promise.resolve({ ok: true }))
    renderPage({ load: () => Promise.resolve({ drafts: [DRAFT], skills: [] }), save })
    const steps = await screen.findByDisplayValue(DRAFT.steps.join('\n'))
    steps.removeAttribute('name')
    fireEvent.click(screen.getByRole('button', { name: zh['save'] }))
    await waitFor(() => { expect(save).toHaveBeenCalledOnce() })
    expect(save.mock.calls[0]?.[1]).toMatchObject({ steps: [] })
  })

  it('reports a non-Error reload failure as text', async () => {
    let calls = 0
    renderPage({
      load: () => {
        calls += 1
        return calls === 1
          ? Promise.resolve({ drafts: [DRAFT], skills: [] })
          : Promise.reject('reload text failure')
      },
      save: () => Promise.resolve({ ok: true }),
    })
    fireEvent.click(await screen.findByRole('button', { name: zh['save'] }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('reload text failure')
  })

  it('does nothing when publishing without a mounted form', async () => {
    const publish = vi.fn<PageFace['publish']>(() => Promise.resolve({ ok: true }))
    const view = renderPage({ load: () => Promise.resolve({ drafts: [DRAFT], skills: [] }), publish })
    const publishButton = await screen.findByRole('button', { name: zh['publish'] })
    view.container.querySelector('form')?.remove()
    fireEvent.click(publishButton)
    await Promise.resolve()
    expect(publish).not.toHaveBeenCalled()
  })
})

describe('GenerateSkillButton', () => {
  it('generates for the message and opens the plaza', async () => {
    const generate = vi.fn<ActionFace['generate']>(() => Promise.resolve({ ok: true }))
    const openPlaza = vi.fn()
    renderAction({ generate, openPlaza })
    fireEvent.click(screen.getByRole('button', { name: zh['generate'] }))
    await waitFor(() => { expect(openPlaza).toHaveBeenCalledOnce() })
    expect(generate).toHaveBeenCalledWith('message-1')
  })

  it('reports a failed generation and stays on the reply', async () => {
    const openPlaza = vi.fn()
    renderAction({ generate: () => Promise.resolve({ ok: false, error: 'model unavailable' }), openPlaza })
    fireEvent.click(screen.getByRole('button', { name: zh['generate'] }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('model unavailable')
    expect(openPlaza).not.toHaveBeenCalled()
  })
})

describe('PlazaPanelIcon', () => {
  it('draws the sidebar glyph', () => {
    const view = render(<PlazaPanelIcon />)
    expect(view.container.querySelector('svg')).not.toBeNull()
  })
})

describe('SkillPicker', () => {
  it('lists the catalog and picks one entry', async () => {
    const pick = vi.fn()
    renderPicker({ pick })
    fireEvent.click(screen.getByText(zh['selectSkill']))
    const entry = await screen.findByRole('button', { name: /发布记录指标对比/ })
    fireEvent.click(entry)
    expect(pick).toHaveBeenCalledWith(SKILL)
  })

  it('filters the catalog by the query and states an empty result', async () => {
    renderPicker()
    fireEvent.click(screen.getByText(zh['selectSkill']))
    const search = await screen.findByPlaceholderText(zh['searchSkills'])
    fireEvent.change(search, { target: { value: 'zzz-no-match' } })
    expect(await screen.findByText(zh['pickerEmpty'])).toBeTruthy()
    fireEvent.change(search, { target: { value: '发布' } })
    expect(await screen.findByRole('button', { name: /发布记录指标对比/ })).toBeTruthy()
  })

  it('states an empty catalog', async () => {
    renderPicker({ catalog: () => Promise.resolve([]) })
    fireEvent.click(screen.getByText(zh['selectSkill']))
    expect(await screen.findByText(zh['pickerEmpty'])).toBeTruthy()
  })

  it('ignores a toggle that closes the menu', async () => {
    renderPicker()
    const summary = screen.getByText(zh['selectSkill'])
    const details = summary.closest('details') as HTMLDetailsElement
    fireEvent(details, new Event('toggle', { bubbles: false }))
    expect(screen.queryByPlaceholderText(zh['searchSkills'])).toBeNull()
  })
})
