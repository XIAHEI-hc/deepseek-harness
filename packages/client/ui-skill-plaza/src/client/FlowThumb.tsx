/**
 * Catalog thumbnail: the process labels one card shows as a small left-to-right
 * chain. It draws only what the catalog carries — node labels and how many of
 * them branch — so a card can state the shape of a skill without reading its
 * version.
 */
import { useId, type ReactNode } from 'react'
import css from './PlazaPage.module.css'

/** Labels a card draws before the chain is cut off. */
const MAX_LABELS = 4

/** Geometry of one thumbnail variant. */
interface ThumbMetrics {
  readonly width: number
  readonly height: number
  readonly boxHeight: number
  readonly top: number
  readonly fontSize: number
  readonly padding: number
  readonly gap: number
}

/** Card-sized and featured-sized thumbnails. */
const METRICS: Readonly<Record<'card' | 'featured', ThumbMetrics>> = {
  card: { width: 340, height: 96, boxHeight: 46, top: 26, fontSize: 9, padding: 20, gap: 14 },
  featured: { width: 360, height: 156, boxHeight: 60, top: 36, fontSize: 11, padding: 20, gap: 14 },
}

/** Props of the catalog thumbnail. */
export interface FlowThumbProps {
  /** Node labels in execution order, already shortened for a card. */
  readonly labels: readonly string[]
  /** Which size to draw. */
  readonly variant?: 'card' | 'featured'
}

/** Render one catalog thumbnail. */
export function FlowThumb({ labels, variant = 'card' }: FlowThumbProps): ReactNode {
  const markerId = `plaza-thumb-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const shown = labels.slice(0, MAX_LABELS)
  if (shown.length === 0) return null
  const metrics = METRICS[variant]
  const step = (metrics.width - metrics.padding * 2) / shown.length
  const boxWidth = step - metrics.gap
  const available = boxWidth - (variant === 'featured' ? 16 : 10)
  return (
    <svg
      className={variant === 'featured' ? css.thumbFeatured : css.thumbCard}
      viewBox={`0 0 ${metrics.width} ${metrics.height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={shown.join(' → ')}
    >
      <defs>
        <marker id={markerId} markerWidth="6" markerHeight="6" refX="5" refY="2.5" orient="auto">
          <path d="M0 0 L5 2.5 L0 5z" fill="var(--dsw-alias-label-dimmed)" />
        </marker>
      </defs>
      {shown.map((label, index) => {
        const x = metrics.padding + index * step
        const estimated = label.length * metrics.fontSize
        const fit = estimated > available
          ? { textLength: available, lengthAdjust: 'spacingAndGlyphs' as const }
          : {}
        return (
          <g key={`${index}-${label}`}>
            <rect
              x={x}
              y={metrics.top}
              width={boxWidth}
              height={metrics.boxHeight}
              rx={variant === 'featured' ? 9 : 7}
              className={css.thumbBox}
            />
            <circle cx={x + 12} cy={metrics.top + 12} r={variant === 'featured' ? 6 : 5} className={css.thumbIndex} />
            <text
              x={x + 12}
              y={metrics.top + (variant === 'featured' ? 15.5 : 15)}
              textAnchor="middle"
              fontSize={variant === 'featured' ? 7.5 : 7}
              className={css.thumbIndexText}
            >
              {index + 1}
            </text>
            <text
              x={x + boxWidth / 2}
              y={metrics.top + metrics.boxHeight - (variant === 'featured' ? 18 : 14)}
              textAnchor="middle"
              fontSize={metrics.fontSize}
              className={css.thumbLabel}
              {...fit}
            >
              {label}
            </text>
            {index < shown.length - 1
              ? (
                <path
                  d={`M ${x + boxWidth} ${metrics.top + metrics.boxHeight / 2} L ${x + step + 2} ${metrics.top + metrics.boxHeight / 2}`}
                  className={css.thumbEdge}
                  markerEnd={`url(#${markerId})`}
                />
              )
              : null}
          </g>
        )
      })}
    </svg>
  )
}
