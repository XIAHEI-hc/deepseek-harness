/**
 * Display flow for one version: the author's structured workflow when it has a
 * root layer, otherwise a linear flow derived from the operating steps so a
 * published skill always reads as a process instead of a bullet list.
 *
 * The derived flow is never stored or published; it exists only for the views
 * that draw a version.
 */
import type {
  PlazaDraftContent, PlazaWorkflow, PlazaWorkflowLayer, PlazaWorkflowNode,
} from '@deepseek-ai/dsh-skill-plaza/types'

/** Node labels a catalog card draws. */
const PREVIEW_NODES = 4

/** One version's flow plus where it came from. */
export interface DisplayFlow {
  /** The workflow the views lay out. */
  readonly workflow: PlazaWorkflow
  /** Whether this flow was derived from the steps rather than authored. */
  readonly synthesized: boolean
}

/**
 * Read the layer execution starts at.
 * @param workflow - the version's authored workflow, when it has one.
 * @returns the root layer, or undefined when the workflow has none.
 */
export function rootLayerOf(workflow: PlazaWorkflow | undefined): PlazaWorkflowLayer | undefined {
  if (workflow === undefined) return undefined
  return workflow.layers.find(layer => layer.id === workflow.rootLayerId)
}

/** Node counts the detail header and the pipeline strip report. */
export interface FlowStats {
  /** Nodes in the root layer. */
  readonly nodes: number
  /** Decision nodes in the root layer. */
  readonly decisions: number
  /** Labeled edges, which are the branches a reader can follow. */
  readonly branches: number
  /** Edges that return to an earlier node. */
  readonly loops: number
  /** Distinct nested layers below the root. */
  readonly subflows: number
}

/**
 * Count the root layer's process facts.
 * @param content - the version whose flow is measured.
 * @returns the counts the detail header and the pipeline strip report.
 */
export function flowStats(content: PlazaDraftContent): FlowStats {
  const layer = rootLayerOf(content.presentation?.workflow)
  if (layer === undefined) {
    const steps = content.steps.filter(step => step.trim() !== '').length
    return { nodes: steps, decisions: 0, branches: 0, loops: 0, subflows: 0 }
  }
  return {
    nodes: layer.nodes.length,
    decisions: layer.nodes.filter(node => node.type === 'decision').length,
    branches: layer.edges.filter(edge => edge.label !== undefined && edge.label !== '').length,
    loops: backEdgesOf(layer).length,
    subflows: layer.nodes.filter(node => node.subflowLayerId !== undefined).length,
  }
}

/**
 * Read the labels a catalog card draws.
 * @param content - the version whose flow supplies them.
 * @param limit - how many labels the card can draw.
 * @returns the labels in execution order, at most `limit` of them.
 */
export function flowLabels(content: PlazaDraftContent, limit = PREVIEW_NODES): readonly string[] {
  const layer = rootLayerOf(content.presentation?.workflow)
  const labels = layer === undefined
    ? content.steps
    : layer.nodes.map(node => node.title)
  return labels
    .map(label => label.trim())
    .filter(label => label !== '')
    .slice(0, limit)
}

/**
 * Choose the flow a detail view draws for one version.
 * @param content - the version to draw.
 * @returns the authored flow, the one derived from its steps, or undefined when it has no steps.
 */
export function displayFlow(content: PlazaDraftContent): DisplayFlow | undefined {
  const authored = content.presentation?.workflow
  if (rootLayerOf(authored) !== undefined) return { workflow: authored as PlazaWorkflow, synthesized: false }
  const steps = content.steps.map(step => step.trim()).filter(step => step !== '')
  if (steps.length === 0) return undefined
  return { workflow: linearWorkflow(steps), synthesized: true }
}

/** Turn ordered steps into the same layer shape the authored flow uses. */
function linearWorkflow(steps: readonly string[]): PlazaWorkflow {
  const nodes: PlazaWorkflowNode[] = steps.map((step, index) => ({
    id: `step-${index + 1}`,
    type: 'action',
    title: step,
  }))
  return {
    rootLayerId: 'steps',
    layers: [{
      id: 'steps',
      entryNodeId: nodes[0]?.id ?? '',
      nodes,
      edges: nodes.slice(1).map((node, index) => ({ from: nodes[index]?.id ?? '', to: node.id })),
    }],
  }
}

/** Edges that close a cycle, found by a depth-first walk from the entry node. */
function backEdgesOf(layer: PlazaWorkflowLayer): PlazaWorkflowLayer['edges'] {
  const outgoing = new Map<string, { to: string; index: number }[]>()
  layer.edges.forEach((edge, index) => {
    const list = outgoing.get(edge.from)
    if (list === undefined) outgoing.set(edge.from, [{ to: edge.to, index }])
    else list.push({ to: edge.to, index })
  })
  const state = new Map<string, 'visiting' | 'done'>()
  const back = new Set<number>()
  const walk = (id: string): void => {
    state.set(id, 'visiting')
    for (const edge of outgoing.get(id) ?? []) {
      const seen = state.get(edge.to)
      if (seen === 'visiting') back.add(edge.index)
      else if (seen === undefined) walk(edge.to)
    }
    state.set(id, 'done')
  }
  if (layer.nodes.some(node => node.id === layer.entryNodeId)) walk(layer.entryNodeId)
  return layer.edges.filter((edge, index) => back.has(index) && edge.to !== edge.from)
}
