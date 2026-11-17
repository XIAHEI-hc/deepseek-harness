/**
 * Optional presentation content and the publication checks that gate it.
 *
 * Two schemas serve different jobs. {@link plazaPresentationSchema} is the
 * structural schema the durable boundary enforces: it accepts a partially
 * filled presentation, because a draft may be saved before its media and
 * workflow are complete. {@link checkContent} is the publication gate: it
 * resolves media references against the workspace and reports every located
 * problem instead of rejecting the first one, so an editor can mark them all.
 *
 * A workflow is a flat list of layers; a node names the layer it opens. This
 * keeps the Remote payload free of recursive types while still expressing
 * branches, joins, and nested subflows.
 *
 * The workflow graph is display data. Model-visible execution instructions stay
 * in `steps`, which this module never reads or rewrites.
 *
 * @module @deepseek-ai/dsh-skill-plaza
 */

import { z } from 'zod'
import type { PlazaContent } from './storage.ts'
import type {
  PlazaDraftContent, PlazaIssue, PlazaPresentation, PlazaWorkflow, PlazaWorkflowLayer,
} from './types.ts'

/** Content the publication checks read: the editor's draft or one stored record. */
export type PlazaCheckableContent = PlazaContent | PlazaDraftContent

/** Version of the presentation payload these schemas describe. */
export const PLAZA_PRESENTATION_SCHEMA_VERSION = 1

/** Most result examples one presentation may list. */
export const MAX_PLAZA_EXAMPLES = 12

/** Deepest subflow nesting a workflow may use, counting the root layer as one. */
export const MAX_PLAZA_WORKFLOW_DEPTH = 3

/** Most nodes one workflow layer may hold. */
export const MAX_PLAZA_WORKFLOW_NODES = 60

/** Most layers one workflow may hold. */
export const MAX_PLAZA_WORKFLOW_LAYERS = 40

/** Longest callable name the plaza accepts. */
export const MAX_PLAZA_SLUG_LENGTH = 64

/** Largest image the plaza stores, in bytes. */
export const MAX_PLAZA_ASSET_BYTES = 10 * 1024 * 1024

/** Largest image side the plaza stores, in pixels. */
export const MAX_PLAZA_IMAGE_SIDE = 8192

const textSchema = z.string().max(2_000)
const shortTextSchema = z.string().max(500)
const idSchema = z.string().min(1).max(120)
const linesSchema = z.array(z.string().max(2_000)).max(200)

/** One result image reference. */
export const plazaExampleSchema = z.object({
  assetId: idSchema,
  title: shortTextSchema,
  alt: shortTextSchema,
  caption: shortTextSchema,
})

/** One workflow node. */
export const plazaWorkflowNodeSchema = z.object({
  id: idSchema,
  type: z.enum(['action', 'decision']),
  title: z.string().max(200),
  purpose: textSchema.optional(),
  inputs: linesSchema.optional(),
  checks: linesSchema.optional(),
  outputs: linesSchema.optional(),
  verification: textSchema.optional(),
  failureHandling: textSchema.optional(),
  assetIds: z.array(idSchema).max(MAX_PLAZA_EXAMPLES).optional(),
  subflowLayerId: idSchema.optional(),
})

/** One workflow layer. */
export const plazaWorkflowLayerSchema = z.object({
  id: idSchema,
  entryNodeId: idSchema,
  nodes: z.array(plazaWorkflowNodeSchema).max(MAX_PLAZA_WORKFLOW_NODES * 2),
  edges: z.array(z.object({
    from: idSchema,
    to: idSchema,
    label: shortTextSchema.optional(),
  })).max(MAX_PLAZA_WORKFLOW_NODES * 4),
})

/** A workflow as a flat set of named layers. */
export const plazaWorkflowSchema: z.ZodType<PlazaWorkflow> = z.object({
  rootLayerId: idSchema,
  layers: z.array(plazaWorkflowLayerSchema).max(MAX_PLAZA_WORKFLOW_LAYERS * 2),
})

/** Structural presentation content, accepted partially filled. */
export const plazaPresentationSchema: z.ZodType<PlazaPresentation> = z.object({
  schemaVersion: z.literal(PLAZA_PRESENTATION_SCHEMA_VERSION),
  category: z.string().max(80).optional(),
  scenarios: linesSchema.optional(),
  examplePrompt: z.string().max(4_000).optional(),
  coverAssetId: idSchema.optional(),
  examples: z.array(plazaExampleSchema).max(MAX_PLAZA_EXAMPLES * 2).optional(),
  workflow: plazaWorkflowSchema.optional(),
})

/** Media facts the publication checks resolve asset references against. */
export interface PlazaAssets {
  /** Whether one asset identity resolves in the publishing workspace. */
  has(assetId: string): boolean
}

/** Collects issues in a stable order as one validation pass walks the content. */
class IssueList {
  private readonly issues: PlazaIssue[] = []

  /** Record one located problem. */
  add(issue: PlazaIssue): void {
    this.issues.push(issue)
  }

