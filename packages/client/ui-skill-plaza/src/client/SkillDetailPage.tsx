/**
 * One published version's detail pages: the overview of results and
 * requirements, the execution process, and the usage notes. Reading, the
 * displayed content, and "use in conversation" all address the same version,
 * which the caller passes in.
 *
 * The body is exported separately so the draft editor previews with exactly
 * this rendering instead of a second implementation.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { PlazaDraftContent, PlazaSkillEntry } from '@deepseek-ai/dsh-skill-plaza/types'
import { FailurePanel, type PlazaWorkspaceProps } from './PlazaPage.tsx'
import { WorkflowView } from './WorkflowView.tsx'
import css from './PlazaPage.module.css'

/** Props of the detail route. */
export type SkillDetailPageProps = PlazaWorkspaceProps & {
  /** Skill identity being read. */
  readonly skillId: string
  /** Exact published version being read. */
  readonly version: number
  /** Return to the catalog. */
  readonly onBack: () => void
}

/** Versions the detail route can show. */
type Tab = 'overview' | 'workflow' | 'usage'

/** Readable text of a host or transport failure. */
function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

/** Collect every media reference one content payload makes. */
export function assetIdsOf(content: PlazaDraftContent): string[] {
  const ids: string[] = []
  const presentation = content.presentation
  if (presentation === undefined) return ids
  if (presentation.coverAssetId !== undefined) ids.push(presentation.coverAssetId)
  for (const example of presentation.examples ?? []) ids.push(example.assetId)
  for (const layer of presentation.workflow?.layers ?? []) {
    for (const node of layer.nodes) {
      for (const assetId of node.assetIds ?? []) ids.push(assetId)
    }
  }
  return ids
}

