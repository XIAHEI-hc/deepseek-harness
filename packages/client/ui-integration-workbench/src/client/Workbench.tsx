/**
 * System-fusion workbench overlay.
 *
 * The launcher is absent unless `/api/integration/status` answered on this
 * deployment. Opening it reads only the signed-in user's authorized systems,
 * workspaces, and jobs; every mutation goes through the gateway's CSRF-guarded
 * fusion API. The panel never receives a host path and never runs shell in the
 * user's chat runtime.
 */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  FusionJob,
  FusionJobView,
  FusionOverview,
  FusionResource,
  FusionSnapshot,
  FusionStatus,
  FusionWorkspace,
} from './api.ts'
import { FusionApiError } from './api.ts'
import type { FusionWorkbenchProps } from './contract.ts'
import css from './Workbench.module.css'

/** A job row plus its last loaded artifacts. */
interface JobRow {
  readonly job: FusionJob
  readonly artifacts: FusionJobView['artifacts']
}

/**
 * Render the fusion launcher and, when open, the workbench panel.
 * @param props - injected API callbacks, availability hook, and localized copy.
 * @returns the launcher, the panel, or nothing when fusion is unavailable.
 */
export function Workbench({
  useFusion,
  loadOverview,
  loadResources,
  capture,
  createWorkspace,
  startJob,
  loadJob,
  cancelJob,
  artifactPath,
  t,
}: FusionWorkbenchProps) {
  const availability = useFusion(state => state)
  const [open, setOpen] = useState(false)
  const [overview, setOverview] = useState<FusionOverview | null>(null)
  const [systemId, setSystemId] = useState('')
  const [resources, setResources] = useState<readonly FusionResource[]>([])
  const [snapshotIds, setSnapshotIds] = useState<readonly string[]>([])
  const [workspaceName, setWorkspaceName] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [language, setLanguage] = useState<'shell' | 'python'>('shell')
  const [script, setScript] = useState('')
  const [jobs, setJobs] = useState<readonly JobRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const refreshJobRef = useRef<(jobId: string) => void>(() => undefined)

  // Poll only while a job is queued or running; the interval disappears as soon
  // as every row settles. The ref keeps the effect independent of render order.
  useEffect(() => {
    const active = jobs
      .filter(row => row.job.status === 'queued' || row.job.status === 'running')
      .map(row => row.job.id)
    if (active.length === 0) return
    const timer = setInterval(() => {
      for (const jobId of active) refreshJobRef.current(jobId)
    }, 2_000)
    return () => { clearInterval(timer) }
  }, [jobs])

  if (availability.status !== 'available') return null
  const service = availability.service

  const message = (failure: unknown): string => {
    const code = failure instanceof FusionApiError ? failure.code : 'unexpected'
    return t('error.action', { code })
  }

  const loadSystemResources = async (nextSystemId: string): Promise<void> => {
    setSystemId(nextSystemId)
    if (nextSystemId === '') {
      setResources([])
      return
    }
    const page = await loadResources(nextSystemId)
    setResources(page.items)
  }

  const refresh = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const next = await loadOverview()
      setOverview(next)
      setJobs(next.jobs.map(job => ({ job, artifacts: [] })))
      const firstSystem = next.systems[0]?.id ?? ''
      await loadSystemResources(firstSystem)
      setWorkspaceId(current => current !== '' ? current : next.workspaces[0]?.id ?? '')
    } catch (failure) {
      const code = failure instanceof FusionApiError ? failure.code : 'unexpected'
      setError(t('error.load', { code }))
    } finally {
      setBusy(false)
    }
  }

  const openPanel = (): void => {
    setOpen(true)
    if (overview === null) void refresh()
  }

  const addSnapshot = async (resource: FusionResource): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const snapshot: FusionSnapshot = await capture(resource)
      setSnapshotIds(current => current.includes(snapshot.id) ? current : [...current, snapshot.id])
    } catch (failure) {
      setError(message(failure))
    } finally {
      setBusy(false)
    }
  }

  const addWorkspace = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const workspace: FusionWorkspace = await createWorkspace(workspaceName)
      setOverview(current => current === null ? current : { ...current, workspaces: [...current.workspaces, workspace] })
      setWorkspaceId(workspace.id)
      setWorkspaceName('')
    } catch (failure) {
      setError(message(failure))
    } finally {
      setBusy(false)
    }
  }

  const run = async (): Promise<void> => {
    if (workspaceId === '' || snapshotIds.length === 0 || script.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      const job = await startJob({ workspaceId, inputSnapshotIds: snapshotIds, language, script })
      setJobs(current => [{ job, artifacts: [] }, ...current])
      setScript('')
    } catch (failure) {
      setError(message(failure))
    } finally {
      setBusy(false)
    }
  }

  const refreshJob = async (jobId: string): Promise<void> => {
    setBusy(true)

    setError(null)
    try {
      const view = await loadJob(jobId)
      setJobs(current => current.map(row => row.job.id === jobId ? { job: view.job, artifacts: view.artifacts } : row))
    } catch (failure) {
      setError(message(failure))
    } finally {
      setBusy(false)
    }
  }

  refreshJobRef.current = (jobId: string): void => { void refreshJob(jobId) }

  const cancel = async (jobId: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const job = await cancelJob(jobId)
      setJobs(current => current.map(row => row.job.id === jobId ? { ...row, job } : row))
    } catch (failure) {
      setError(message(failure))
    } finally {
      setBusy(false)
    }
  }

  const statusLabel = (status: FusionStatus): string => {
    if (status.state === 'blocked') return t('status.blocked')
    return t('status.ready')
  }

  const resourceItems = resources.length === 0
    ? <p className={css.empty}>{t('resource.empty')}</p>
    : (
      <ul className={css.list}>
        {resources.map(resource => (
          <li key={`${resource.locator.systemId}:${resource.locator.resourceId}`} className={css.row}>
            <span className={css.rowMain}>
              <strong>{resource.name}</strong>
              <span className={css.meta}>{t(`classification.${resource.classification}`)}</span>
            </span>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { void addSnapshot(resource) }}>
              {t('resource.capture')}
            </Button>
          </li>
        ))}
      </ul>
    )

  const workspaceItems = (overview?.workspaces ?? []).length === 0
    ? <p className={css.empty}>{t('workspace.empty')}</p>
    : null

  const jobItems = jobs.length === 0
    ? <p className={css.empty}>{t('job.empty')}</p>
    : (
      <ul className={css.list}>
        {jobs.map(row => (
          <li key={row.job.id} className={css.job}>
            <div className={css.jobHead}>
              <code className={css.jobId}>{row.job.id.slice(0, 8)}</code>
              <span className={css.status}>{t('job.status')}: {jobState(t, row.job.status)}</span>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void refreshJob(row.job.id) }}>
                {t('job.refresh')}
              </Button>
              {(row.job.status === 'queued' || row.job.status === 'running') && (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void cancel(row.job.id) }}>
                  {t('job.cancel')}
                </Button>
              )}
            </div>
            {row.job.errorCode !== null && <p className={css.error}>{row.job.errorCode}</p>}
            {row.artifacts.length > 0 && (
              <div className={css.artifacts}>
                <span className={css.meta}>{t('job.artifacts')}</span>
                {row.artifacts.map(artifact => (
                  <a key={artifact.id} className={css.link} href={artifactPath(artifact.id)}>
                    {artifact.relativePath}
                  </a>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    )

  if (!open) {
    return (
      <button type="button" className={css.launcher} onClick={openPanel}>
        {t('workbench.open')}
      </button>
    )
  }

  return (
    <section className={css.panel} role="dialog" aria-label={t('workbench.title')} aria-modal="false">
      <header className={css.header}>
        <h2 className={css.title}>{t('workbench.title')}</h2>
        <Button variant="ghost" size="sm" onClick={() => { setOpen(false) }}>{t('workbench.close')}</Button>
      </header>
      <div className={css.scope} data-fusion-status={service.state}>
        <span className={css.status}>{statusLabel(service)}</span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void refresh() }}>{t('workbench.refresh')}</Button>
      </div>
      {service.state === 'blocked' && (
        <div className={css.blocked}>
          <strong>{t('status.issueList')}</strong>
          <ul className={css.list}>
            {service.issues.map((issue: { readonly code: string }) => <li key={issue.code} className={css.meta}>{issue.code}</li>)}
          </ul>
        </div>
      )}
      {error !== null && <p className={css.error}>{error}</p>}
      <section className={css.section} aria-label={t('system.label')}>
        <h3 className={css.heading}>{t('system.label')}</h3>
        {(overview?.systems ?? []).length === 0
          ? <p className={css.empty}>{t('system.empty')}</p>
          : (
            <select
              className={css.select}
              aria-label={t('system.label')}
              value={systemId}
              onChange={(event) => {
                const next = event.target.value
                setSnapshotIds([])
                void loadSystemResources(next).catch((failure: unknown) => { setError(message(failure)) })
              }}
            >
              {(overview?.systems ?? []).map(system => <option key={system.id} value={system.id}>{system.name}</option>)}
            </select>
          )}
      </section>
      <section className={css.section} aria-label={t('resource.label')}>
        <h3 className={css.heading}>{t('resource.label')}</h3>
        {resourceItems}
        {snapshotIds.length > 0 && <p className={css.meta}>{t('snapshot.selected', { count: snapshotIds.length })}</p>}
      </section>
      <section className={css.section} aria-label={t('workspace.label')}>
        <h3 className={css.heading}>{t('workspace.label')}</h3>
        {workspaceItems}
        {(overview?.workspaces ?? []).length > 0 && (
          <select className={css.select} aria-label={t('workspace.label')} value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value) }}>
            {(overview?.workspaces ?? []).map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
        )}
        <div className={css.inline}>
          <input
            className={css.input}
            aria-label={t('workspace.name')}
            placeholder={t('workspace.name')}
            value={workspaceName}
            onChange={(event) => { setWorkspaceName(event.target.value) }}
          />
          <Button variant="outline" size="sm" disabled={busy || workspaceName.trim() === ''} onClick={() => { void addWorkspace() }}>
            {t('workspace.create')}
          </Button>
        </div>
      </section>
      <section className={css.section} aria-label={t('job.script')}>
        <h3 className={css.heading}>{t('job.script')}</h3>
        <div className={css.inline}>
          <label className={css.meta} htmlFor="fusion-language">{t('job.language')}</label>
          <select
            id="fusion-language"
            className={css.select}
            value={language}
            onChange={(event) => { setLanguage(event.target.value === 'python' ? 'python' : 'shell') }}
          >
            <option value="shell">{t('job.shell')}</option>
            <option value="python">{t('job.python')}</option>
          </select>
        </div>
        <textarea
          className={css.script}
          aria-label={t('job.script')}
          value={script}
          onChange={(event) => { setScript(event.target.value) }}
          rows={6}
        />
        <Button
          variant="primary"
          disabled={busy || workspaceId === '' || snapshotIds.length === 0 || script.trim() === ''}
          onClick={() => { void run() }}
        >
          {t('job.run')}
        </Button>
      </section>
      <section className={css.section} aria-label={t('job.label')}>
        <h3 className={css.heading}>{t('job.label')}</h3>
        {jobItems}
      </section>
    </section>
  )
}

/**
 * Map one job status to its localized key.
 * @param t - namespace translator.
 * @param status - job status value.
 * @returns the localized status label.
 */
function jobState(
  t: FusionWorkbenchProps['t'],
  status: FusionJob['status'],
): string {
  if (status === 'queued') return t('job.state.queued')
  if (status === 'running') return t('job.state.running')
  if (status === 'succeeded') return t('job.state.succeeded')
  if (status === 'cancelled') return t('job.state.cancelled')
  return t('job.state.failed')
}
