// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FlowThumb } from '../src/client/FlowThumb.tsx'

afterEach(cleanup)

describe('catalog thumbnail', () => {
  it('draws one numbered box per label with a connector between them', () => {
    const view = render(<FlowThumb labels={['读取原表', '校验输出']} />)
    const texts = [...view.container.querySelectorAll('text')].map(node => node.textContent)
    expect(texts).toContain('1')
    expect(texts).toContain('2')
    expect(texts).toContain('读取原表')
    expect(view.container.querySelectorAll('path')).toHaveLength(2)
    expect(view.container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 340 96')
  })

  it('shrinks a label that does not fit, keeping its full text', () => {
    const long = '读取原始记录文件并检查格式与晶圆编号'
    const view = render(<FlowThumb labels={[long, '校验输出']} variant="featured" />)
    const labels = [...view.container.querySelectorAll('text')].map(node => node.textContent ?? '')
    expect(labels).toContain(long)
    const squeezed = [...view.container.querySelectorAll('text')]
      .find(node => node.textContent === long)
    expect(squeezed?.getAttribute('textLength')).not.toBeNull()
    expect(view.container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 360 156')
  })

  it('draws nothing when the catalog carries no labels', () => {
    const view = render(<FlowThumb labels={[]} />)
    expect(view.container.querySelector('svg')).toBeNull()
  })
})
