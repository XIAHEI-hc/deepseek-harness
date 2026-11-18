/**
 * The two conversation entries of the Skills plaza: the finalized-assistant
 * "Generate skill" action and the composer's published-skill picker.
 *
 * A generation is one task, not one request. The action starts the attempt and
 * the card below the reply paints what the Host reports, so the wait between
 * the click and the draft is visible instead of freezing on a disabled button.
 * Both entries read the same per-Session generation store.
 */
import { useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PlazaSkillEntry } from '@deepseek-ai/dsh-skill-plaza/types'
import type { GenerationStage, GenerationStatus, GenerationStoreProps, GenerationTask } from './generation-store.ts'
import type { SkillPlazaKey } from './locales.ts'
import { filterSkills } from './skill-filter.ts'
import css from './PlazaPage.module.css'
import card from './GenerateCard.module.css'

/** Result of one plaza action the composer or a message entry starts. */
export type PlazaActionResult = { readonly ok: true } | { readonly ok: false; readonly error: string }

/** Injected face of the finalized-assistant generate action. */
export interface GenerateActionFace {
  /**
   * Start the generation this message has no attempt for yet.
   * @param messageId - the finalized assistant message the entry belongs to.
   */
  start: (messageId: string) => void
  /**
   * Show the draft a finished generation produced.
   * @param draftId - draft the plaza page opens.
   */
  openDraft: (draftId: string) => void
}

/** Full props of the generate action. */
export type GenerateActionProps =
  PropsRuntime<'conversation.chat.assistant-actions'>
  & PropsLocale<'skillPlaza'>
  & GenerationStoreProps
  & InjectFace<GenerateActionFace>

/** Render the generate action on a finalized assistant message. */
export function GenerateSkillButton(props: GenerateActionProps): ReactNode {
  const t = props.t
  const messageId = props.messageId
  const task = props.useStore(state => state.tasks[messageId])
  const status = task?.status
  const label = status === undefined
    ? t('generate')
    : status === 'running' ? t('generating') : status === 'succeeded' ? t('generated') : t('regenerate')
  return (
    <button
      type="button"
      className={css.button}
      data-generation={status}
      disabled={status === 'running'}
      onClick={() => {
        if (status === 'running') return
        if (status === 'succeeded') {
          if (task?.draft !== undefined) props.openDraft(task.draft.draftId)
          return
        }
        props.start(messageId)
      }}
    >
      {label}
    </button>
  )
}

/** Injected face of the generation card below one Turn. */
export interface GenerateCardFace {
  /**
   * Stop the attempt this Turn started.
   * @param messageId - the Turn's closing assistant message.
   */
  cancel: (messageId: string) => void
  /**
   * Start the next attempt of the same job.
   * @param messageId - the Turn's closing assistant message.
   */
  retry: (messageId: string) => void
  /**
   * Show the draft this attempt produced.
   * @param draftId - draft the plaza page opens.
   */
  openDraft: (draftId: string) => void
}

/** Full props of the generation card. */
export type GenerateCardProps =
  PropsRuntime<'conversation.chat.turnTail'>
  & PropsLocale<'skillPlaza'>
  & GenerationStoreProps
  & InjectFace<GenerateCardFace>

/** Stages in the order a running attempt reaches them. */
const STAGES: readonly GenerationStage[] = ['harvest', 'distill', 'check', 'save']

/** Locale key naming one stage. */
const STAGE_KEYS: Record<GenerationStage, SkillPlazaKey> = {
  harvest: 'stageHarvest',
  distill: 'stageDistill',
  check: 'stageCheck',
  save: 'stageSave',
}

/**
 * Where one stage row stands: every stage before the reported one finished, the
 * reported one is running, and the rest have not started.
 */
function stageState(task: GenerationTask, stage: GenerationStage): 'done' | 'run' | 'wait' {
  const reached = task.stage === undefined ? STAGES.length : STAGES.indexOf(task.stage)
  const index = STAGES.indexOf(stage)
  if (index < reached) return 'done'
  return index === reached && task.status === 'running' ? 'run' : 'wait'
}

/** Seconds one task has been running, on the browser's clock. */
function elapsedSeconds(task: GenerationTask): number {
  return Math.max(0, Math.round((Date.now() - task.startedAt) / 1000))
}

