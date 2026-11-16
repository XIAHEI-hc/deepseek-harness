/**
 * Plaza page: the sidebar entry's main panel. Lists the workspace's drafts and
 * published skills, and edits one draft through the injected Host face.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PlazaDraftContent, PlazaDraftView, PlazaSkillEntry } from '@deepseek-ai/dsh-skill-plaza/types'
import type { SkillPlazaKey } from './locales.ts'
import css from './PlazaPage.module.css'

/** Workspace records the page renders. */
export interface PlazaSnapshot {
  /** Drafts visible in this workspace, newest first. */
  readonly drafts: readonly PlazaDraftView[]
  /** Published skills callable in this workspace. */
  readonly skills: readonly PlazaSkillEntry[]
}

/** Outcome of one plaza mutation. */
export type PlazaMutation = { readonly ok: true } | { readonly ok: false; readonly error: string }

/** Injected Host face of the plaza page. */
export interface PlazaPageFace {
  /** Read the workspace's drafts and published skills. */
  load: () => Promise<PlazaSnapshot>
  /**
   * Save one draft.
   * @param draftId - draft to update; omission creates one.
   * @param content - replacement content.
   * @param expectedRevision - revision the form was rendered from.
   */
  save: (
    draftId: string | undefined,
    content: PlazaDraftContent,
    expectedRevision: number | undefined,
  ) => Promise<PlazaMutation>
  /**
   * Save the editor's content and publish it as the next immutable version.
   * @param draftId - draft to publish.
   * @param expectedRevision - revision the form was rendered from.
   * @param content - content currently in the editor.
   */
  publish: (draftId: string, expectedRevision: number, content: PlazaDraftContent) => Promise<PlazaMutation>
  /**
   * Observe committed plaza changes.
   * @param listener - callback run after each change notice.
   * @returns unsubscribe.
   */
  subscribe: (listener: () => void) => () => void
}

/** Full props of the plaza page. */
export type PlazaPageProps =
  PropsRuntime<'main'>
  & PropsLocale<'skillPlaza'>
  & InjectFace<PlazaPageFace>

/** Split a textarea into one trimmed entry per line. */
function lines(value: FormDataEntryValue | null): string[] {
  return typeof value === 'string'
    ? value.split('\n').map(line => line.trim()).filter(line => line !== '')
    : []
}

