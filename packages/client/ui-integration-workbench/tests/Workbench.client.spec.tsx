// @vitest-environment jsdom
/** Fusion workbench: hidden without the API, launcher, panel, and blocked issues. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { FusionAvailability } from '../src/client/controller.ts'
import type { FusionWorkbenchProps } from '../src/client/contract.ts'
import { en } from '../src/client/locales.ts'
import { Workbench } from '../src/client/Workbench.tsx'

afterEach(cleanup)

/**
 * Build the injected face and localized props for one render.
 * @param availability - availability snapshot the hook returns.
 * @returns the component props.
 */
function propsFor(availability: FusionAvailability): FusionWorkbenchProps {
  return {
    ...({} as GlobalStandardProps),
    useFusion: selector => selector(availability),
    t: makeTranslate(en),
    loadOverview: async () => ({
      status: availability.status === 'available' ? availability.service : { state: 'ready', enabled: true, issues: [] },
      systems: [{ id: 'mock-erp', name: 'Mock ERP', health: 'ready' }],
      workspaces: [{ id: 'w1', name: 'Main', createdAt: '2026-01-01T00:00:00.000Z' }],
      jobs: [],
    }),
    loadResources: async () => ({
      items: [{
        locator: { systemId: 'mock-erp', resourceType: 'dataset', resourceId: 'sales', version: '1' },
        name: 'Sales',
        classification: 'internal',
      }],
      nextCursor: null,
    }),
    capture: async () => ({
      id: 'snap-1',
      locator: { systemId: 'mock-erp', resourceType: 'dataset', resourceId: 'sales', version: '1' },
      sha256: 'a'.repeat(64),
      sourceVersion: '1',
      classification: 'internal',
      size: 10,
    }),
    createWorkspace: async name => ({ id: 'w2', name, createdAt: '2026-01-01T00:00:00.000Z' }),
    startJob: vi.fn(),
    loadJob: vi.fn(),
    cancelJob: vi.fn(),
    artifactPath: id => `/api/integration/artifacts/${id}/download`,
  }
}

describe('Workbench', () => {
  it('renders nothing when fusion is unavailable', () => {
    const { container } = render(<Workbench {...propsFor({ status: 'unavailable' })} />)
    expect(container.innerHTML).toBe('')
  })

  it('opens the panel and lists authorized resources', async () => {
    const props = propsFor({ status: 'available', service: { state: 'ready', enabled: true, issues: [] } })
    render(<Workbench {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en['workbench.open'] }))
    expect(await screen.findByRole('dialog', { name: en['workbench.title'] })).toBeDefined()
    await waitFor(() => {
      expect(screen.getByText('Sales')).toBeDefined()
    })
    fireEvent.click(screen.getByRole('button', { name: en['resource.capture'] }))
    expect(await screen.findByText(en['snapshot.selected'].replace('{count}', '1'))).toBeDefined()
  })

  it('shows missing-prerequisite codes when blocked', async () => {
    const props = propsFor({
      status: 'available',
      service: { state: 'blocked', enabled: true, issues: [{ code: 'docker-unavailable', message: 'no daemon' }] },
    })
    render(<Workbench {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en['workbench.open'] }))
    expect(await screen.findByText(en['status.blocked'])).toBeDefined()
    expect(await screen.findByText('docker-unavailable')).toBeDefined()
  })
})