/** Read one published version, then render it. */
export function SkillDetailPage(props: SkillDetailPageProps): ReactNode {
  const t = props.t
  const [detail, setDetail] = useState<
    { content: PlazaDraftContent; slug: string; title: string; version: number; publishedAt: string } | undefined
  >(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const { requestMedia } = props

  useEffect(() => {
    let cancelled = false
    setDetail(undefined)
    setFailure(undefined)
    void props.detail(props.skillId, props.version).then(
      (value) => {
        if (cancelled) return
        requestMedia(assetIdsOf(value.content))
        setDetail(value)
      },
      (error: unknown) => {
        if (cancelled) return
        setFailure(messageOf(error))
      },
    )
    return () => { cancelled = true }
  }, [props.skillId, props.version, props.detail, requestMedia])

  const use = (examplePrompt?: string): void => {
    if (detail === undefined) return
    setBusy(true)
    setNotice(undefined)
    void props.useInConversation({
      skillId: props.skillId,
      version: props.version,
      slug: detail.slug,
      ...examplePrompt === undefined ? {} : { examplePrompt },
    }).then((result) => {
      setBusy(false)
      setNotice(result.ok
        ? result.createdSession ? t('sessionCreated') : undefined
        : `${t('insertFailed')}: ${result.error}`)
    })
  }

  if (failure !== undefined) {
    return (
      <FailurePanel
        title={t('loadFailed')}
        detail={failure}
        retryLabel={t('retry')}
        onRetry={() => {
          setFailure(undefined)
          void props.detail(props.skillId, props.version).then(
            (value) => { requestMedia(assetIdsOf(value.content)); setDetail(value) },
            (error: unknown) => { setFailure(messageOf(error)) },
          )
        }}
      />
    )
  }
  if (detail === undefined) return <p className={css.empty}>{t('panelHint')}</p>
  return (
    <SkillDetailBody
      {...props}
      entry={{
        skillId: props.skillId,
        slug: detail.slug,
        title: detail.title,
        description: detail.content.description,
        version: detail.version,
        updatedAt: detail.publishedAt,
      }}
      content={detail.content}
      publishedAt={detail.publishedAt}
      preview={false}
      busy={busy}
      notice={notice}
      onUse={use}
      onBack={props.onBack}
    />
  )
}

/** Props shared by the published detail page and the draft preview. */
export interface SkillDetailBodyProps {
  /** Locale and dictionary seat. */
  readonly t: PlazaWorkspaceProps['t']
  /** Catalog identity of the version being shown. */
  readonly entry: PlazaSkillEntry
  /** Content of that version. */
  readonly content: PlazaDraftContent
  /** ISO timestamp of publication, absent for a draft preview. */
  readonly publishedAt?: string
  /** Whether this renders unsaved editor content. */
  readonly preview: boolean
  /** Loaded images by asset identity. */
  readonly images: PlazaWorkspaceProps['images']
  /** Request images this page shows. */
  readonly requestMedia: PlazaWorkspaceProps['requestMedia']
  /** Whether the use-in-conversation action is in flight. */
  readonly busy: boolean
  /** Status line after the use-in-conversation action. */
  readonly notice?: string | undefined
  /** Take this version into the conversation, optionally with an example prompt. */
  readonly onUse: (examplePrompt?: string) => void
  /** Leave this page. */
  readonly onBack?: () => void
  /** Leave a preview. */
  readonly onClosePreview?: () => void
}

/** Render one version without reading anything. */
export function SkillDetailBody(props: SkillDetailBodyProps): ReactNode {
  const t = props.t
  const [tab, setTab] = useState<Tab>('overview')
  const [lightbox, setLightbox] = useState<string | undefined>(undefined)
  const content = props.content
  const presentation = content.presentation
  const examples = presentation?.examples ?? []
  const [activeExample, setActiveExample] = useState(0)
  const workflow = presentation?.workflow

  return (
    <div className={css.detail}>
      <div className={css.detailBar}>
        {props.onBack === undefined ? null : (
          <button type="button" className={css.link} onClick={props.onBack}>{t('backToPlaza')}</button>
        )}
        {props.onClosePreview === undefined
          ? null
          : <button type="button" className={css.link} onClick={props.onClosePreview}>{t('closePreview')}</button>}
        {props.preview ? <span className={css.draftBadge}>{t('draftPreview')}</span> : null}
      </div>
      <header className={css.detailHead}>
        <div className={css.detailHeadText}>
          <h1 className={css.detailTitle}>{props.entry.title}</h1>
          <p className={css.hint}>{content.description}</p>
          <p className={css.detailMeta}>
            <span className={css.versionChip}>{`${t('version')} ${props.entry.version}`}</span>
            <span>{`${t('callName')} /${props.entry.slug}`}</span>
            {props.publishedAt === undefined
              ? null
              : <span>{`${t('publishedAt')} ${props.publishedAt.slice(0, 10)}`}</span>}
          </p>
        </div>
        <button
          type="button"
          className={css.primary}
          disabled={props.busy || props.preview}
          onClick={() => { props.onUse() }}
        >
          {props.busy ? t('preparing') : t('useInChat')}
        </button>
      </header>
      {props.notice === undefined ? null : <p className={css.notice} role="status">{props.notice}</p>}
      <div className={css.tabs} role="tablist" aria-label={props.entry.title}>
        <TabButton id="overview" label={t('detailOverview')} current={tab} onSelect={setTab} />
        <TabButton id="workflow" label={t('detailWorkflow')} current={tab} onSelect={setTab} />
        <TabButton id="usage" label={t('detailUsage')} current={tab} onSelect={setTab} />
      </div>
      {tab === 'overview'
        ? (
          <div className={css.overview}>
            <section className={css.examples} aria-label={t('resultExamples')}>
              <h2 className={css.sectionTitle}>{t('resultExamples')}</h2>
              {examples.length === 0
                ? <p className={css.empty}>{t('noExamples')}</p>
                : (
                  <ExampleGallery
                    examples={examples}
                    active={activeExample}
                    images={props.images}
                    onSelect={setActiveExample}
                    onEnlarge={setLightbox}
                    t={t}
                  />
                )}
            </section>
            <aside className={css.facts}>
              <Facts title={t('scenarios')} lines={presentation?.scenarios} />
              <Facts title={t('needsInput')} lines={content.inputs} />
              <Facts title={t('willOutput')} lines={content.outputs} />
              <Facts title={t('toolDependencies')} lines={content.toolDependencies} />
            </aside>
          </div>
        )
        : null}
      {tab === 'workflow'
        ? (
          <WorkflowView
            t={t}
            workflow={workflow}
            steps={content.steps}
            images={props.images}
            requestMedia={props.requestMedia}
          />
        )
        : null}
      {tab === 'usage'
        ? (
          <div className={css.usage}>
            <Facts title={t('preparation')} lines={content.steps} ordered />
            <Facts title={t('expectedResult')} lines={content.outputs} />
            {content.verification === '' ? null : <Article title={t('howToVerify')} body={content.verification} />}
            {content.failureHandling === ''
              ? null
              : <Article title={t('commonFailures')} body={content.failureHandling} />}
          </div>
        )
        : null}
      {presentation?.examplePrompt === undefined || props.preview
        ? null
        : (
          <div className={css.tryRow}>
            <span className={css.tryLabel}>{t('exampleRequest')}</span>
            <p className={css.tryPrompt}>{presentation.examplePrompt}</p>
            <button
              type="button"
              className={css.button}
              disabled={props.busy}
              onClick={() => { props.onUse(presentation.examplePrompt) }}
            >
              {t('useExample')}
            </button>
          </div>
        )}
      {lightbox === undefined
        ? null
        : (
          <Lightbox
            src={props.images[lightbox]}
            alt={examples.find(example => example.assetId === lightbox)?.alt ?? t('imageAlt')}
            closeLabel={t('closeImage')}
            onClose={() => { setLightbox(undefined) }}
          />
        )}
    </div>
  )
}

/** One tab control. */
function TabButton(props: {
  readonly id: Tab
  readonly label: string
  readonly current: Tab
  readonly onSelect: (tab: Tab) => void
}): ReactNode {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.current === props.id}
      className={css.tab}
      onClick={() => { props.onSelect(props.id) }}
    >
      {props.label}
    </button>
  )
}

