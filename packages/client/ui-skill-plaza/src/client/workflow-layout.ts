/**
 * Workflow layer access and deterministic layout.
 *
 * A workflow stores its layers flat and lets a node name the layer it opens.
 * These helpers are the only place that shape is walked: the process view and
 * the editor both read one layer at a time.
 *
 * Layout rows follow the longest path from the entry node, so a branch that
 * rejoins is drawn below both of its sources. Columns follow the order the
 * layer lists its nodes, which keeps the picture stable while an author edits
 * one node's text.
 */
import type {
  PlazaWorkflow, PlazaWorkflowLayer, PlazaWorkflowNode,
} from '@deepseek-ai/dsh-skill-plaza/types'

/** Fixed node box sizes, in layout units. */
const ACTION_WIDTH = 190
const ACTION_HEIGHT = 58
const DECISION_WIDTH = 218
const DECISION_HEIGHT = 76
const COLUMN_GAP = 28
const ROW_GAP = 54
const PADDING = 24

/** One node placed in layer coordinates. */
export interface PlacedNode {
  /** The node itself. */
  readonly node: PlazaWorkflowNode
  /** Left edge. */
  readonly x: number
  /** Top edge. */
  readonly y: number
  /** Box width. */
  readonly width: number
  /** Box height. */
  readonly height: number
}

/** One edge drawn between two placed nodes. */
export interface PlacedEdge {
  /** The edge itself. */
  readonly edge: PlazaWorkflowLayer['edges'][number]
  /** SVG path data in layer coordinates. */
  readonly path: string
  /** Where the branch label is centered. */
  readonly labelX: number
  /** Where the branch label is centered. */
  readonly labelY: number
}

/** Geometry of one rendered layer. */
export interface WorkflowLayout {
  /** Drawing width in layout units. */
  readonly width: number
  /** Drawing height in layout units. */
  readonly height: number
  /** Placed nodes in layer order. */
  readonly nodes: readonly PlacedNode[]
  /** Drawn edges, skipping edges whose endpoints are absent. */
  readonly edges: readonly PlacedEdge[]
}

/** Read one layer by identity. */
export function layerOf(workflow: PlazaWorkflow, layerId: string): PlazaWorkflowLayer | undefined {
  return workflow.layers.find(layer => layer.id === layerId)
}

/** Replace one layer, keeping the others in order. */
export function replaceLayer(
  workflow: PlazaWorkflow,
  layerId: string,
  next: PlazaWorkflowLayer,
): PlazaWorkflow {
  return {
    ...workflow,
    layers: workflow.layers.map(layer => layer.id === layerId ? next : layer),
  }
}

/** Mint a workflow layer identity that no layer uses yet. */
export function mintLayerId(workflow: PlazaWorkflow, base = 'subflow'): string {
  const taken = new Set(workflow.layers.map(layer => layer.id))
  let counter = 1
  while (taken.has(`${base}-${counter}`)) counter += 1
  return `${base}-${counter}`
}

/** Mint a node identity that its layer does not use yet. */
export function mintNodeId(layer: PlazaWorkflowLayer): string {
  const taken = new Set(layer.nodes.map(node => node.id))
  let counter = taken.size + 1
  while (taken.has(`node-${counter}`)) counter += 1
  return `node-${counter}`
}

/** Append one empty layer and return its identity with the new workflow. */
export function appendLayer(
  workflow: PlazaWorkflow,
  base = 'subflow',
): { workflow: PlazaWorkflow; layerId: string } {
  const layerId = mintLayerId(workflow, base)
  return {
    workflow: {
      ...workflow,
      layers: [...workflow.layers, { id: layerId, entryNodeId: '', nodes: [], edges: [] }],
    },
    layerId,
  }
}

/** Remove one layer and every layer reachable only through it. */
export function removeLayerTree(workflow: PlazaWorkflow, layerId: string): PlazaWorkflow {
  if (layerId === workflow.rootLayerId) return workflow
  const doomed = new Set<string>()
  const pending = [layerId]
  while (pending.length > 0) {
    const current = pending.pop() as string
    if (doomed.has(current) || current === workflow.rootLayerId) continue
    doomed.add(current)
    const layer = layerOf(workflow, current)
    if (layer === undefined) continue
    for (const node of layer.nodes) {
      if (node.subflowLayerId !== undefined) pending.push(node.subflowLayerId)
    }
  }
  return {
    rootLayerId: workflow.rootLayerId,
    layers: workflow.layers
      .filter(layer => !doomed.has(layer.id))
      .map(layer => ({
        ...layer,
        nodes: layer.nodes.filter(node => node.subflowLayerId === undefined || !doomed.has(node.subflowLayerId)),
      })),
  }
}

