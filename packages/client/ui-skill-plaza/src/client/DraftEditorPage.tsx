/**
 * Draft editor: display content of one draft, laid out in three sections —
 * basics, result examples, and the execution process. The operating steps stay
 * independent content the model follows; the process graph is display data the
 * editor never derives instructions from.
 *
 * Publication asks the Host to validate the live content first, so the same
 * located problems mark the editor and block the publication.
 */
import { useState, type ReactNode } from 'react'
import type {
  PlazaDraftContent, PlazaDraftView, PlazaExample, PlazaIssue, PlazaPresentation,
  PlazaWorkflow, PlazaWorkflowLayer, PlazaWorkflowNode,
} from '@deepseek-ai/dsh-skill-plaza/types'
import type { PlazaWorkspaceProps } from './PlazaPage.tsx'
import { SkillDetailBody } from './SkillDetailPage.tsx'
import {
  appendLayer, layerOf, mintNodeId, removeLayerTree, replaceLayer,
} from './workflow-layout.ts'
import css from './PlazaPage.module.css'

/** Props of the draft editor route. */
export type DraftEditorPageProps = PlazaWorkspaceProps & {
  /** The draft being edited. */
  readonly draft: PlazaDraftView
  /** Leave the editor; `true` after a successful publication. */
  readonly onClose: (published: boolean) => void
}

/** Editor sections. */
type Section = 'basics' | 'examples' | 'workflow'

/** Readable text of a host or transport failure. */
function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

/** Split one textarea value into content lines without dropping empty rows. */
function linesOf(value: string): string[] {
  return value.split('\n').map(line => line.trim())
}

/** Drop empty rows so a half-typed line never becomes a published bullet. */
function compactLines(lines: readonly string[]): string[] {
  return lines.filter(line => line !== '')
}

/** Normalize content for saving, checking, and previewing. */
function normalize(content: PlazaDraftContent): PlazaDraftContent {
  const presentation = content.presentation
  return {
    ...content,
    inputs: compactLines(content.inputs),
    steps: compactLines(content.steps),
    outputs: compactLines(content.outputs),
    toolDependencies: compactLines(content.toolDependencies),
    ...presentation === undefined ? {} : { presentation: compactPresentation(presentation) },
  }
}

/** Normalize every presentation list the same way. */
function compactPresentation(presentation: PlazaPresentation): PlazaPresentation {
  const workflow = presentation.workflow
  return {
    ...presentation,
    ...presentation.scenarios === undefined ? {} : { scenarios: compactLines(presentation.scenarios) },
    ...workflow === undefined ? {} : {
      workflow: {
        ...workflow,
        layers: workflow.layers.map(layer => ({
          ...layer,
          nodes: layer.nodes.map(node => ({
            ...node,
            ...node.inputs === undefined ? {} : { inputs: compactLines(node.inputs) },
            ...node.checks === undefined ? {} : { checks: compactLines(node.checks) },
            ...node.outputs === undefined ? {} : { outputs: compactLines(node.outputs) },
          })),
        })),
      },
    },
  }
}