/** Result images with a caption, alternative text, and an enlarge control. */
function ExampleGallery(props: {
  readonly examples: NonNullable<PlazaDraftContent['presentation']>['examples']
  readonly active: number
  readonly images: PlazaWorkspaceProps['images']
  readonly onSelect: (index: number) => void
  readonly onEnlarge: (assetId: string) => void
  readonly t: PlazaWorkspaceProps['t']
}): ReactNode {
  const t = props.t
  const examples = props.examples ?? []
  const index = Math.min(props.active, examples.length - 1)
  const example = examples[index]
  if (example === undefined) return null
  const src = props.images[example.assetId]
  return (
    <figure className={css.figure}>
      <button
        type="button"
        className={css.figureButton}
        onClick={() => { props.onEnlarge(example.assetId) }}
        aria-label={t('enlargeImage')}
      >
        {src === undefined
          ? <span className={css.figurePlaceholder} aria-hidden="true" />
          : <img className={css.figureImage} src={src} alt={example.alt} />}
      </button>
      <figcaption className={css.figureCaption}>
        {example.title === '' ? null : <strong>{example.title}</strong>}
        <span>{example.caption}</span>
      </figcaption>
      {examples.length <= 1
        ? null
        : (
          <div className={css.thumbs} role="tablist" aria-label={t('resultExamples')}>
            {examples.map((item, itemIndex) => (
              <button
                key={`${item.assetId}-${itemIndex}`}
                type="button"
                role="tab"
                aria-selected={itemIndex === index}
                className={css.thumb}
                onClick={() => { props.onSelect(itemIndex) }}
              >
                {props.images[item.assetId] === undefined
                  ? <span className={css.thumbPlaceholder} aria-hidden="true" />
                  : <img src={props.images[item.assetId]} alt={item.alt} />}
              </button>
            ))}
          </div>
        )}
    </figure>
  )
}

/** Enlarged image overlay; Escape and the close control both dismiss it. */
function Lightbox(props: {
  readonly src: string | undefined
  readonly alt: string
  readonly closeLabel: string
  readonly onClose: () => void
}): ReactNode {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [props])
  return (
    <div
      className={css.lightbox}
      role="dialog"
      aria-modal="true"
      aria-label={props.alt}
      onClick={props.onClose}
    >
      {props.src === undefined ? null : <img className={css.lightboxImage} src={props.src} alt={props.alt} />}
      <button type="button" className={css.lightboxClose} onClick={props.onClose}>{props.closeLabel}</button>
    </div>
  )
}

/** One titled fact list; renders nothing when every line is empty. */
function Facts(props: {
  readonly title: string
  readonly lines: readonly string[] | undefined
  readonly ordered?: boolean
}): ReactNode {
  const lines = (props.lines ?? []).filter(line => line.trim() !== '')
  if (lines.length === 0) return null
  const items = lines.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)
  return (
    <section className={css.factBlock}>
      <h3 className={css.factTitle}>{props.title}</h3>
      {props.ordered === true ? <ol className={css.factList}>{items}</ol> : <ul className={css.factList}>{items}</ul>}
    </section>
  )
}

/** One titled prose block. */
function Article(props: { readonly title: string; readonly body: string }): ReactNode {
  return (
    <section className={css.factBlock}>
      <h3 className={css.factTitle}>{props.title}</h3>
      <p className={css.prose}>{props.body}</p>
    </section>
  )
}
