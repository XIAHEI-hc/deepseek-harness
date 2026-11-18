import { describe, expect, it } from 'vitest'
import type { PlazaDraftContent, PlazaWorkflow } from '@deepseek-ai/dsh-skill-plaza/types'
import { displayFlow, flowLabels, flowStats, rootLayerOf } from '../src/client/flow-model.ts'

/** Content with an authored workflow that branches, loops, and nests. */
const AUTHORED: PlazaDraftContent = {
  title: 'STDF 批次异常分析',
  slug: 'stdf-anomaly',
  description: '定位异常 Die。',
  inputs: ['STDF 文件'],
  steps: ['读取 STDF', '文件校验', '执行规则', '生成报告'],
  outputs: ['Wafer Map'],
  verification: '抽样核对。',
  failureHandling: '提示重新上传。',
  toolDependencies: ['STDF 解析器'],
  presentation: {
    schemaVersion: 1,
    workflow: {
      rootLayerId: 'flow',
      layers: [
        {
          id: 'flow',
          entryNodeId: 'read',
          nodes: [
            { id: 'read', type: 'action', title: '读取 STDF' },
            { id: 'validate', type: 'decision', title: '文件校验', subflowLayerId: 'detail' },
            { id: 'apply', type: 'action', title: '执行规则' },
            { id: 'retry', type: 'action', title: '提示重新上传' },
          ],
          edges: [
            { from: 'read', to: 'validate' },
            { from: 'validate', to: 'apply', label: '通过' },
            { from: 'validate', to: 'retry', label: '失败' },
            { from: 'retry', to: 'validate' },
          ],
        },
        {
          id: 'detail',
          entryNodeId: 'check',
          nodes: [{ id: 'check', type: 'action', title: '检查记录格式' }],
          edges: [],
        },
      ],
    },
  },
}

/** The same operating fields without any presentation payload. */
const DERIVED: PlazaDraftContent = {
  title: AUTHORED.title,
  slug: AUTHORED.slug,
  description: AUTHORED.description,
  inputs: AUTHORED.inputs,
  steps: ['  读取原表  ', '', '校验并输出'],
  outputs: AUTHORED.outputs,
  verification: '',
  failureHandling: AUTHORED.failureHandling,
  toolDependencies: AUTHORED.toolDependencies,
}

describe('display flow', () => {
  it('reads the authored workflow and marks it as authored', () => {
    const flow = displayFlow(AUTHORED)
    expect(flow?.synthesized).toBe(false)
    expect(flow?.workflow.rootLayerId).toBe('flow')
  })

  it('derives a linear flow from the operating steps', () => {
    const flow = displayFlow(DERIVED)
    expect(flow?.synthesized).toBe(true)
    const layer = flow?.workflow.layers[0]
    expect(layer?.nodes.map(node => node.title)).toEqual(['读取原表', '校验并输出'])
    expect(layer?.edges).toEqual([{ from: 'step-1', to: 'step-2' }])
    expect(layer?.entryNodeId).toBe('step-1')
  })

  it('reports no flow when the version has neither a workflow nor steps', () => {
    expect(displayFlow({ ...DERIVED, steps: ['  ', ''] })).toBeUndefined()
  })

  it('ignores a workflow whose root layer is missing', () => {
    const workflow: PlazaWorkflow = { rootLayerId: 'absent', layers: [] }
    const content: PlazaDraftContent = {
      ...DERIVED,
      presentation: { schemaVersion: 1, workflow },
    }
    expect(displayFlow(content)?.synthesized).toBe(true)
    expect(rootLayerOf(workflow)).toBeUndefined()
    expect(rootLayerOf(undefined)).toBeUndefined()
  })
})

describe('flow stats', () => {
  it('counts branches, returning edges, decisions, and subflows', () => {
    expect(flowStats(AUTHORED)).toEqual({
      nodes: 4,
      decisions: 1,
      branches: 2,
      loops: 1,
      subflows: 1,
    })
  })

  it('counts derived steps without claiming branches', () => {
    expect(flowStats(DERIVED)).toEqual({ nodes: 2, decisions: 0, branches: 0, loops: 0, subflows: 0 })
  })

  it('does not report a node that points at itself as a return edge', () => {
    const content: PlazaDraftContent = {
      ...DERIVED,
      presentation: {
        schemaVersion: 1,
        workflow: {
          rootLayerId: 'flow',
          layers: [{
            id: 'flow',
            entryNodeId: 'only',
            nodes: [{ id: 'only', type: 'action', title: '重试' }],
            edges: [{ from: 'only', to: 'only', label: '再来一次' }],
          }],
        },
      },
    }
    expect(flowStats(content)).toEqual({ nodes: 1, decisions: 0, branches: 1, loops: 0, subflows: 0 })
  })

  it('reports an empty root layer without dividing by its absent nodes', () => {
    const content: PlazaDraftContent = {
      ...DERIVED,
      steps: [],
      presentation: {
        schemaVersion: 1,
        workflow: { rootLayerId: 'flow', layers: [{ id: 'flow', entryNodeId: 'gone', nodes: [], edges: [] }] },
      },
    }
    expect(flowStats(content)).toEqual({ nodes: 0, decisions: 0, branches: 0, loops: 0, subflows: 0 })
  })
})

describe('flow labels', () => {
  it('lists root node titles in execution order, bounded by the limit', () => {
    expect(flowLabels(AUTHORED)).toEqual(['读取 STDF', '文件校验', '执行规则', '提示重新上传'])
    expect(flowLabels(AUTHORED, 2)).toEqual(['读取 STDF', '文件校验'])
  })

  it('lists the steps and drops blank ones when the flow is derived', () => {
    expect(flowLabels(DERIVED)).toEqual(['读取原表', '校验并输出'])
  })
})