/** Read one text field. */
function field(data: FormData, name: string): string {
  const value = data.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/** Render the plaza page. */
export function PlazaPage(props: PlazaPageProps): ReactNode {
  const t = props.t
  const { load, subscribe } = props
  const [snapshot, setSnapshot] = useState<PlazaSnapshot | undefined>(undefined)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<'save' | 'publish' | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    let cancelled = false
    const run = (): void => {
      void load().then(
        (next) => {
          if (cancelled) return
          setSnapshot(next)
        },
        (failure: unknown) => {
          if (cancelled) return
          setError(failure instanceof Error ? failure.message : String(failure))
        },
      )
    }
    run()
    const unsubscribe = subscribe(run)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [load, subscribe])

  const drafts = snapshot?.drafts ?? []
  const skills = snapshot?.skills ?? []
  const selected = drafts.find(draft => draft.draftId === selectedId) ?? drafts[0]

  const applyResult = (result: PlazaMutation, done: string, reload: () => void): void => {
    setBusy(undefined)
    if (result.ok) {
      setError(undefined)
      setNotice(done)
      reload()
      return
    }
    setNotice(undefined)
    setError(result.error)
  }

  const reload = (): void => {
    void load().then(
      (next) => { setSnapshot(next) },
      (failure: unknown) => { setError(failure instanceof Error ? failure.message : String(failure)) },
    )
  }

  const readContent = (data: FormData): PlazaDraftContent => ({
    title: field(data, 'title'),
    slug: field(data, 'slug'),
    description: field(data, 'description'),
    inputs: lines(data.get('inputs')),
    steps: lines(data.get('steps')),
    outputs: lines(data.get('outputs')),
    verification: field(data, 'verification'),
    failureHandling: field(data, 'failureHandling'),
    toolDependencies: lines(data.get('toolDependencies')),
  })

  return (
    <div className={css.page}>
      <header className={css.header}>
        <h1>{t('panel')}</h1>
        <p className={css.hint}>{t('panelHint')}</p>
      </header>
      <div className={css.columns}>
        <nav className={css.list} aria-label={t('drafts')}>
          <span className={css.sectionLabel}>{t('drafts')}</span>
          {drafts.length === 0 ? <p className={css.empty}>{t('noDrafts')}</p> : null}
          {drafts.map(draft => (
            <button
              key={draft.draftId}
              type="button"
              className={css.item}
              aria-current={draft.draftId === selected?.draftId}
              onClick={() => { setSelectedId(draft.draftId); setNotice(undefined) }}
            >
              <span>{draft.title}</span>
              <span className={css.itemMeta}>{`${draft.slug} · ${t('revision')} ${draft.revision}`}</span>
            </button>
          ))}
          <span className={css.sectionLabel}>{t('published')}</span>
          {skills.length === 0 ? <p className={css.empty}>{t('noSkills')}</p> : null}
          {skills.map(skill => (
            <span key={skill.skillId} className={css.item}>
              <span>{skill.title}</span>
              <span className={css.itemMeta}>{skill.slug} · {t('version')} {skill.version}</span>
            </span>
          ))}
        </nav>
        {selected === undefined
          ? null
          : (
            <form
              key={`${selected.draftId}:${selected.revision}`}
              ref={formRef}
              className={css.editor}
              onSubmit={(event) => {
                event.preventDefault()
                setBusy('save')
                void props.save(selected.draftId, readContent(new FormData(event.currentTarget)), selected.revision)
                  .then((result) => { applyResult(result, t('saved'), reload) })
              }}
            >
              <label className={css.field}>
                {t('fieldTitle')}
                <input className={css.input} name="title" defaultValue={selected.title} required />
              </label>
              <label className={css.field}>
                {t('fieldSlug')}
                <input className={css.input} name="slug" defaultValue={selected.slug} required pattern="[a-z0-9]+(-[a-z0-9]+)*" />
              </label>
              <label className={css.field}>
                {t('fieldDescription')}
                <input className={css.input} name="description" defaultValue={selected.description} required />
              </label>
              <label className={css.field}>
                {t('fieldInputs')}
                <textarea className={css.textarea} name="inputs" defaultValue={selected.inputs.join('\n')} />
              </label>
              <label className={css.field}>
                {t('fieldSteps')}
                <textarea className={css.textarea} name="steps" defaultValue={selected.steps.join('\n')} />
              </label>
              <label className={css.field}>
                {t('fieldOutputs')}
                <textarea className={css.textarea} name="outputs" defaultValue={selected.outputs.join('\n')} />
              </label>
              <label className={css.field}>
                {t('fieldVerification')}
                <textarea className={css.textarea} name="verification" defaultValue={selected.verification} />
              </label>
              <label className={css.field}>
                {t('fieldFailureHandling')}
                <textarea className={css.textarea} name="failureHandling" defaultValue={selected.failureHandling} />
              </label>
              <label className={css.field}>
                {t('fieldTools')}
                <textarea className={css.textarea} name="toolDependencies" defaultValue={selected.toolDependencies.join('\n')} />
              </label>
              <div className={css.actions}>
                <button type="submit" className={css.button} disabled={busy !== undefined}>
                  {busy === 'save' ? t('saving') : t('save')}
                </button>
                <button
                  type="button"
                  className={css.button}
                  disabled={busy !== undefined}
                  onClick={() => {
                    const form = formRef.current
                    /* v8 ignore next -- the publish control renders inside the form it reads */
                    if (form === null) return
                    setBusy('publish')
                    void props.publish(selected.draftId, selected.revision, readContent(new FormData(form)))
                      .then((result) => { applyResult(result, t('published'), reload) })
                  }}
                >
                  {busy === 'publish' ? t('publishing') : t('publish')}
                </button>
                {notice === undefined ? null : <span className={css.status}>{notice}</span>}
              </div>
            </form>
          )}
      </div>
      {error === undefined ? null : <p className={css.error} role="alert">{error}</p>}
    </div>
  )
}

export type { SkillPlazaKey }