/** Read a file as base64 without the data URL prefix. */
async function readBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (const byte of buffer) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Render the draft editor. */
export function DraftEditorPage(props: DraftEditorPageProps): ReactNode {
  const t = props.t
  const [content, setContent] = useState<PlazaDraftContent>(() => copyContent(props.draft))
  const [revision, setRevision] = useState(props.draft.revision)
  const [section, setSection] = useState<Section>('basics')
  const [busy, setBusy] = useState<'save' | 'publish' | 'check' | undefined>(undefined)
  const [issues, setIssues] = useState<readonly PlazaIssue[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [conflict, setConflict] = useState<string | undefined>(undefined)
  const [preview, setPreview] = useState(false)

  const live = normalize(content)
  const presentation: PlazaPresentation = live.presentation ?? { schemaVersion: 1 }
  const update = (next: PlazaDraftContent): void => { setContent(next); setNotice(undefined) }
  const patch = (partial: Partial<PlazaDraftContent>): void => { update({ ...live, ...partial }) }
  const patchPresentation = (partial: Partial<PlazaPresentation>): void => {
    update({ ...live, presentation: { ...presentation, ...partial } })
  }

  const run = (kind: 'save' | 'publish' | 'check', action: () => Promise<void>): void => {
    setBusy(kind)
    setError(undefined)
    void action().finally(() => { setBusy(undefined) })
  }

  const save = (): void => {
    run('save', async () => {
      const result = await props.save(props.draft.draftId, live, revision)
      if (result.ok) {
        setConflict(undefined)
        if (result.draft !== undefined) setRevision(result.draft.revision)
        setNotice(t('saved'))
        props.reload()
        return
      }
      if (result.conflict === true) {
        setConflict(result.error)
        return
      }
      setError(result.error)
    })
  }

  const publish = (): void => {
    run('publish', async () => {
      const found = await props.check(live)
      setIssues(found)
      if (found.length > 0) {
        setNotice(t('publishBlocked'))
        return
      }
      const result = await props.publish(props.draft.draftId, revision, live)
      if (result.ok) {
        props.onClose(true)
        return
      }
      if (result.conflict === true) {
        setConflict(result.error)
        return
      }
      setError(result.error)
    })
  }

  const check = (): void => {
    run('check', async () => {
      setIssues(await props.check(live))
      setNotice(undefined)
    })
  }

  const reloadLatest = (): void => {
    void props.load().then(
      (snapshot) => {
        const fresh = snapshot.drafts.find(draft => draft.draftId === props.draft.draftId)
        if (fresh === undefined) {
          setError(t('draftNotFound'))
          return
        }
        setContent(copyContent(fresh))
        setRevision(fresh.revision)
        setConflict(undefined)
        setIssues([])
        setNotice(undefined)
        props.reload()
      },
      (failure: unknown) => { setError(messageOf(failure)) },
    )
  }

  const copyLocal = (): void => {
    const text = JSON.stringify(live, null, 2)
    void navigator.clipboard.writeText(text).then(
      () => { setNotice(t('copied')) },
      () => { setError(text) },
    )
  }

  const actions = (
    <EditorActions
      t={t}
      busy={busy}
      notice={notice}
      error={error}
      previewing={preview}
      onSave={save}
      onPublish={publish}
      onCheck={check}
      onPreview={() => { setPreview(!preview) }}
      onClose={() => { props.onClose(false) }}
    />
  )

  if (preview) {
    return (
      <div className={css.page}>
        <SkillDetailBody
          t={t}
          entry={{
            skillId: props.draft.skillId ?? props.draft.draftId,
            slug: live.slug,
            title: live.title,
            description: live.description,
            version: revision,
            updatedAt: props.draft.updatedAt,
          }}
          content={live}
          preview
          images={props.images}
          requestMedia={props.requestMedia}
          busy={busy !== undefined}
          onUse={() => { setNotice(t('draftPreview')) }}
          onClosePreview={() => { setPreview(false) }}
        />
        {actions}
      </div>
    )
  }

  return (
    <div className={css.page}>
      <header className={css.header}>
        <div>
          <h1 className={css.title}>{live.title === '' ? t('newDraft') : live.title}</h1>
          <p className={css.hint}>{`${t('revision')} ${revision} · /${live.slug}`}</p>
        </div>
        <button type="button" className={css.link} onClick={() => { props.onClose(false) }}>{t('cancel')}</button>
      </header>
      <div className={css.tabs} role="tablist" aria-label={t('editorBasics')}>
        {(['basics', 'examples', 'workflow'] as const).map(id => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={section === id}
            className={css.tab}
            onClick={() => { setSection(id) }}
          >
            {t(id === 'basics' ? 'editorBasics' : id === 'examples' ? 'editorExamples' : 'editorWorkflow')}
          </button>
        ))}
      </div>
      {section === 'basics'
        ? <BasicsSection t={t} content={live} patch={patch} patchPresentation={patchPresentation} />
        : null}
      {section === 'examples'
        ? (
          <ExamplesSection
            t={t}
            presentation={presentation}
            patchPresentation={patchPresentation}
            images={props.images}
            requestMedia={props.requestMedia}
            upload={props.upload}
          />
        )
        : null}
      {section === 'workflow'
        ? (
          <WorkflowSection
            t={t}
            presentation={presentation}
            patchPresentation={patchPresentation}
          />
        )
        : null}
      {conflict === undefined
        ? null
        : (
          <div className={css.conflict} role="alert">
            <strong>{t('conflictTitle')}</strong>
            <p>{t('conflictBody')}</p>
            <p className={css.failureDetail}>{conflict}</p>
            <div className={css.actions}>
              <button type="button" className={css.button} onClick={copyLocal}>{t('copyLocal')}</button>
              <button type="button" className={css.button} onClick={reloadLatest}>{t('reloadLatest')}</button>
            </div>
          </div>
        )}
      {issues.length === 0
        ? null
        : (
          <section className={css.issues} aria-label={t('issuesTitle')}>
            <h2 className={css.sectionTitle}>{`${t('issuesTitle')} · ${issues.length} ${t('issuesCount')}`}</h2>
            <ul className={css.issueList}>
              {issues.map(issue => (
                <li key={`${issue.path}-${issue.code}`}>
                  <code className={css.issuePath}>{issue.path}</code>
                  <span>{issue.detail}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      {actions}
    </div>
  )
}

/** Copy one stored draft's editable content. */
function copyContent(draft: PlazaDraftView | PlazaDraftContent): PlazaDraftContent {
  return {
    title: draft.title,
    slug: draft.slug,
    description: draft.description,
    inputs: [...draft.inputs],
    steps: [...draft.steps],
    outputs: [...draft.outputs],
    verification: draft.verification,
    failureHandling: draft.failureHandling,
    toolDependencies: [...draft.toolDependencies],
    ...draft.presentation === undefined ? {} : { presentation: draft.presentation },
  }
}

/** Save, publish, preview, and the status line under the sections. */
function EditorActions(props: {
  readonly t: PlazaWorkspaceProps['t']
  readonly busy: 'save' | 'publish' | 'check' | undefined
  readonly notice: string | undefined
  readonly error: string | undefined
  readonly previewing: boolean
  readonly onSave: () => void
  readonly onPublish: () => void
  readonly onCheck: () => void
  readonly onPreview: () => void
  readonly onClose: () => void
}): ReactNode {
  const t = props.t
  return (
    <div className={css.actions}>
      <button type="button" className={css.primary} disabled={props.busy !== undefined} onClick={props.onPublish}>
        {props.busy === 'publish' ? t('publishing') : t('publish')}
      </button>
      <button type="button" className={css.button} disabled={props.busy !== undefined} onClick={props.onSave}>
        {props.busy === 'save' ? t('saving') : t('save')}
      </button>
      <button type="button" className={css.button} disabled={props.busy !== undefined} onClick={props.onCheck}>
        {props.busy === 'check' ? t('checkRunning') : t('checkContent')}
      </button>
      <button type="button" className={css.button} disabled={props.busy !== undefined} onClick={props.onPreview}>
        {props.previewing ? t('closePreview') : t('preview')}
      </button>
      <button type="button" className={css.link} onClick={props.onClose}>{t('cancel')}</button>
      {props.notice === undefined ? null : <span className={css.status}>{props.notice}</span>}
      {props.error === undefined ? null : <span className={css.error} role="alert">{props.error}</span>}
    </div>
  )
}

/** Text field bound to one content value. */
function Field(props: {
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly multiline?: boolean
  readonly required?: boolean
}): ReactNode {
  return (
    <label className={css.field}>
      <span className={css.fieldLabel}>{props.label}</span>
      {props.multiline === true
        ? (
          <textarea
            className={css.textarea}
            value={props.value}
            onChange={(event) => { props.onChange(event.target.value) }}
          />
        )
        : (
          <input
            className={css.input}
            value={props.value}
            required={props.required}
            onChange={(event) => { props.onChange(event.target.value) }}
          />
        )}
    </label>
  )
}

/** The operating content of one draft. */
function BasicsSection(props: {
  readonly t: PlazaWorkspaceProps['t']
  readonly content: PlazaDraftContent
  readonly patch: (partial: Partial<PlazaDraftContent>) => void
  readonly patchPresentation: (partial: Partial<PlazaPresentation>) => void
}): ReactNode {
  const t = props.t
  const content = props.content
  const presentation = content.presentation ?? { schemaVersion: 1 as const }
  return (
    <div className={css.editor}>
      <Field label={t('fieldTitle')} value={content.title} required onChange={(value) => { props.patch({ title: value }) }} />
      <Field label={t('fieldSlug')} value={content.slug} required onChange={(value) => { props.patch({ slug: value }) }} />
      <Field
        label={t('fieldDescription')}
        value={content.description}
        required
        onChange={(value) => { props.patch({ description: value }) }}
      />
      <Field
        label={t('fieldCategory')}
        value={presentation.category ?? ''}
        onChange={(value) => { props.patchPresentation({ category: value }) }}
      />
      <Field
        label={t('fieldScenarios')}
        value={(presentation.scenarios ?? []).join('\n')}
        multiline
        onChange={(value) => { props.patchPresentation({ scenarios: linesOf(value) }) }}
      />
      <Field
        label={t('fieldInputs')}
        value={content.inputs.join('\n')}
        multiline
        onChange={(value) => { props.patch({ inputs: linesOf(value) }) }}
      />
      <Field
        label={t('fieldSteps')}
        value={content.steps.join('\n')}
        multiline
        onChange={(value) => { props.patch({ steps: linesOf(value) }) }}
      />
      <p className={css.hint}>{t('stepsMismatch')}</p>
      <Field
        label={t('fieldOutputs')}
        value={content.outputs.join('\n')}
        multiline
        onChange={(value) => { props.patch({ outputs: linesOf(value) }) }}
      />
      <Field
        label={t('fieldVerification')}
        value={content.verification}
        multiline
        onChange={(value) => { props.patch({ verification: value }) }}
      />
      <Field
        label={t('fieldFailureHandling')}
        value={content.failureHandling}
        multiline
        onChange={(value) => { props.patch({ failureHandling: value }) }}
      />
      <Field
        label={t('fieldTools')}
        value={content.toolDependencies.join('\n')}
        multiline
        onChange={(value) => { props.patch({ toolDependencies: linesOf(value) }) }}
      />
      <Field
        label={t('fieldExamplePrompt')}
        value={presentation.examplePrompt ?? ''}
        multiline
        onChange={(value) => { props.patchPresentation({ examplePrompt: value }) }}
      />
    </div>
  )
}

/** Result examples, their media, and the cover choice. */
function ExamplesSection(props: {
  readonly t: PlazaWorkspaceProps['t']
  readonly presentation: PlazaPresentation
  readonly patchPresentation: (partial: Partial<PlazaPresentation>) => void
  readonly images: PlazaWorkspaceProps['images']
  readonly requestMedia: PlazaWorkspaceProps['requestMedia']
  readonly upload: PlazaWorkspaceProps['upload']
}): ReactNode {
  const t = props.t
  const examples = props.presentation.examples ?? []
  const [error, setError] = useState<string | undefined>(undefined)
  const [uploading, setUploading] = useState<number | undefined>(undefined)
  const write = (next: readonly PlazaExample[]): void => { props.patchPresentation({ examples: next }) }
  const patchAt = (index: number, partial: Partial<PlazaExample>): void => {
    write(examples.map((item, itemIndex) => itemIndex === index ? { ...item, ...partial } : item))
  }
  return (
    <div className={css.editor}>
      {error === undefined ? null : <p className={css.error} role="alert">{`${t('uploadFailed')}: ${error}`}</p>}
      {examples.map((example, index) => (
        <div key={`${index}-${example.assetId}`} className={css.exampleCard}>
          <div className={css.examplePreview}>
            {props.images[example.assetId] === undefined
              ? <span className={css.figurePlaceholder}>{t('noAsset')}</span>
              : <img className={css.nodeImage} src={props.images[example.assetId]} alt={example.alt} />}
          </div>
          <div className={css.exampleFields}>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('uploadImage')}</span>
              <input
                className={css.input}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={uploading !== undefined}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file === undefined) return
                  setUploading(index)
                  setError(undefined)
                  void readBase64(file)
                    .then(data => props.upload(file.name, data))
                    .then(
                      (asset) => {
                        patchAt(index, { assetId: asset.assetId })
                        props.requestMedia([asset.assetId])
                        if (props.presentation.coverAssetId === undefined) {
                          props.patchPresentation({ coverAssetId: asset.assetId })
                        }
                        setUploading(undefined)
                      },
                      (failure: unknown) => {
                        setUploading(undefined)
                        setError(messageOf(failure))
                      },
                    )
                }}
              />
            </label>
            <Field label={t('exampleTitle')} value={example.title} onChange={(value) => { patchAt(index, { title: value }) }} />
            <Field label={t('exampleCaption')} value={example.caption} onChange={(value) => { patchAt(index, { caption: value }) }} />
            <Field label={t('exampleAlt')} value={example.alt} onChange={(value) => { patchAt(index, { alt: value }) }} />
            <div className={css.actions}>
              <button
                type="button"
                className={css.button}
                onClick={() => { props.patchPresentation({ coverAssetId: example.assetId }) }}
              >
                {props.presentation.coverAssetId === example.assetId ? t('coverBadge') : t('setCover')}
              </button>
              <button
                type="button"
                className={css.button}
                disabled={index === 0}
                onClick={() => {
                  const reordered = [...examples]
                  const [moved] = reordered.splice(index, 1)
                  if (moved === undefined) return
                  reordered.splice(index - 1, 0, moved)
                  write(reordered)
                }}
              >
                {t('moveUp')}
              </button>
              <button
                type="button"
                className={css.button}
                disabled={index === examples.length - 1}
                onClick={() => {
                  const reordered = [...examples]
                  const [moved] = reordered.splice(index, 1)
                  if (moved === undefined) return
                  reordered.splice(index + 1, 0, moved)
                  write(reordered)
                }}
              >
                {t('moveDown')}
              </button>
              <button type="button" className={css.link} onClick={() => { write(examples.filter((_, item) => item !== index)) }}>
                {t('remove')}
              </button>
              {uploading === index ? <span className={css.status}>{t('uploading')}</span> : null}
            </div>
          </div>
        </div>
      ))}
      <div className={css.actions}>
        <button
          type="button"
          className={css.button}
          onClick={() => { write([...examples, { assetId: '', title: '', alt: '', caption: '' }]) }}
        >
          {t('addExample')}
        </button>
      </div>
    </div>
  )
}

/** The structured process of one draft, layer by layer. */
function WorkflowSection(props: {
  readonly t: PlazaWorkspaceProps['t']
  readonly presentation: PlazaPresentation
  readonly patchPresentation: (partial: Partial<PlazaPresentation>) => void
}): ReactNode {
  const t = props.t
  const workflow = props.presentation.workflow
  const assetChoices = (props.presentation.examples ?? [])
    .map(example => example.assetId)
    .filter(assetId => assetId !== '')
  if (workflow === undefined) {
    return (
      <div className={css.editor}>
        <p className={css.empty}>{t('workflowEmpty')}</p>
        <button
          type="button"
          className={css.button}
          onClick={() => {
            props.patchPresentation({
              workflow: { rootLayerId: 'flow-1', layers: [{ id: 'flow-1', entryNodeId: '', nodes: [], edges: [] }] },
            })
          }}
        >
          {t('addNode')}
        </button>
      </div>
    )
  }
  return (
    <WorkflowLayerEditor
      t={t}
      workflow={workflow}
      layerId={workflow.rootLayerId}
      onChange={(next) => { props.patchPresentation({ workflow: next }) }}
      assetChoices={assetChoices}
      depth={1}
    />
  )
}

/** Edit one workflow layer, with each node able to open its own layer. */
function WorkflowLayerEditor(props: {
  readonly t: PlazaWorkspaceProps['t']
  readonly workflow: PlazaWorkflow
  readonly layerId: string
  readonly onChange: (workflow: PlazaWorkflow) => void
  readonly assetChoices: readonly string[]
  readonly depth: number
}): ReactNode {
  const t = props.t
  const layer = layerOf(props.workflow, props.layerId)
  const [draftEdge, setDraftEdge] = useState<{ from: string; to: string; label: string }>({ from: '', to: '', label: '' })
  if (layer === undefined) return null
  const writeLayer = (next: PlazaWorkflowLayer): void => {
    props.onChange(replaceLayer(props.workflow, layer.id, next))
  }
  const replaceNode = (index: number, partial: Partial<PlazaWorkflowNode>): void => {
    writeLayer({
      ...layer,
      nodes: layer.nodes.map((node, nodeIndex) => nodeIndex === index ? { ...node, ...partial } : node),
    })
  }
  return (
    <div className={css.editor}>
      <div className={css.actions}>
        <button
          type="button"
          className={css.button}
          onClick={() => {
            const id = mintNodeId(layer)
            writeLayer({
              ...layer,
              entryNodeId: layer.entryNodeId === '' ? id : layer.entryNodeId,
              nodes: [...layer.nodes, { id, type: 'action', title: '' }],
            })
          }}
        >
          {t('addNode')}
        </button>
        <span className={css.status}>{`${t('entryNode')}: ${layer.entryNodeId === '' ? '—' : layer.entryNodeId}`}</span>
      </div>
      {layer.nodes.map((node, index) => (
        <div key={node.id} className={css.nodeCard}>
          <div className={css.nodeCardHead}>
            <code className={css.issuePath}>{node.id}</code>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('fieldNodeTitle')}</span>
              <input
                className={css.input}
                value={node.title}
                onChange={(event) => { replaceNode(index, { title: event.target.value }) }}
              />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('nodeTypeAction')}</span>
              <select
                className={css.input}
                value={node.type}
                onChange={(event) => {
                  replaceNode(index, { type: event.target.value === 'decision' ? 'decision' : 'action' })
                }}
              >
                <option value="action">{t('nodeTypeAction')}</option>
                <option value="decision">{t('nodeTypeDecision')}</option>
              </select>
            </label>
          </div>
          <Field
            label={t('fieldNodePurpose')}
            value={node.purpose ?? ''}
            multiline
            onChange={(value) => { replaceNode(index, { purpose: value }) }}
          />
          {node.type === 'decision'
            ? (
              <Field
                label={t('fieldNodeChecks')}
                value={(node.checks ?? []).join('\n')}
                multiline
                onChange={(value) => { replaceNode(index, { checks: linesOf(value) }) }}
              />
            )
            : null}
          <Field
            label={t('fieldNodeInputs')}
            value={(node.inputs ?? []).join('\n')}
            multiline
            onChange={(value) => { replaceNode(index, { inputs: linesOf(value) }) }}
          />
          <Field
            label={t('fieldNodeOutputs')}
            value={(node.outputs ?? []).join('\n')}
            multiline
            onChange={(value) => { replaceNode(index, { outputs: linesOf(value) }) }}
          />
          <Field
            label={t('fieldNodeVerification')}
            value={node.verification ?? ''}
            multiline
            onChange={(value) => { replaceNode(index, { verification: value }) }}
          />
          <Field
            label={t('fieldNodeFailure')}
            value={node.failureHandling ?? ''}
            multiline
            onChange={(value) => { replaceNode(index, { failureHandling: value }) }}
          />
          {props.assetChoices.length === 0
            ? null
            : (
              <label className={css.field}>
                <span className={css.fieldLabel}>{t('fieldNodeAssets')}</span>
                <select
                  className={css.input}
                  value={node.assetIds?.[0] ?? ''}
                  onChange={(event) => {
                    replaceNode(index, { assetIds: event.target.value === '' ? [] : [event.target.value] })
                  }}
                >
                  <option value="">—</option>
                  {props.assetChoices.map(assetId => (
                    <option key={assetId} value={assetId}>{assetId}</option>
                  ))}
                </select>
              </label>
            )}
          <div className={css.actions}>
            <button
              type="button"
              className={css.button}
              onClick={() => { writeLayer({ ...layer, entryNodeId: node.id }) }}
            >
              {t('setEntry')}
            </button>
            {node.subflowLayerId === undefined && props.depth < 3
              ? (
                <button
                  type="button"
                  className={css.button}
                  onClick={() => {
                    const added = appendLayer(props.workflow)
                    const withNode = replaceLayer(props.workflow, layer.id, {
                      ...layer,
                      nodes: layer.nodes.map((item, nodeIndex) => nodeIndex === index
                        ? { ...item, subflowLayerId: added.layerId }
                        : item),
                    })
                    props.onChange({
                      rootLayerId: added.workflow.rootLayerId,
                      layers: [...withNode.layers, ...added.workflow.layers.filter(layer => layer.id === added.layerId)],
                    })
                  }}
                >
                  {t('addSubflow')}
                </button>
              )
              : null}
            {node.subflowLayerId === undefined
              ? null
              : (
                <button
                  type="button"
                  className={css.link}
                  onClick={() => {
                    const layerId = node.subflowLayerId as string
                    const withoutLayer = removeLayerTree(props.workflow, layerId)
                    props.onChange(replaceLayer(withoutLayer, layer.id, {
                      ...layer,
                      nodes: layer.nodes.map((item, nodeIndex) => nodeIndex === index
                        ? { ...item, subflowLayerId: undefined }
                        : item),
                    }))
                  }}
                >
                  {t('removeSubflow')}
                </button>
              )}
            <button
              type="button"
              className={css.link}
              onClick={() => {
                writeLayer({
                  ...layer,
                  entryNodeId: layer.entryNodeId === node.id ? '' : layer.entryNodeId,
                  nodes: layer.nodes.filter((_, nodeIndex) => nodeIndex !== index),
                  edges: layer.edges.filter(edge => edge.from !== node.id && edge.to !== node.id),
                })
              }}
            >
              {t('deleteNode')}
            </button>
          </div>
          {node.subflowLayerId === undefined
            ? null
            : (
              <div className={css.subflow}>
                <span className={css.sectionLabel}>{t('subflowEditing')}</span>
                <WorkflowLayerEditor
                  t={t}
                  workflow={props.workflow}
                  layerId={node.subflowLayerId}
                  onChange={props.onChange}
                  assetChoices={props.assetChoices}
                  depth={props.depth + 1}
                />
              </div>
            )}
        </div>
      ))}
      <section className={css.factBlock}>
        <h4 className={css.factTitle}>{t('addEdge')}</h4>
        <div className={css.edgeRow}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('edgeFrom')}</span>
            <select
              className={css.input}
              value={draftEdge.from}
              onChange={(event) => { setDraftEdge({ ...draftEdge, from: event.target.value }) }}
            >
              <option value="">—</option>
              {layer.nodes.map(node => (
                <option key={node.id} value={node.id}>{node.title === '' ? node.id : node.title}</option>
              ))}
            </select>
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('edgeTo')}</span>
            <select
              className={css.input}
              value={draftEdge.to}
              onChange={(event) => { setDraftEdge({ ...draftEdge, to: event.target.value }) }}
            >
              <option value="">—</option>
              {layer.nodes.map(node => (
                <option key={node.id} value={node.id}>{node.title === '' ? node.id : node.title}</option>
              ))}
            </select>
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('edgeLabel')}</span>
            <input
              className={css.input}
              value={draftEdge.label}
              onChange={(event) => { setDraftEdge({ ...draftEdge, label: event.target.value }) }}
            />
          </label>
          <button
            type="button"
            className={css.button}
            disabled={draftEdge.from === '' || draftEdge.to === ''}
            onClick={() => {
              writeLayer({
                ...layer,
                edges: [...layer.edges, {
                  from: draftEdge.from,
                  to: draftEdge.to,
                  ...draftEdge.label === '' ? {} : { label: draftEdge.label },
                }],
              })
              setDraftEdge({ from: '', to: '', label: '' })
            }}
          >
            {t('addEdge')}
          </button>
        </div>
        {layer.edges.length === 0
          ? null
          : (
            <ul className={css.edgeList}>
              {layer.edges.map((edge, index) => (
                <li key={`${edge.from}-${edge.to}-${index}`} className={css.edgeItem}>
                  <code className={css.issuePath}>{`${edge.from} → ${edge.to}`}</code>
                  <span className={css.itemMeta}>{edge.label ?? ''}</span>
                  <button
                    type="button"
                    className={css.link}
                    onClick={() => {
                      writeLayer({ ...layer, edges: layer.edges.filter((_, edgeIndex) => edgeIndex !== index) })
                    }}
                  >
                    {t('deleteEdge')}
                  </button>
                </li>
              ))}
            </ul>
          )}
      </section>
    </div>
  )
}
