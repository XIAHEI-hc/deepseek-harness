/**
 * Plaza page: the sidebar entry's main panel. Routes between the published
 * browse view, one published version's detail pages, the draft list, and the
 * draft editor. Everything it shows belongs to the workspace the page was
 * listed for, so a workspace change remounts the whole view instead of
 * carrying a detail page across.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  PlazaDraftContent, PlazaDraftView, PlazaIssue, PlazaMediaAsset, PlazaSkillEntry,
} from '@deepseek-ai/dsh-skill-plaza/types'
import type { SkillPlazaKey } from './locales.ts'
import { DraftEditorPage } from './DraftEditorPage.tsx'
import { SkillDetailPage } from './SkillDetailPage.tsx'
import { filterCategory, categoriesOf, filterSkills } from './skill-filter.ts'
import css from './PlazaPage.module.css'

/** Drafts and published skills of one workspace, plus a one-shot generated draft to open. */
export interface PlazaSnapshot {
  /** Identity of the workspace these records belong to; a change remounts the page. */
  readonly workspaceKey: string
  /** Drafts visible in this workspace, newest first. */
  readonly drafts: readonly PlazaDraftView[]
  /** Published skills callable in this workspace. */
  readonly skills: readonly PlazaSkillEntry[]
  /** Draft a just-finished generation produced, which the page opens once. */
  readonly pendingDraftId?: string
}

/** One published version as the detail pages read it. */
export interface PlazaDetailView {
  /** Skill identity the version belongs to. */
  readonly skillId: string
  /** Callable name of that version. */
  readonly slug: string
  /** Title of that version. */
  readonly title: string
  /** The exact version read. */
  readonly version: number
  /** ISO timestamp of that version's publication. */
  readonly publishedAt: string
  /** The version's complete content. */
  readonly content: PlazaDraftContent
}

/** Outcome of one plaza mutation. */
export type PlazaMutation =
  | { readonly ok: true; readonly draft?: PlazaDraftView }
  | { readonly ok: false; readonly error: string; readonly conflict?: boolean }

/** Outcome of taking one version into the conversation. */
export type PlazaUseResult =
  | { readonly ok: true; readonly createdSession: boolean }
  | { readonly ok: false; readonly error: string }

