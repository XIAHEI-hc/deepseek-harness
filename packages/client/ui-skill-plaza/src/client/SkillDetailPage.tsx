/**
 * One published version's detail page. It reads as one document: the result
 * gallery, the process, the scenarios, and the stored body are sections of the
 * same page rather than tabs, and the process view is the primary surface.
 *
 * Reading, the displayed content, and "use in conversation" all address the
 * same version, which the caller passes in. The body is exported separately so
 * the draft editor previews with exactly this rendering instead of a second
 * implementation.
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type {
  PlazaDraftContent, PlazaExample, PlazaSkillEntry,
} from '@deepseek-ai/dsh-skill-plaza/types'
import { FailurePanel, type PlazaWorkspaceProps } from './PlazaPage.tsx'
import { WorkflowView } from './WorkflowView.tsx'
import { displayFlow, flowStats } from './flow-model.ts'
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
    {
      content: PlazaDraftContent
      slug: string
      title: string
      version: number
      publishedAt: string
      body: string
    } | undefined
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
      body={detail.body}
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
  /** Stored model-facing body, absent for a draft that was never published. */
  readonly body?: string
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
  const [lightbox, setLightbox] = useState<string | undefined>(undefined)
  const [activeExample, setActiveExample] = useState(0)
  const [copied, setCopied] = useState(false)
  const flowRef = useRef<HTMLElement>(null)
  const resultsRef = useRef<HTMLElement>(null)
  const scenariosRef = useRef<HTMLElement>(null)
  const packageRef = useRef<HTMLElement>(null)
  const content = props.content
  const presentation = content.presentation
  const examples = presentation?.examples ?? []
  const scenarios = presentation?.scenarios ?? []
  const flow = displayFlow(content)
  const stats = flowStats(content)
  const examplePrompt = presentation?.examplePrompt
  const hasExample = examplePrompt !== undefined && examplePrompt !== ''

  const copyExample = (): void => {
    if (examplePrompt === undefined) return
    void navigator.clipboard.writeText(examplePrompt).then(
      () => { setCopied(true) },
      () => { setCopied(false) },
    )
  }

  const jump = (target: RefObject<HTMLElement | null>): void => {
    target.current?.scrollIntoView({ block: 'start' })
  }

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

      <header className={hasExample ? css.hero : css.heroSolo}>
        <div className={css.heroText}>
          <p className={css.eyebrow}>
            {presentation?.category === undefined || presentation.category === ''
              ? t('panel')
              : presentation.category}
            <span className={css.eyebrowDot} aria-hidden="true">·</span>
            {`${t('version')} ${props.entry.version}`}
          </p>
          <h1 className={css.detailTitle}>{props.entry.title}</h1>
          <p className={css.lead}>{content.description}</p>
          <p className={css.detailMeta}>
            <span className={css.versionChip}>{`${t('version')} ${props.entry.version}`}</span>
            <span className={css.metaMono}>{`/${props.entry.slug}`}</span>
            {props.publishedAt === undefined
              ? null
              : <span>{`${t('publishedAt')} ${props.publishedAt.slice(0, 10)}`}</span>}
            <span>{`${stats.nodes} ${t('processNodes')} · ${t('needsInput')} ${content.inputs.length} · ${t('willOutput')} ${content.outputs.length}`}</span>
          </p>
          <div className={css.heroActions}>
            <button
              type="button"
              className={css.primary}
              disabled={props.busy || props.preview}
              onClick={() => { props.onUse() }}
            >
              {props.busy ? t('preparing') : t('useInChat')}
            </button>
            {hasExample
              ? (
                <button type="button" className={css.button} onClick={copyExample}>
                  {copied ? t('copied') : t('copyExample')}
                </button>
              )
              : null}
          </div>
          {props.notice === undefined ? null : <p className={css.notice} role="status">{props.notice}</p>}
        </div>
        {hasExample
          ? (
            <aside className={css.heroAside}>
              <span className={css.asideLabel}>{t('exampleRequest')}</span>
              <p className={css.asideQuote}>{examplePrompt}</p>
              <button
                type="button"
                className={css.button}
                disabled={props.busy || props.preview}
                onClick={() => { props.onUse(examplePrompt) }}
              >
                {t('useExample')}
              </button>
            </aside>
          )
          : null}
      </header>

      <div className={css.pipeline}>
        <div className={css.pipelineSeg}>
          <span className={css.pipelineLabel}>{t('needsInput')}</span>
          <span className={css.pipelineValue}>{joinOrDash(content.inputs, t('noneYet'))}</span>
        </div>
        <span className={css.pipelineArrow} aria-hidden="true">→</span>
        <div className={css.pipelineSeg}>
          <span className={css.pipelineLabel}>{t('detailWorkflow')}</span>
          <span className={css.pipelineValue}>
            {`${stats.nodes} ${t('processNodes')}`}
            {stats.decisions === 0 ? '' : ` · ${stats.decisions} ${t('decisionNodes')}`}
            {stats.loops === 0 ? '' : ` · ${stats.loops} ${t('loopEdges')}`}
          </span>
        </div>
        <span className={css.pipelineArrow} aria-hidden="true">→</span>
        <div className={css.pipelineSeg}>
          <span className={css.pipelineLabel}>{t('willOutput')}</span>
          <span className={css.pipelineValue}>{joinOrDash(content.outputs, t('noneYet'))}</span>
        </div>
      </div>

      <nav className={css.secNav} aria-label={t('sectionNav')}>
        {scenarios.length === 0
          ? null
          : <button type="button" className={css.secNavItem} onClick={() => { jump(scenariosRef) }}>{t('scenarios')}</button>}
        <button type="button" className={css.secNavItem} onClick={() => { jump(flowRef) }}>{t('detailWorkflow')}</button>
        <button type="button" className={css.secNavItem} onClick={() => { jump(resultsRef) }}>{t('resultExamples')}</button>
        {props.body === undefined
          ? null
          : <button type="button" className={css.secNavItem} onClick={() => { jump(packageRef) }}>{t('packageSection')}</button>}
      </nav>

      {scenarios.length === 0
        ? null
        : (
          <section className={css.block} ref={scenariosRef} aria-label={t('scenarios')}>
            <div className={css.blockHead}>
              <h2 className={css.sectionTitle}>{t('scenarios')}</h2>
            </div>
            <div className={css.scenarioGrid}>
              {scenarios.map((scenario, index) => (
                <div key={`${index}-${scenario}`} className={css.scenarioCard}>
                  <span className={css.scenarioIndex}>{index + 1}</span>
                  <p>{scenario}</p>
                </div>
              ))}
            </div>
          </section>
        )}

      <section className={css.block} ref={flowRef} aria-label={t('detailWorkflow')}>
        <div className={css.blockHead}>
          <h2 className={css.sectionTitle}>{t('detailWorkflow')}</h2>
          <p className={css.blockHint}>{t('workflowHint')}</p>
        </div>
        <WorkflowView
          t={t}
          workflow={flow?.workflow}
          steps={content.steps}
          synthesized={flow?.synthesized === true}
          images={props.images}
          requestMedia={props.requestMedia}
        />
      </section>

      <section className={css.block} ref={resultsRef} aria-label={t('resultExamples')}>
        <div className={css.blockHead}>
          <h2 className={css.sectionTitle}>{t('resultExamples')}</h2>
        </div>
        {examples.length === 0
          ? <p className={css.empty}>{t('noExamples')}</p>
          : (
            <div className={css.resultsGrid}>
              <ExampleGallery
                examples={examples}
                active={activeExample}
                images={props.images}
                onSelect={setActiveExample}
                onEnlarge={setLightbox}
                t={t}
              />
              <div className={css.resultNotes}>
                <Facts title={t('howToVerify')} lines={content.verification === '' ? [] : [content.verification]} />
                <Facts title={t('commonFailures')} lines={content.failureHandling === '' ? [] : [content.failureHandling]} />
              </div>
            </div>
          )}
      </section>

      {props.body === undefined
        ? null
        : (
          <section className={css.block} ref={packageRef} aria-label={t('packageSection')}>
            <div className={css.blockHead}>
              <h2 className={css.sectionTitle}>{t('packageSection')}</h2>
              <p className={css.blockHint}>{t('packageHint')}</p>
            </div>
            <div className={css.packageGrid}>
              <aside className={css.packageFacts}>
                <Facts title={t('toolDependencies')} lines={content.toolDependencies} />
                <Facts title={t('needsInput')} lines={content.inputs} />
              </aside>
              <div className={css.bodyPanel}>
                <div className={css.bodyHead}>
                  <span className={css.bodyTitle}>{t('bodyTitle')}</span>
                  <span className={css.bodyFlag}>{t('bodyReadOnly')}</span>
                </div>
                <SkillBody body={props.body} />
              </div>
            </div>
          </section>
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

/** Join a list for one line, or state that the version names none. */
function joinOrDash(items: readonly string[], empty: string): string {
  return items.length === 0 ? empty : items.join(' · ')
}

/** Result images with a caption, alternative text, and an enlarge control. */
function ExampleGallery(props: {
  readonly examples: readonly PlazaExample[]
  readonly active: number
  readonly images: PlazaWorkspaceProps['images']
  readonly onSelect: (index: number) => void
  readonly onEnlarge: (assetId: string) => void
  readonly t: PlazaWorkspaceProps['t']
}): ReactNode {
  const t = props.t
  const examples = props.examples
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
  readonly lines: readonly string[]
}): ReactNode {
  const lines = props.lines.filter(line => line.trim() !== '')
  if (lines.length === 0) return null
  return (
    <section className={css.factBlock}>
      <h3 className={css.factTitle}>{props.title}</h3>
      <ul className={css.factList}>
        {lines.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}
      </ul>
    </section>
  )
}

/** Read-only rendering of the stored model-facing body. */
function SkillBody({ body }: { readonly body: string }): ReactNode {
  return (
    <div className={css.skillBody}>
      {body.split('\n').map((line, index) => {
        if (line.startsWith('# ')) return <h3 key={index} className={css.bodyH1}>{line.slice(2)}</h3>
        if (line.startsWith('## ')) return <h4 key={index} className={css.bodyH2}>{line.slice(3)}</h4>
        if (line.startsWith('- ')) return <p key={index} className={css.bodyItem}>{`• ${line.slice(2)}`}</p>
        if (/^\d+\.\s/.test(line)) return <p key={index} className={css.bodyItem}>{line}</p>
        if (line.trim() === '') return null
        return <p key={index} className={css.bodyText}>{line}</p>
      })}
    </div>
  )
}