/** The node trail from the root layer down to one layer, when it is reachable. */
export function layerTrail(
  workflow: PlazaWorkflow,
  layerId: string,
): readonly { readonly layer: PlazaWorkflowLayer; readonly via: PlazaWorkflowNode }[] | undefined {
  const trail: { layer: PlazaWorkflowLayer; via: PlazaWorkflowNode }[] = []
  let current = layerOf(workflow, workflow.rootLayerId)
  if (current === undefined) return undefined
  const guard = new Set<string>()
  while (current.id !== layerId) {
    if (guard.has(current.id)) return undefined
    guard.add(current.id)
    const opening = current.nodes.find(node => node.subflowLayerId !== undefined)
    if (opening === undefined || opening.subflowLayerId === undefined) return undefined
    const child = layerOf(workflow, opening.subflowLayerId)
    if (child === undefined) return undefined
    trail.push({ layer: current, via: opening })
    current = child
  }
  return trail
}

/**
 * Place one workflow layer.
 * @param layer - the layer to lay out.
 * @returns placed nodes, drawn edges, and the drawing size.
 */
export function layoutWorkflow(layer: PlazaWorkflowLayer): WorkflowLayout {
  const ids = new Set(layer.nodes.map(node => node.id))
  const depth = depthOf(layer, ids)
  const rows = new Map<number, PlazaWorkflowNode[]>()
  for (const node of layer.nodes) {
    const row = depth.get(node.id) ?? 0
    const existing = rows.get(row)
    if (existing === undefined) rows.set(row, [node])
    else existing.push(node)
  }
  const widest = Math.max(...[...rows.values()].map(nodes => nodes.length), 1)
  const rowWidth = widest * ACTION_WIDTH + (widest - 1) * COLUMN_GAP
  const placed = new Map<string, PlacedNode>()
  for (const [row, peers] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    const rowContentWidth = peers.reduce((total, peer) => total
      + (peer.type === 'decision' ? DECISION_WIDTH : ACTION_WIDTH), 0)
      + Math.max(peers.length - 1, 0) * COLUMN_GAP
    let cursor = PADDING + (rowWidth - rowContentWidth) / 2
    for (const node of peers) {
      const width = node.type === 'decision' ? DECISION_WIDTH : ACTION_WIDTH
      const height = node.type === 'decision' ? DECISION_HEIGHT : ACTION_HEIGHT
      placed.set(node.id, {
        node,
        x: cursor,
        y: PADDING + row * (ACTION_HEIGHT + ROW_GAP),
        width,
        height,
      })
      cursor += width + COLUMN_GAP
    }
  }
  const edges: PlacedEdge[] = []
  for (const edge of layer.edges) {
    const from = placed.get(edge.from)
    const to = placed.get(edge.to)
    if (from === undefined || to === undefined) continue
    const start = { x: from.x + from.width / 2, y: from.y + from.height }
    const end = { x: to.x + to.width / 2, y: to.y }
    const sideways = Math.abs(end.y - start.y) < 1
    const path = sideways
      ? [
        `M ${start.x} ${start.y - from.height / 2}`,
        `C ${start.x + 40} ${start.y - from.height / 2} ${end.x - 40} ${end.y + to.height} ${end.x} ${end.y + to.height / 2}`,
      ].join(' ')
      : [
        `M ${start.x} ${start.y}`,
        `C ${start.x} ${start.y + ROW_GAP / 2} ${end.x} ${end.y - ROW_GAP / 2} ${end.x} ${end.y - 2}`,
      ].join(' ')
    edges.push({
      edge,
      path,
      labelX: (start.x + end.x) / 2,
      labelY: sideways ? start.y - from.height / 2 - 6 : (start.y + end.y) / 2,
    })
  }
  const height = PADDING * 2 + [...rows.keys()].length * ACTION_HEIGHT
    + Math.max([...rows.keys()].length - 1, 0) * ROW_GAP
  return { width: PADDING * 2 + rowWidth, height, nodes: [...placed.values()], edges }
}

/** Longest-path row index for every reachable node; unreachable nodes sit on row zero. */
function depthOf(layer: PlazaWorkflowLayer, ids: ReadonlySet<string>): Map<string, number> {
  const depth = new Map<string, number>()
  if (!ids.has(layer.entryNodeId)) return depth
  depth.set(layer.entryNodeId, 0)
  // Relax until settled. The bound keeps a cyclic authoring mistake from hanging
  // the page; the publication check reports the cycle as unreachable content.
  for (let pass = 0; pass <= layer.nodes.length; pass += 1) {
    let moved = false
    for (const edge of layer.edges) {
      const from = depth.get(edge.from)
      if (from === undefined || !ids.has(edge.to)) continue
      const next = from + 1
      const current = depth.get(edge.to)
      if (current !== undefined && current >= next) continue
      depth.set(edge.to, next)
      moved = true
    }
    if (!moved) break
  }
  return depth
}
