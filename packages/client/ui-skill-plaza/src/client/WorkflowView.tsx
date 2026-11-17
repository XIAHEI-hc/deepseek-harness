/**
 * The execution-process view: one workflow layer drawn from its edges, the
 * selected node's details beside it, and an equivalent node list below so a
 * narrow screen or a keyboard reaches the same information as a pointer.
 *
 * Selection is remembered per depth, so opening a subflow and coming back
 * leaves the parent node selected.
 */
import { useMemo, useState, type ReactNode } from 'react'
import type {
  PlazaWorkflow, PlazaWorkflowLayer, PlazaWorkflowNode,
} from '@deepseek-ai/dsh-skill-plaza/types'
import type { PlazaWorkspaceProps } from './PlazaPage.tsx'
import { layoutWorkflow, layerOf } from './workflow-layout.ts'
import css from './PlazaPage.module.css'

/** Zoom bounds the canvas offers. */
const MIN_ZOOM = 0.6
const MAX_ZOOM = 1.6

/** Props of the process view. */
export interface WorkflowViewProps {
  /** Dictionary seat. */
  readonly t: PlazaWorkspaceProps['t']
  /** The structured workflow, when the version has one. */
  readonly workflow: PlazaWorkflow | undefined
  /** The version's operating steps, shown when no workflow exists. */
  readonly steps: readonly string[]
  /** Loaded images by asset identity. */
  readonly images: PlazaWorkspaceProps['images']
  /** Request images this view shows. */
  readonly requestMedia: PlazaWorkspaceProps['requestMedia']
}

/** Walk a stack of opening nodes down to the layer currently shown. */
function layerFor(workflow: PlazaWorkflow, stack: readonly PlazaWorkflowNode[]): PlazaWorkflowLayer | undefined {
  let layer = layerOf(workflow, workflow.rootLayerId)
  for (const via of stack) {
    if (layer === undefined) return undefined
    const next = via.subflowLayerId === undefined ? undefined : layerOf(workflow, via.subflowLayerId)
    if (next === undefined) return undefined
    layer = next
  }
  return layer
}