/** Glyph matching one status. */
function StatusGlyph({ status }: { readonly status: GenerationStatus }): ReactNode {
  if (status === 'succeeded') {
    return (
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M3.6 8.4l2.8 2.8 6-6.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (status === 'failed' || status === 'cancelled') {
    return (
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M5 5l6 6M11 5l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 2.2l1.5 3.6 3.7 1.4-3.7 1.5L8 12.4 6.5 8.7 2.8 7.2 6.5 5.8z"
        stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"
      />
    </svg>
  )
}

/** Stage marker for one row. */
function StageMarker({ state }: { readonly state: 'done' | 'run' | 'wait' }): ReactNode {
  if (state === 'done') {
    return (
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M3.6 8.4l2.8 2.8 6-6.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (state === 'run') return <span className={card.spinner} />
  return <span className={card.pending} />
}

/**
 * Render the generation task of one Turn, or nothing when that Turn has none.
 * @param props - Turn-tail owner currency, localized copy, the Session's task store, and actions.
 * @returns the task card, or null for a Turn that never started a generation.
 */
export function GenerateSkillCard(props: GenerateCardProps): ReactNode {
  const t = props.t
  const messageId = props.messageId
  const task = props.useStore(state => messageId === undefined ? undefined : state.tasks[messageId])
  if (messageId === undefined || task === undefined) return null

  const running = task.status === 'running'
  const draft = task.draft
  return (
    <section className={card.card} data-state={task.status} aria-label={t(task.status === 'succeeded' ? 'cardDone' : task.status === 'failed' ? 'generateFailed' : task.status === 'cancelled' ? 'cardCancelled' : 'cardRunning')}>
      <header className={card.head}>
        <span className={card.glyph}><StatusGlyph status={task.status} /></span>
        <div className={card.headings}>
          <p className={card.title} role="status">
            {task.status === 'succeeded' && draft !== undefined
              ? draft.title
              : task.status === 'succeeded' ? t('cardDone')
                : task.status === 'failed' ? t('generateFailed')
                  : task.status === 'cancelled' ? t('cardCancelled')
                    : t('cardRunning')}
          </p>
          <p className={card.sub}>
            {task.status === 'succeeded' && draft !== undefined
              ? t('cardDraft', { revision: draft.revision })
              : task.status === 'failed' && task.error !== undefined
                ? task.error
                : t('cardSource')}
          </p>
        </div>
        <div className={card.meta}>
          {running ? <span className={card.elapsed}>{t('cardElapsed', { seconds: elapsedSeconds(task) })}</span> : null}
          {running
            ? <button type="button" className={card.ghost} onClick={() => { props.cancel(messageId) }}>{t('cancel')}</button>
            : null}
        </div>
      </header>

      {running
        ? (
          <ol className={card.stages}>
            {STAGES.map((stage) => {
              const state = stageState(task, stage)
              return (
                <li key={stage} data-stage={stage} data-state={state}>
                  <span className={card.marker}><StageMarker state={state} /></span>
                  <span className={card.stageText}>
                    <span className={card.stageName}>{t(STAGE_KEYS[stage])}</span>
                    {stage === 'distill' && state === 'run' && (task.chars ?? 0) > 0
                      ? <span className={card.stageDetail}>{t('stageChars', { count: task.chars ?? 0 })}</span>
                      : null}
                  </span>
                </li>
              )
            })}
          </ol>
        )
        : null}

      {task.status === 'succeeded' && draft !== undefined
        ? (
          <div className={card.result}>
            <p className={card.description}>{draft.description}</p>
            <ul className={card.tags}>
              {draft.category === undefined ? null : <li className={card.tag}>{draft.category}</li>}
              <li className={card.tag}>{t('cardSteps', { count: draft.steps })}</li>
              <li className={card.tag}>{t('cardTools', { count: draft.tools })}</li>
            </ul>
            <div className={card.actions}>
              <button type="button" className={card.primary} onClick={() => { props.openDraft(draft.draftId) }}>{t('openPlaza')}</button>
            </div>
          </div>
        )
        : null}

      {task.status === 'failed' || task.status === 'cancelled'
        ? (
          <div className={card.actions}>
            <button type="button" className={card.secondary} onClick={() => { props.retry(messageId) }}>{t('retry')}</button>
          </div>
        )
        : null}
    </section>
  )
}

/** Injected face of the composer's skill picker. */
export interface SkillPickerFace {
  /** Read the workspace's published skills. */
  catalog: () => Promise<readonly PlazaSkillEntry[]>
  /**
   * Bind one published version and insert its invocation into the draft.
   * @param entry - the published skill the picker displayed.
   */
  pick: (entry: PlazaSkillEntry) => void
}

/** Full props of the composer skill picker. */
export type SkillPickerProps =
  PropsRuntime<'conversation.input.left'>
  & PropsLocale<'skillPlaza'>
  & InjectFace<SkillPickerFace>

/** Render the composer's published-skill picker. */
export function SkillPicker(props: SkillPickerProps): ReactNode {
  const t = props.t
  const [entries, setEntries] = useState<readonly PlazaSkillEntry[] | undefined>(undefined)
  const [query, setQuery] = useState('')
  const visible = entries === undefined ? [] : filterSkills(entries, query)
  return (
    <details
      className={css.picker}
      onToggle={(event) => {
        if (!event.currentTarget.open) return
        void props.catalog().then((skills) => { setEntries(skills) })
      }}
    >
      <summary className={css.button}>{t('selectSkill')}</summary>
      {entries === undefined
        ? null
        : (
          <div className={css.pickerMenu}>
            <input
              className={css.input}
              type="search"
              placeholder={t('searchSkills')}
              aria-label={t('searchSkills')}
              value={query}
              onChange={(event) => { setQuery(event.target.value) }}
            />
            {visible.length === 0
              ? <p className={css.empty}>{t('pickerEmpty')}</p>
              : (
                <ul>
                  {visible.map(entry => (
                    <li key={entry.skillId}>
                      <button
                        type="button"
                        className={css.item}
                        onClick={() => { props.pick(entry) }}
                      >
                        <span>{entry.title}</span>
                        <span className={css.itemMeta}>{entry.slug} · {t('version')} {entry.version}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
          </div>
        )}
    </details>
  )
}

export type { SkillPlazaKey }
/** Sidebar glyph: a shelf of published instructions. */
export function PlazaPanelIcon(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 3.5h6.5v9.5H2.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M11 5.5h2.5v7.5H11z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}