  /** Every issue, ordered by content path and then by code. */
  sorted(): PlazaIssue[] {
    return [...this.issues].sort((a, b) => a.path === b.path
      ? a.code.localeCompare(b.code)
      : a.path.localeCompare(b.path))
  }
}

/**
 * Check draft content against the publication contract.
 * @param content - content exactly as the editor holds it.
 * @param assets - media references that resolve in the publishing workspace.
 * @returns every located problem; an empty list means the content is publishable.
 */
export function checkContent(content: PlazaCheckableContent, assets: PlazaAssets): readonly PlazaIssue[] {
  const issues = new IssueList()
  if (content.title.trim() === '') {
    issues.add({ code: 'title-missing', path: 'title', detail: 'a published title is required' })
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(content.slug) || content.slug.length > MAX_PLAZA_SLUG_LENGTH) {
    issues.add({
      code: 'slug-invalid',
      path: 'slug',
      detail: `the call name must be kebab-case ASCII of at most ${MAX_PLAZA_SLUG_LENGTH} characters`,
    })
  }
  if (content.description.trim() === '') {
    issues.add({ code: 'description-missing', path: 'description', detail: 'a routing description is required' })
  }
  const presentation = content.presentation
  if (presentation === undefined) return issues.sorted()
  checkPresentation(presentation, assets, issues)
  return issues.sorted()
}

/** Check the optional presentation content. */
function checkPresentation(presentation: PlazaPresentation, assets: PlazaAssets, issues: IssueList): void {
  if (presentation.schemaVersion !== PLAZA_PRESENTATION_SCHEMA_VERSION) {
    issues.add({
      code: 'presentation-unsupported',
      path: 'presentation.schemaVersion',
      detail: `presentation schema version ${String(presentation.schemaVersion)} is not readable`,
    })
    return
  }
  if (presentation.coverAssetId !== undefined && !assets.has(presentation.coverAssetId)) {
    issues.add({
      code: 'asset-missing',
      path: 'presentation.coverAssetId',
      detail: 'the cover names a media asset this workspace does not hold',
      assetId: presentation.coverAssetId,
    })
  }
  const examples = presentation.examples ?? []
  if (examples.length > MAX_PLAZA_EXAMPLES) {
    issues.add({
      code: 'example-limit',
      path: 'presentation.examples',
      detail: `at most ${MAX_PLAZA_EXAMPLES} result examples are allowed`,
    })
  }
  examples.forEach((example, index) => {
    if (assets.has(example.assetId)) return
    issues.add({
      code: 'asset-missing',
      path: `presentation.examples[${index}].assetId`,
      detail: 'the example names a media asset this workspace does not hold',
      assetId: example.assetId,
    })
  })
  if (presentation.workflow !== undefined) {
    checkWorkflow(presentation.workflow, assets, issues)
  }
}

/** Check every layer of a workflow and how the layers reference each other. */
function checkWorkflow(workflow: PlazaWorkflow, assets: PlazaAssets, issues: IssueList): void {
  const byId = new Map<string, PlazaWorkflowLayer>()
  workflow.layers.forEach((layer, index) => {
    const path = `presentation.workflow.layers[${index}]`
    if (byId.has(layer.id)) {
      issues.add({
        code: 'layer-id-duplicate',
        path: `${path}.id`,
        detail: `layer identity "${layer.id}" is used more than once`,
      })
      return
    }
    byId.set(layer.id, layer)
  })
  if (!byId.has(workflow.rootLayerId)) {
    issues.add({
      code: 'workflow-root-missing',
      path: 'presentation.workflow.rootLayerId',
      detail: 'the root layer is not among the workflow layers',
    })
  }
  workflow.layers.forEach((layer, index) => {
    checkLayer(layer, `presentation.workflow.layers[${index}]`, byId, assets, issues)
  })
  const depths = layerDepths(workflow, byId)
  workflow.layers.forEach((layer, index) => {
    const depth = depths.get(layer.id)
    if (depth === undefined) {
      if (workflow.rootLayerId === layer.id || depths.size === 0) return
      issues.add({
        code: 'layer-unreachable',
        path: `presentation.workflow.layers[${index}].id`,
        detail: `layer "${layer.id}" is not reachable from the root layer`,
      })
      return
    }
    if (depth <= MAX_PLAZA_WORKFLOW_DEPTH) return
    issues.add({
      code: 'workflow-depth',
      path: `presentation.workflow.layers[${index}].id`,
      detail: `subflows nest at most ${MAX_PLAZA_WORKFLOW_DEPTH} layers deep`,
    })
  })
}