/** Injected Host face of the plaza page. */
export interface PlazaPageFace {
  /** Read the workspace's drafts and published skills. */
  load: () => Promise<PlazaSnapshot>
  /**
   * Read one published version.
   * @param skillId - published skill identity.
   * @param version - exact version the page displays.
   */
  detail: (skillId: string, version: number) => Promise<PlazaDetailView>
  /**
   * Read one workspace image as a data URL.
   * @param assetId - workspace media asset.
   */
  media: (assetId: string) => Promise<string>
  /**
   * Store one image in the workspace.
   * @param name - original file name.
   * @param data - base64 file bytes.
   */
  upload: (name: string, data: string) => Promise<PlazaMediaAsset>
  /**
   * Locate the problems that would block publication.
   * @param content - content as the editor currently holds it.
   */
  check: (content: PlazaDraftContent) => Promise<readonly PlazaIssue[]>
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
   * Bind one published version and insert its invocation into a conversation.
   * @param request - the exact version the page displays and an optional example prompt.
   */
  useInConversation: (request: {
    skillId: string
    version: number
    slug: string
    examplePrompt?: string
  }) => Promise<PlazaUseResult>
  /** Note that the pending generated draft was opened. */
  consumePendingDraft: () => void
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

/** Page props plus the workspace state every route below the tabs reads. */
export type PlazaWorkspaceProps = PlazaPageProps & {
  /** Records of the workspace being shown. */
  readonly snapshot: PlazaSnapshot
  /** Refetch the workspace lists after a committed write. */
  readonly reload: () => void
  /** Loaded images, as data URLs, keyed by asset identity. */
  readonly images: Readonly<Record<string, string | undefined>>
  /**
   * Request the images this route shows.
   * @param assetIds - asset identities to load when they are not cached yet.
   */
  readonly requestMedia: (assetIds: readonly string[]) => void
}

/** Where the workspace view currently is. */
type Route =
  | { readonly kind: 'browse' }
  | { readonly kind: 'drafts' }
  | { readonly kind: 'detail'; readonly skillId: string; readonly version: number }
  | { readonly kind: 'editor'; readonly draftId: string }

/** Readable text of a host or transport failure. */
function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

/** Render the plaza page. */
export function PlazaPage(props: PlazaPageProps): ReactNode {
  const t = props.t
  const { load, subscribe } = props
  const [snapshot, setSnapshot] = useState<PlazaSnapshot | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    const run = (): void => {
      void load().then(
        (next) => {
          if (cancelled) return
          setError(undefined)
          setSnapshot(next)
        },
        (failure: unknown) => {
          if (cancelled) return
          setError(messageOf(failure))
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

  const reload = (): void => {
    void load().then(
      (next) => { setSnapshot(next) },
      (failure: unknown) => { setError(messageOf(failure)) },
    )
  }

  if (snapshot === undefined) {
    return (
      <div className={css.page}>
        {error === undefined
          ? <p className={css.empty}>{t('panelHint')}</p>
          : (
            <FailurePanel
              title={t('loadFailed')}
              detail={error}
              retryLabel={t('retry')}
              onRetry={() => { setError(undefined); reload() }}
            />
          )}
      </div>
    )
  }
  return (
    <PlazaWorkspace
      key={snapshot.workspaceKey}
      {...props}
      snapshot={snapshot}
      reload={reload}
      failure={error}
    />
  )
}

/** Browse, draft list, detail, and editor for one workspace. */
function PlazaWorkspace(props: PlazaPageProps & {
  readonly snapshot: PlazaSnapshot
  readonly reload: () => void
  readonly failure: string | undefined
}): ReactNode {
  const t = props.t
  const { snapshot, failure } = props
  const [route, setRoute] = useState<Route>({ kind: 'browse' })
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string | undefined>(undefined)
  const [scrollTop, setScrollTop] = useState(0)
  const mediaRef = useRef<Record<string, string | undefined>>({})
  const inFlight = useRef(new Set<string>())
  const [images, setImages] = useState<Readonly<Record<string, string | undefined>>>({})
  const pending = useRef<string | undefined>(undefined)

  const requestMedia = useCallback((assetIds: readonly string[]): void => {
    for (const assetId of new Set(assetIds)) {
      if (mediaRef.current[assetId] !== undefined || inFlight.current.has(assetId)) continue
      inFlight.current.add(assetId)
      void props.media(assetId).then(
        (dataUrl) => {
          inFlight.current.delete(assetId)
          mediaRef.current = { ...mediaRef.current, [assetId]: dataUrl }
          setImages(mediaRef.current)
        },
        () => { inFlight.current.delete(assetId) },
      )
    }
  }, [props.media])

  const pendingDraftId = snapshot.pendingDraftId
  useEffect(() => {
    if (pendingDraftId === undefined || pending.current === pendingDraftId) return
    pending.current = pendingDraftId
    props.consumePendingDraft()
    setRoute({ kind: 'editor', draftId: pendingDraftId })
  }, [pendingDraftId, props])

  const categories = useMemo(() => categoriesOf(snapshot.skills), [snapshot.skills])
  const visible = filterSkills(filterCategory(snapshot.skills, category), query)
  const { failure: _failure, ...inherited } = props
  const workspace: PlazaWorkspaceProps = { ...inherited, images, requestMedia }
  const opened = route.kind === 'editor'
    ? snapshot.drafts.find(draft => draft.draftId === route.draftId)
    : undefined

  const body = ((): ReactNode => {
    if (route.kind === 'editor') {
      if (opened === undefined) {
        return (
          <FailurePanel
            title={t('draftNotFound')}
            retryLabel={t('retry')}
            onRetry={() => { setRoute({ kind: 'drafts' }) }}
          />
        )
      }
      return (
        <DraftEditorPage
          {...workspace}
          draft={opened}
          onClose={(published) => {
            props.reload()
            setRoute(published ? { kind: 'browse' } : { kind: 'drafts' })
          }}
        />
      )
    }
    if (route.kind === 'detail') {
      return (
        <SkillDetailPage
          {...workspace}
          skillId={route.skillId}
          version={route.version}
          onBack={() => { setRoute({ kind: 'browse' }) }}
        />
      )
    }
    return (
      <>
        <div className={css.tabs} role="tablist" aria-label={t('panel')}>
          <button
            type="button"
            role="tab"
            aria-selected={route.kind === 'browse'}
            className={css.tab}
            onClick={() => { setRoute({ kind: 'browse' }) }}
          >
            {t('tabBrowse')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={route.kind === 'drafts'}
            className={css.tab}
            onClick={() => { setRoute({ kind: 'drafts' }) }}
          >
            {t('tabDrafts')}
          </button>
        </div>
        {route.kind === 'browse'
          ? (
            <BrowseView
              {...workspace}
              skills={visible}
              categories={categories}
              category={category}
              query={query}
              scrollTop={scrollTop}
              onQuery={setQuery}
              onCategory={setCategory}
              onScroll={setScrollTop}
              onOpen={(entry) => {
                setRoute({ kind: 'detail', skillId: entry.skillId, version: entry.version })
              }}
            />
          )
          : (
            <DraftsView
              {...workspace}
              onOpen={(draftId) => { setRoute({ kind: 'editor', draftId }) }}
            />
          )}
      </>
    )
  })()

  return (
    <div className={css.page}>
      {body}
      {failure === undefined ? null : <p className={css.error} role="alert">{failure}</p>}
    </div>
  )
}

/** Page head shared by the browse and draft routes. */
function PageHead(props: {
  readonly title: string
  readonly hint?: string
  readonly action?: ReactNode
}): ReactNode {
  return (
    <header className={css.header}>
      <div>
        <h1 className={css.title}>{props.title}</h1>
        {props.hint === undefined ? null : <p className={css.hint}>{props.hint}</p>}
      </div>
      {props.action}
    </header>
  )
}

/** Published catalog view props. */
type BrowseProps = PlazaWorkspaceProps & {
  readonly skills: readonly PlazaSkillEntry[]
  readonly categories: readonly string[]
  readonly category: string | undefined
  readonly query: string
  readonly scrollTop: number
  readonly onQuery: (query: string) => void
  readonly onCategory: (category: string | undefined) => void
  readonly onScroll: (offset: number) => void
  readonly onOpen: (entry: PlazaSkillEntry) => void
}

/** Published skills as a filterable card grid. */
function BrowseView(props: BrowseProps): ReactNode {
  const t = props.t
  // The catalog's covers load once per distinct set of cover assets, not once
  // per filtered view.
  const coverKey = props.skills.map(entry => entry.coverAssetId ?? '').join('\u0000')
  const { requestMedia } = props
  useEffect(() => {
    requestMedia(coverKey.split('\u0000').filter(assetId => assetId !== ''))
  }, [coverKey, requestMedia])
  const filtered = props.query !== '' || props.category !== undefined
  return (
    <>
      <PageHead title={t('panel')} hint={t('panelHint')} />
      <input
        className={css.search}
        type="search"
        value={props.query}
        placeholder={t('searchPlaceholder')}
        aria-label={t('searchPlaceholder')}
        onChange={(event) => { props.onQuery(event.target.value) }}
      />
      {props.categories.length === 0
        ? null
        : (
          <div className={css.chips} role="group" aria-label={t('categoryLabel')}>
            <button
              type="button"
              className={css.chip}
              aria-pressed={props.category === undefined}
              onClick={() => { props.onCategory(undefined) }}
            >
              {t('categoryAll')}
            </button>
            {props.categories.map(name => (
              <button
                key={name}
                type="button"
                className={css.chip}
                aria-pressed={props.category === name}
                onClick={() => { props.onCategory(name) }}
              >
                {name}
              </button>
            ))}
          </div>
        )}
      <div
        className={css.cards}
        ref={(node) => {
          // Restoring the offset here keeps the returning reader's place without
          // a second render pass over the grid.
          if (node !== null) node.scrollTop = props.scrollTop
        }}
        onScroll={(event) => { props.onScroll(event.currentTarget.scrollTop) }}
      >
        {props.skills.length === 0
          ? (
            <div className={css.emptyState}>
              <p className={css.empty}>{filtered ? t('noResults') : t('noSkills')}</p>
              {filtered
                ? (
                  <button
                    type="button"
                    className={css.button}
                    onClick={() => { props.onQuery(''); props.onCategory(undefined) }}
                  >
                    {t('clearFilters')}
                  </button>
                )
                : null}
            </div>
          )
          : props.skills.map(entry => (
            <SkillCard
              key={entry.skillId}
              entry={entry}
              cover={entry.coverAssetId === undefined ? undefined : props.images[entry.coverAssetId]}
              detailLabel={t('viewDetail')}
              versionLabel={t('version')}
              onOpen={() => { props.onOpen(entry) }}
            />
          ))}
      </div>
    </>
  )
}

/** One catalog card: cover, title, version, purpose, and the detail control. */
function SkillCard(props: {
  readonly entry: PlazaSkillEntry
  readonly cover: string | undefined
  readonly detailLabel: string
  readonly versionLabel: string
  readonly onOpen: () => void
}): ReactNode {
  const entry = props.entry
  return (
    <article className={props.cover === undefined ? `${css.card} ${css.cardPlain}` : css.card}>
      <button type="button" className={css.cardButton} onClick={props.onOpen}>
        <span className={css.cardCover}>
          {props.cover === undefined ? null : <img src={props.cover} alt="" />}
        </span>
        <span className={css.cardBody}>
          <span className={css.cardHeading}>
            <span className={css.cardTitle}>{entry.title}</span>
            <span className={css.cardMeta}>{`${props.versionLabel} ${entry.version}`}</span>
          </span>
          <span className={css.cardDescription}>{entry.description}</span>
          <span className={css.cardLink}>{props.detailLabel}</span>
        </span>
      </button>
    </article>
  )
}

/** Draft list view props. */
type DraftsProps = PlazaWorkspaceProps & {
  readonly onOpen: (draftId: string) => void
}

/** Drafts with their revision and publication state. */
function DraftsView(props: DraftsProps): ReactNode {
  const t = props.t
  const drafts = props.snapshot.drafts
  const [busy, setBusy] = useState(false)
  return (
    <>
      <PageHead
        title={t('tabDrafts')}
        action={(
          <button
            type="button"
            className={css.button}
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void props.save(undefined, EMPTY_CONTENT, undefined).then((result) => {
                setBusy(false)
                if (!result.ok) return
                if (result.draft !== undefined) props.onOpen(result.draft.draftId)
                props.reload()
              })
            }}
          >
            {t('newDraft')}
          </button>
        )}
      />
      {drafts.length === 0
        ? <p className={css.empty}>{t('noDrafts')}</p>
        : (
          <ul className={css.draftList}>
            {drafts.map(draft => (
              <li key={draft.draftId}>
                <button type="button" className={css.draftRow} onClick={() => { props.onOpen(draft.draftId) }}>
                  <span className={css.draftTitle}>{draft.title}</span>
                  <span className={css.draftMeta}>{`/${draft.slug}`}</span>
                  <span className={css.draftMeta}>{`${t('revision')} ${draft.revision}`}</span>
                  <span className={css.draftMeta}>
                    {draft.skillId === undefined ? t('unpublished') : t('published')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
    </>
  )
}

/** A blank draft an author fills in without a source conversation. */
const EMPTY_CONTENT: PlazaDraftContent = {
  title: '',
  slug: '',
  description: '',
  inputs: [],
  steps: [],
  outputs: [],
  verification: '',
  failureHandling: '',
  toolDependencies: [],
  presentation: { schemaVersion: 1 },
}

/** Readable failure state with a single local retry. */
export function FailurePanel(props: {
  readonly title: string
  readonly detail?: string
  readonly retryLabel: string
  readonly onRetry: () => void
}): ReactNode {
  return (
    <div className={css.failure} role="alert">
      <strong>{props.title}</strong>
      {props.detail === undefined ? null : <span className={css.failureDetail}>{props.detail}</span>}
      <button type="button" className={css.button} onClick={props.onRetry}>{props.retryLabel}</button>
    </div>
  )
}

export type { SkillPlazaKey }