/** Render the process view. */
export function WorkflowView(props: WorkflowViewProps): ReactNode {
  const t = props.t
  const [stack, setStack] = useState<readonly PlazaWorkflowNode[]>([])
  const [selected, setSelected] = useState<Readonly<Record<number, string>>>({})
  const [zoom, setZoom] = useState(1)

  const layer = props.workflow === undefined ? undefined : layerFor(props.workflow, stack)
  const layout = useMemo(() => layer === undefined ? undefined : layoutWorkflow(layer), [layer])

  if (props.workflow === undefined || layer === undefined || layout === undefined) {
    return (
      <div className={css.flow}>
        <p className={css.empty}>{t('workflowEmpty')}</p>
        <section className={css.factBlock}>
          <h3 className={css.factTitle}>{t('stepsFromContent')}</h3>
          <ol className={css.factList}>
            {props.steps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}
          </ol>
        </section>
      </div>
    )
  }
  const depth = stack.length
  const selectedId = selected[depth] ?? layer.entryNodeId
  const node = layer.nodes.find(item => item.id === selectedId)
  const select = (id: string): void => { setSelected({ ...selected, [depth]: id }) }

  return (
    <div className={css.flow}>
      <nav className={css.breadcrumb} aria-label={t('workflowRoot')}>
        <button type="button" className={css.breadcrumbLink} onClick={() => { setStack([]) }}>
          {t('workflowRoot')}
        </button>
        {stack.map((via, index) => (
          <span key={`${via.id}-${index}`} className={css.breadcrumbStep}>
            <span aria-hidden="true">/</span>
            <button
              type="button"
              className={css.breadcrumbLink}
              onClick={() => { setStack(stack.slice(0, index + 1)) }}
            >
              {via.title}
            </button>
          </span>
        ))}
        {stack.length === 0
          ? null
          : (
            <button type="button" className={css.link} onClick={() => { setStack(stack.slice(0, -1)) }}>
              {t('backToParent')}
            </button>
          )}
      </nav>
      <div className={css.flowGrid}>
        <div className={css.canvasFrame}>
          <div className={css.canvasTools}>
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('zoomOut')}
              onClick={() => { setZoom(value => Math.max(MIN_ZOOM, Math.round((value - 0.2) * 10) / 10)) }}
            >
              −
            </button>
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('zoomIn')}
              onClick={() => { setZoom(value => Math.min(MAX_ZOOM, Math.round((value + 0.2) * 10) / 10)) }}
            >
              +
            </button>
            <button type="button" className={css.iconButton} aria-label={t('fitView')} onClick={() => { setZoom(1) }}>
              ⤢
            </button>
          </div>
          <div className={css.canvasScroll}>
            <div className={css.canvasOuter} style={{ width: layout.width * zoom, height: layout.height * zoom }}>
              <div
                className={css.canvas}
                style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}
              >
                <svg
                  className={css.edgeLayer}
                  width={layout.width}
                  height={layout.height}
                  aria-hidden="true"
                  focusable="false"
                >
                  <defs>
                    <marker id="plaza-arrow" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
                      <path className={css.arrowHead} d="M 0 0 L 7 3 L 0 6 z" />
                    </marker>
                  </defs>
                  {layout.edges.map((edge, index) => (
                    <g key={`${edge.edge.from}-${edge.edge.to}-${index}`}>
                      <path className={css.edge} d={edge.path} markerEnd="url(#plaza-arrow)" />
                      {edge.edge.label === undefined || edge.edge.label === ''
                        ? null
                        : (
                          <text className={css.edgeLabel} x={edge.labelX} y={edge.labelY} textAnchor="middle">
                            {edge.edge.label}
                          </text>
                        )}
                    </g>
                  ))}
                </svg>
                {layout.nodes.map(placed => (
                  <button
                    key={placed.node.id}
                    type="button"
                    className={placed.node.type === 'decision' ? css.decision : css.actionNode}
                    aria-pressed={placed.node.id === selectedId}
                    style={{
                      left: placed.x,
                      top: placed.y,
                      width: placed.width,
                      height: placed.height,
                    }}
                    onClick={() => { select(placed.node.id) }}
                  >
                    <span className={css.nodeText}>{placed.node.title}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
        <aside className={css.nodePanel} aria-live="polite">
          {node === undefined
            ? <p className={css.empty}>{t('selectNodeHint')}</p>
            : (
              <NodeDetails
                t={t}
                node={node}
                images={props.images}
                onOpenSubflow={node.subflowLayerId === undefined
                  ? undefined
                  : () => { setStack([...stack, node]) }}
              />
            )}
        </aside>
      </div>
      <section className={css.nodeListBlock} aria-label={t('nodeList')}>
        <h3 className={css.factTitle}>{t('nodeList')}</h3>
        <ul className={css.nodeList}>
          {layer.nodes.map(item => (
            <li key={item.id}>
              <button
                type="button"
                className={css.nodeListRow}
                aria-pressed={item.id === selectedId}
                onClick={() => { select(item.id) }}
              >
                <span className={css.nodeListTitle}>{item.title}</span>
                <span className={css.itemMeta}>
                  {item.type === 'decision' ? t('nodeTypeDecision') : t('nodeTypeAction')}
                </span>
                {item.subflowLayerId === undefined ? null : <span className={css.itemMeta}>{t('openSubflow')}</span>}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

/** One selected node's filled-in details. */
function NodeDetails(props: {
  readonly t: PlazaWorkspaceProps['t']
  readonly node: PlazaWorkflowNode
  readonly images: PlazaWorkspaceProps['images']
  readonly onOpenSubflow: (() => void) | undefined
}): ReactNode {
  const t = props.t
  const node = props.node
  const rows: { label: string; lines: readonly string[] }[] = [
    { label: t('nodePurpose'), lines: node.purpose === undefined ? [] : [node.purpose] },
    { label: t('nodeInputs'), lines: node.inputs ?? [] },
    { label: t('nodeChecks'), lines: node.checks ?? [] },
    { label: t('nodeOutputs'), lines: node.outputs ?? [] },
    { label: t('nodeVerification'), lines: node.verification === undefined ? [] : [node.verification] },
    { label: t('nodeFailure'), lines: node.failureHandling === undefined ? [] : [node.failureHandling] },
  ].filter(row => row.lines.some(line => line.trim() !== ''))
  const assetIds = node.assetIds ?? []
  return (
    <div className={css.nodeDetail}>
      <h3 className={css.nodeDetailTitle}>{node.title}</h3>
      {rows.map(row => (
        <section key={row.label} className={css.factBlock}>
          <h4 className={css.factTitle}>{row.label}</h4>
          <ul className={css.factList}>
            {row.lines.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}
          </ul>
        </section>
      ))}
      {assetIds.length === 0
        ? null
        : (
          <div className={css.nodeImages}>
            {assetIds.map(assetId => (
              props.images[assetId] === undefined
                ? <span key={assetId} className={css.figurePlaceholder} aria-hidden="true" />
                : <img key={assetId} className={css.nodeImage} src={props.images[assetId]} alt={node.title} />
            ))}
          </div>
        )}
      {props.onOpenSubflow === undefined
        ? null
        : (
          <button type="button" className={css.button} onClick={props.onOpenSubflow}>{t('openSubflow')}</button>
        )}
    </div>
  )
}

/**
 * Request the images of every workflow layer.
 * @param workflow - workflow whose node images should load.
 * @param requestMedia - loader the view and editor both use.
 */
export function requestWorkflowMedia(
  workflow: PlazaWorkflow,
  requestMedia: PlazaWorkspaceProps['requestMedia'],
): void {
  requestMedia(workflow.layers.flatMap(layer => layer.nodes.flatMap(node => node.assetIds ?? [])))
}