/** Check one layer's nodes, edges, and subflow references. */
function checkLayer(
  layer: PlazaWorkflowLayer,
  path: string,
  layers: ReadonlyMap<string, PlazaWorkflowLayer>,
  assets: PlazaAssets,
  issues: IssueList,
): void {
  if (layer.nodes.length > MAX_PLAZA_WORKFLOW_NODES) {
    issues.add({
      code: 'node-limit',
      path: `${path}.nodes`,
      detail: `at most ${MAX_PLAZA_WORKFLOW_NODES} nodes are allowed per layer`,
    })
  }
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  layer.nodes.forEach((node, index) => {
    if (node.id.trim() === '') {
      issues.add({ code: 'node-id-empty', path: `${path}.nodes[${index}].id`, detail: 'every node needs an identity' })
      return
    }
    if (!seen.has(node.id)) {
      seen.add(node.id)
      return
    }
    if (duplicates.has(node.id)) return
    duplicates.add(node.id)
    issues.add({
      code: 'node-id-duplicate',
      path: `${path}.nodes[${index}].id`,
      detail: `node identity "${node.id}" is used more than once in this layer`,
      nodeId: node.id,
    })
  })
  layer.nodes.forEach((node, index) => {
    const nodePath = `${path}.nodes[${index}]`
    if (node.title.trim() === '') {
      issues.add({
        code: 'node-title-missing',
        path: `${nodePath}.title`,
        detail: 'every node needs a display name',
        ...node.id === '' ? {} : { nodeId: node.id },
      })
    }
    for (const assetId of node.assetIds ?? []) {
      if (assets.has(assetId)) continue
      issues.add({
        code: 'node-asset-missing',
        path: `${nodePath}.assetIds`,
        detail: 'the node names a media asset this workspace does not hold',
        ...node.id === '' ? {} : { nodeId: node.id },
        assetId,
      })
    }
    if (node.subflowLayerId !== undefined && !layers.has(node.subflowLayerId)) {
      issues.add({
        code: 'subflow-missing',
        path: `${nodePath}.subflowLayerId`,
        detail: `the node opens layer "${node.subflowLayerId}", which the workflow does not hold`,
        ...node.id === '' ? {} : { nodeId: node.id },
      })
    }
  })
  if (!seen.has(layer.entryNodeId)) {
    issues.add({
      code: 'workflow-entry-missing',
      path: `${path}.entryNodeId`,
      detail: 'the entry node does not exist in this layer',
    })
  }
  layer.edges.forEach((edge, index) => {
    const edgePath = `${path}.edges[${index}]`
    if (!seen.has(edge.from)) {
      issues.add({
        code: 'edge-dangling',
        path: `${edgePath}.from`,
        detail: `edge source "${edge.from}" is not a node of this layer`,
        nodeId: edge.from,
      })
    }
    if (!seen.has(edge.to)) {
      issues.add({
        code: 'edge-dangling',
        path: `${edgePath}.to`,
        detail: `edge target "${edge.to}" is not a node of this layer`,
        nodeId: edge.to,
      })
    }
  })
  // A decision only communicates a branch when each of its outgoing edges
  // states the condition that takes it.
  const decisionIds = new Set(layer.nodes
    .filter(node => node.type === 'decision')
    .map(node => node.id))
  layer.edges.forEach((edge, index) => {
    if (!decisionIds.has(edge.from)) return
    if ((edge.label ?? '').trim() !== '') return
    issues.add({
      code: 'decision-unlabeled',
      path: `${path}.edges[${index}].label`,
      detail: `the branch out of decision "${edge.from}" needs a condition label`,
      nodeId: edge.from,
    })
  })
  for (const unreachable of unreachableNodes(layer)) {
    const index = layer.nodes.findIndex(node => node.id === unreachable)
    issues.add({
      code: 'node-unreachable',
      path: `${path}.nodes[${index}].id`,
      detail: `node "${unreachable}" is not reachable from the entry node`,
      nodeId: unreachable,
    })
  }
}

/** Node identities not reachable from one layer's entry node. */
function unreachableNodes(layer: PlazaWorkflowLayer): string[] {
  const ids = new Set(layer.nodes.map(node => node.id))
  if (!ids.has(layer.entryNodeId)) return []
  const reached = new Set<string>([layer.entryNodeId])
  const pending = [layer.entryNodeId]
  while (pending.length > 0) {
    const current = pending.pop() as string
    for (const edge of layer.edges) {
      if (edge.from !== current || !ids.has(edge.to) || reached.has(edge.to)) continue
      reached.add(edge.to)
      pending.push(edge.to)
    }
  }
  return [...ids].filter(id => !reached.has(id))
}

/** Nesting depth of every layer reachable from the root layer, root as one. */
function layerDepths(
  workflow: PlazaWorkflow,
  byId: ReadonlyMap<string, PlazaWorkflowLayer>,
): Map<string, number> {
  const depths = new Map<string, number>()
  const root = byId.get(workflow.rootLayerId)
  if (root === undefined) return depths
  const queue: { layer: PlazaWorkflowLayer; depth: number }[] = [{ layer: root, depth: 1 }]
  while (queue.length > 0) {
    const current = queue.shift() as { layer: PlazaWorkflowLayer; depth: number }
    const known = depths.get(current.layer.id)
    if (known !== undefined && known <= current.depth) continue
    depths.set(current.layer.id, current.depth)
    for (const node of current.layer.nodes) {
      if (node.subflowLayerId === undefined) continue
      const child = byId.get(node.subflowLayerId)
      if (child === undefined) continue
      queue.push({ layer: child, depth: current.depth + 1 })
    }
  }
  return depths
}
