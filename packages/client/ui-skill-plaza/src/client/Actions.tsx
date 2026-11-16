/**
 * The two conversation entries: the finalized-assistant "Generate skill"
 * action and the composer's published-skill picker.
 */
import { useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PlazaSkillEntry } from '@deepseek-ai/dsh-skill-plaza/types'
import type { SkillPlazaKey } from './locales.ts'
import { filterSkills } from './skill-filter.ts'
import css from './PlazaPage.module.css'

/** Result of one plaza action the composer or a message entry starts. */
export type PlazaActionResult = { readonly ok: true } | { readonly ok: false; readonly error: string }

/** Injected face of the finalized-assistant generate action. */
export interface GenerateActionFace {
  /**
   * Distill a draft from the message's turn.
   * @param messageId - the finalized assistant message the entry belongs to.
   */
  generate: (messageId: string) => Promise<PlazaActionResult>
  /** Open the plaza panel. */
  openPlaza: () => void
}

/** Full props of the generate action. */
export type GenerateActionProps =
  PropsRuntime<'conversation.chat.assistant-actions'>
  & PropsLocale<'skillPlaza'>
  & InjectFace<GenerateActionFace>

/** Render the generate action on a finalized assistant message. */
export function GenerateSkillButton(props: GenerateActionProps): ReactNode {
  const t = props.t
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  return (
    <>
      <button
        type="button"
        className={css.button}
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setError(undefined)
          void props.generate(props.messageId).then((result) => {
            setBusy(false)
            if (result.ok) {
              props.openPlaza()
              return
            }
            setError(result.error)
          })
        }}
      >
        {busy ? t('generating') : t('generate')}
      </button>
      {error === undefined ? null : <span className={css.error} role="alert">{t('generateFailed')}: {error}</span>}
    </>
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
