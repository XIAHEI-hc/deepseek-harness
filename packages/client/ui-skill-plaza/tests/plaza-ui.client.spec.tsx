// @vitest-environment jsdom

import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type {
  PlazaDraftContent, PlazaDraftView, PlazaMediaAsset, PlazaSkillEntry,
} from '@deepseek-ai/dsh-skill-plaza/types'
import { GenerateSkillButton, GenerateSkillCard, PlazaPanelIcon, SkillPicker } from '../src/client/Actions.tsx'
import type { GenerationTask } from '../src/client/generation-store.ts'
import { PlazaPage } from '../src/client/PlazaPage.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh, commonZh)

afterEach(cleanup)

const CONTENT: PlazaDraftContent = {
  title: 'STDF 批次异常分析',
  slug: 'stdf-anomaly',
  description: '定位异常 Die，输出 Wafer Map 和异常清单。',
  inputs: ['STDF 文件', '判定规则'],
  steps: ['读取 STDF 文件并检查格式。', '对通过校验的输入执行异常判定规则。'],
  outputs: ['Wafer Map', '异常 Die 清单'],
  verification: '核对批次与晶圆编号。',
  failureHandling: '文件校验失败则保留错误原因。',
  toolDependencies: ['STDF 解析器'],
  presentation: {
    schemaVersion: 1,
    category: '数据分析',
    scenarios: ['需要基于 STDF 数据定位异常 Die'],
    examplePrompt: '分析这个批次，找出异常 Die 并生成 Wafer Map。',
    coverAssetId: 'asset-wafer',
    examples: [
      {
        assetId: 'asset-wafer',
        title: 'Wafer Map 与批次趋势',
        alt: '晶圆图上以琥珀色突出异常 Die。',
        caption: '示例数据 · Wafer Map 与批次趋势',
      },
    ],
    workflow: {
      rootLayerId: 'flow',
      layers: [
        {
          id: 'flow',
          entryNodeId: 'read',
          nodes: [
            { id: 'read', type: 'action', title: '读取 STDF' },
            {
              id: 'validate',
              type: 'decision',
              title: '文件校验',
              inputs: ['STDF 文件'],
              checks: ['记录格式', '晶圆编号'],
              verification: '记录可解析且晶圆编号有效。',
              failureHandling: '显示错误原因，提示重新上传。',
              subflowLayerId: 'detail',
            },
            { id: 'apply', type: 'action', title: '执行规则' },
            { id: 'reupload', type: 'action', title: '提示重新上传' },
          ],
          edges: [
            { from: 'read', to: 'validate' },
            { from: 'validate', to: 'apply', label: '通过' },
            { from: 'validate', to: 'reupload', label: '失败' },
          ],
        },
        {
          id: 'detail',
          entryNodeId: 'check-format',
          nodes: [
            { id: 'check-format', type: 'action', title: '检查记录格式' },
            { id: 'check-wafer', type: 'action', title: '核对晶圆编号' },
          ],
          edges: [{ from: 'check-format', to: 'check-wafer' }],
        },
      ],
    },
  },
}

const DRAFT: PlazaDraftView = {
  draftId: 'draft-1',
  revision: 2,
  updatedAt: '2026-11-16T00:00:00.000Z',
  ...CONTENT,
}

const SKILL: PlazaSkillEntry = {
  skillId: 'skill-1',
  slug: 'stdf-anomaly',
  title: 'STDF 批次异常分析',
  description: '定位异常 Die，输出 Wafer Map 和异常清单。',
  version: 3,
  updatedAt: '2026-11-16T00:00:00.000Z',
  category: '数据分析',
  coverAssetId: 'asset-wafer',
}

/** The stored model-facing body the detail page reads for its package section. */
const BODY = [
  '# STDF 批次异常分析',
  '',
  '定位异常 Die，输出 Wafer Map 和异常清单。',
  '',
  '## Inputs',
  '- STDF 文件',
  '',
  '## Steps',
  '1. 读取 STDF 文件并检查格式。',
  '',
].join('\n')

/** The same skill listed without a cover image. */
const SKILL_NO_COVER: PlazaSkillEntry = {
  skillId: SKILL.skillId,
  slug: SKILL.slug,
  title: SKILL.title,
  description: SKILL.description,
  version: SKILL.version,
  updatedAt: SKILL.updatedAt,
  category: '数据分析',
}

/** The same content without any presentation payload. */
const BARE_CONTENT: PlazaDraftContent = {
  title: CONTENT.title,
  slug: CONTENT.slug,
  description: CONTENT.description,
  inputs: CONTENT.inputs,
  steps: CONTENT.steps,
  outputs: CONTENT.outputs,
  verification: CONTENT.verification,
  failureHandling: CONTENT.failureHandling,
  toolDependencies: CONTENT.toolDependencies,
}

const ASSET: PlazaMediaAsset = {
  assetId: 'asset-wafer',
  mimeType: 'image/png',
  width: 640,
  height: 360,
  byteLength: 1024,
  createdAt: '2026-11-16T00:00:00.000Z',
}

type PageView = typeof PlazaPage
type ActionView = typeof GenerateSkillButton
type PickerView = typeof SkillPicker
type CardView = typeof GenerateSkillCard

/** Tasks one render sees, keyed by the Turn's message identity. */
type TaskFixture = Record<string, GenerationTask | undefined>

/** Selector stub standing in for the framework-bound store hook. */
function useStoreOf(tasks: TaskFixture): unknown {
  return (selector: (state: { tasks: TaskFixture }) => unknown) => selector({ tasks })
}

/** Render the page with every injected face stubbed and the framework seats cast. */
function renderPage(over: Partial<ComponentProps<PageView>> = {}) {
  const props: Partial<ComponentProps<PageView>> = {
    t,
    load: () => Promise.resolve({ workspaceKey: 'ws', drafts: [], skills: [] }),
    detail: () => Promise.resolve({
      skillId: SKILL.skillId,
      slug: SKILL.slug,
      title: SKILL.title,
      version: SKILL.version,
      publishedAt: '2026-11-16T00:00:00.000Z',
      content: CONTENT,
      body: BODY,
    }),
    media: () => Promise.resolve('data:image/png;base64,AAA'),
    upload: () => Promise.resolve(ASSET),
    check: () => Promise.resolve([]),
    save: () => Promise.resolve({ ok: true, draft: DRAFT }),
    publish: () => Promise.resolve({ ok: true }),
    useInConversation: () => Promise.resolve({ ok: true, createdSession: false }),
    consumePendingDraft: vi.fn(),
    subscribe: () => () => {},
    ...over,
  }
  return render(<PlazaPage {...props as ComponentProps<PageView>} />)
}

/** Render the finalized-assistant action. */
function renderAction(over: Partial<ComponentProps<ActionView>> = {}, tasks: TaskFixture = {}) {
  const props: Partial<ComponentProps<ActionView>> = {
    t,
    messageId: 'message-1' as never,
    useStore: useStoreOf(tasks) as never,
    actions: {} as never,
    start: vi.fn(),
    openDraft: vi.fn(),
    ...over,
  }
  return render(<GenerateSkillButton {...props as ComponentProps<ActionView>} />)
}

/** Render the generation card of one Turn. */
function renderCard(over: Partial<ComponentProps<CardView>> = {}, tasks: TaskFixture = {}) {
  const props: Partial<ComponentProps<CardView>> = {
    t,
    turn: 1 as never,
    seq: 1,
    openFile: vi.fn(),
    messageId: 'message-1' as never,
    useStore: useStoreOf(tasks) as never,
    actions: {} as never,
    cancel: vi.fn(),
    retry: vi.fn(),
    openDraft: vi.fn(),
    ...over,
  }
  return render(<GenerateSkillCard {...props as ComponentProps<CardView>} />)
}

/** One running task fixture. */
function runningTask(over: Partial<GenerationTask> = {}): GenerationTask {
  return { status: 'running', attempt: 1, startedAt: Date.now(), stage: 'distill', chars: 880, ...over }
}

/** One finished task fixture. */
function finishedTask(over: Partial<GenerationTask> = {}): GenerationTask {
  return {
    status: 'succeeded',
    attempt: 1,
    startedAt: Date.now(),
    draft: {
      draftId: 'draft-1',
      title: '发布前指标对比',
      description: '对比两个发布版本的发布前指标。',
      slug: 'release-metrics-compare',
      revision: 1,
      steps: 4,
      tools: 1,
      category: '研发效能',
    },
    ...over,
  }
}

/** Render the composer picker. */
function renderPicker(over: Partial<ComponentProps<PickerView>> = {}) {
  const props: Partial<ComponentProps<PickerView>> = {
    t,
    catalog: () => Promise.resolve([SKILL]),
    pick: vi.fn(),
    ...over,
  }
  return render(<SkillPicker {...props as ComponentProps<PickerView>} />)
}

/** Open the detail route of one catalog card. */
async function openDetail(over: Partial<ComponentProps<PageView>> = {}) {
  const view = renderPage({
    load: () => Promise.resolve({ workspaceKey: 'ws', drafts: [], skills: [SKILL] }),
    ...over,
  })
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(SKILL.title) }))
  await screen.findByRole('heading', { level: 1, name: SKILL.title })
  return view
}

describe('skills plaza page', () => {
  it('lists published skills as cards with version, purpose, and cover', async () => {
    renderPage({ load: () => Promise.resolve({ workspaceKey: 'ws', drafts: [], skills: [SKILL] }) })
    expect(await screen.findByText(SKILL.title)).toBeTruthy()
    expect(screen.getByText(`版本 ${SKILL.version}`)).toBeTruthy()
    expect(screen.getByText(SKILL.description)).toBeTruthy()
    await waitFor(() => {
      expect(document.querySelector('img')).not.toBeNull()
    })
  })

  it('keeps a skill without a cover as a compact card', async () => {
    renderPage({
      load: () => Promise.resolve({
        workspaceKey: 'ws',
        drafts: [],
        skills: [SKILL_NO_COVER],
      }),
    })
    expect(await screen.findByText(SKILL.title)).toBeTruthy()
    expect(document.querySelector('img')).toBeNull()
  })

  it('presents the most recently updated skill as a process feature', async () => {
    const older: PlazaSkillEntry = {
      ...SKILL,
      skillId: 'skill-0',
      slug: 'csv-convert',
      title: 'CSV 转换校验',
      description: '把表格转成标准 CSV。',
      updatedAt: '2026-11-10T00:00:00.000Z',
      category: '办公文档',
    }
    renderPage({
      load: () => Promise.resolve({ workspaceKey: 'ws', drafts: [], skills: [older, SKILL] }),
    })
    const featured = await screen.findByRole('region', { name: '推荐技能' })
    expect(within(featured).getByText(SKILL.title)).toBeTruthy()
    expect(within(featured).getByRole('button', { name: '查看详情' })).toBeTruthy()
    expect(screen.getByText(older.title)).toBeTruthy()
  })

  it('binds the featured skill without opening its page', async () => {
    const useInConversation = vi.fn().mockResolvedValue({ ok: true, createdSession: false })
    const older: PlazaSkillEntry = {
      ...SKILL,
      skillId: 'skill-0',
      slug: 'csv-convert',
      title: 'CSV 转换校验',
      updatedAt: '2026-11-10T00:00:00.000Z',
    }
    renderPage({
      load: () => Promise.resolve({ workspaceKey: 'ws', drafts: [], skills: [older, SKILL] }),
      useInConversation,
    })
    const featured = await screen.findByRole('region', { name: '推荐技能' })
    fireEvent.click(within(featured).getByRole('button', { name: '在对话中使用' }))
    await waitFor(() => {
      expect(useInConversation).toHaveBeenCalledWith({
        skillId: SKILL.skillId,
        version: SKILL.version,
        slug: SKILL.slug,
      })
    })
  })

  it('reports a featured use that created a conversation and one that was refused', async () => {
    const older: PlazaSkillEntry = {
      ...SKILL,
      skillId: 'skill-0',
      slug: 'csv-convert',
      title: 'CSV 转换校验',
      updatedAt: '2026-11-10T00:00:00.000Z',
    }
    const useInConversation = vi.fn()
      .mockResolvedValueOnce({ ok: true, createdSession: true })
      .mockResolvedValueOnce({ ok: false, error: 'skillPlaza/not-found: gone' })
    renderPage({
      load: () => Promise.resolve({ workspaceKey: 'ws', drafts: [], skills: [older, SKILL] }),
      useInConversation,
    })
    const featured = await screen.findByRole('region', { name: '推荐技能' })
    fireEvent.click(within(featured).getByRole('button', { name: '在对话中使用' }))
    expect(await screen.findByText('已新建会话，调用指令已插入输入框。')).toBeTruthy()
    fireEvent.click(within(featured).getByRole('button', { name: '在对话中使用' }))
    expect(await screen.findByText(/没能插入调用指令/)).toBeTruthy()
  })

  it('filters by query and category and clears both', async () => {
    const other: PlazaSkillEntry = {
      ...SKILL,
      skillId: 'skill-2',
      slug: 'csv-convert',
      title: 'CSV 转换校验',
      category: '办公文档',
    }
    renderPage({ load: () => Promise.resolve({ workspaceKey: 'ws', drafts: [], skills: [SKILL, other] }) })
    await screen.findByText(SKILL.title)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'csv' } })
    await waitFor(() => {
      expect(screen.queryByText(SKILL.title)).toBeNull()
      expect(screen.getByText(other.title)).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: '办公文档' }))
    expect(screen.getByText(other.title)).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '没有这个技能' } })
    expect(await screen.findByText('没有符合条件的技能')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))
    expect(await screen.findByText(SKILL.title)).toBeTruthy()
  })

  it('reads the version a card shows and renders the overview with its result image', async () => {
    const detail = vi.fn()
    detail.mockResolvedValue({
      skillId: SKILL.skillId,
      slug: SKILL.slug,
      title: SKILL.title,
      version: SKILL.version,
      publishedAt: '2026-11-16T00:00:00.000Z',
      content: CONTENT,
      body: BODY,
    })
    await openDetail({ detail })
    expect(detail).toHaveBeenCalledWith(SKILL.skillId, SKILL.version)
    expect(screen.getByText(`版本 ${SKILL.version}`)).toBeTruthy()
    expect(screen.getByText(`/${SKILL.slug}`, { exact: false })).toBeTruthy()
    await waitFor(() => { expect(screen.getByAltText('晶圆图上以琥珀色突出异常 Die。')).toBeTruthy() })
    expect(screen.getByText('示例数据 · Wafer Map 与批次趋势')).toBeTruthy()
    expect(screen.getByText('需要基于 STDF 数据定位异常 Die')).toBeTruthy()
    expect(screen.getByText('STDF 解析器')).toBeTruthy()
  })

  it('enlarges a result image and closes it with Escape', async () => {
    await openDetail()
    fireEvent.click(await screen.findByRole('button', { name: '放大图片' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('selects a process node and shows its checks and failure handling', async () => {
    await openDetail()
    const node = await screen.findByRole('button', { name: '文件校验' })
    fireEvent.click(node)
    expect(node.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('记录格式')).toBeTruthy()
    expect(screen.getByText('晶圆编号')).toBeTruthy()
    expect(screen.getByText('显示错误原因，提示重新上传。')).toBeTruthy()
    expect(screen.getByText('通过')).toBeTruthy()
    expect(screen.getByText('失败')).toBeTruthy()
  })

  it('states when the selected node has no further notes', async () => {
    await openDetail()
    fireEvent.click(screen.getByRole('button', { name: '读取 STDF' }))
    expect(screen.getByText('这个节点没有补充说明。')).toBeTruthy()
  })

  it('opens a subflow, then returns with the parent node still selected', async () => {
    await openDetail()
    fireEvent.click(await screen.findByRole('button', { name: '文件校验' }))
    fireEvent.click(screen.getByRole('button', { name: '展开子流程' }))
    expect(await screen.findByRole('button', { name: '检查记录格式' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '文件校验' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '返回上一级' }))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '检查记录格式' })).toBeNull()
    })
    expect(screen.getByRole('button', { name: '文件校验' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('lists the process nodes as an equivalent reading order', async () => {
    await openDetail()
    const rows = await screen.findAllByRole('button', { name: /读取 STDF|执行规则|提示重新上传/ })
    expect(rows.length).toBeGreaterThanOrEqual(3)
  })

  it('falls back to a flow derived from the operating steps', async () => {
    await openDetail({
      detail: () => Promise.resolve({
        skillId: SKILL.skillId,
        slug: SKILL.slug,
        title: SKILL.title,
        version: SKILL.version,
        publishedAt: '2026-11-16T00:00:00.000Z',
        content: BARE_CONTENT,
        body: '# STDF 批次异常分析\n',
      }),
    })
    expect(await screen.findByRole('button', { name: '读取 STDF 文件并检查格式。' })).toBeTruthy()
    expect(screen.getByText('流程图由执行步骤自动生成；补上结构化流程后可以表达分支。')).toBeTruthy()
  })

  it('reads the stored body and verification of the version being shown', async () => {
    await openDetail()
    expect(await screen.findByText('技能正文')).toBeTruthy()
    expect(screen.getByText('只读 · 发布后不可修改')).toBeTruthy()
    expect(screen.getByText('核对批次与晶圆编号。')).toBeTruthy()
    expect(screen.getByText('文件校验失败则保留错误原因。')).toBeTruthy()
  })

  it('inserts the version on display, with its example prompt, only when the pin succeeds', async () => {
    const useInConversation = vi.fn()
    useInConversation.mockResolvedValue({ ok: true, createdSession: false })
    const view = await openDetail({ useInConversation })
    fireEvent.click(screen.getByRole('button', { name: '在对话中使用' }))
    await waitFor(() => {
      expect(useInConversation).toHaveBeenCalledWith({
        skillId: SKILL.skillId,
        version: SKILL.version,
        slug: SKILL.slug,
      })
    })
    useInConversation.mockResolvedValue({ ok: true, createdSession: true })
    fireEvent.click(screen.getByRole('button', { name: '带入输入框' }))
    await waitFor(() => { expect(useInConversation).toHaveBeenCalledTimes(2) })
    expect(useInConversation).toHaveBeenLastCalledWith(expect.objectContaining({
      version: SKILL.version,
      examplePrompt: CONTENT.presentation?.examplePrompt,
    }))
    expect(await screen.findByText('已新建会话，调用指令已插入输入框。')).toBeTruthy()
    expect(view.container.querySelector('[data-sent]')).toBeNull()
  })

  it('reports a refused insertion without losing the page', async () => {
    await openDetail({
      useInConversation: () => Promise.resolve({ ok: false, error: 'skillPlaza/not-found: gone' }),
    })
    fireEvent.click(screen.getByRole('button', { name: '在对话中使用' }))
    expect(await screen.findByText(/没能插入调用指令/)).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: SKILL.title })).toBeTruthy()
  })

  it('lists drafts with their revision and publication state', async () => {
    renderPage({ load: () => Promise.resolve({ workspaceKey: 'ws', drafts: [DRAFT], skills: [] }) })
    fireEvent.click(await screen.findByRole('tab', { name: '草稿' }))
    expect(await screen.findByText(DRAFT.title)).toBeTruthy()
    expect(screen.getByText('修订 2')).toBeTruthy()
    expect(screen.getByText('未发布')).toBeTruthy()
  })

  it('opens the draft a finished generation produced', async () => {
    const consumePendingDraft = vi.fn()
    const view = renderPage({
      load: () => Promise.resolve({
        workspaceKey: 'ws',
        drafts: [DRAFT],
        skills: [],
        pendingDraftId: DRAFT.draftId,
      }),
      consumePendingDraft,
    })
    expect(await screen.findByRole('heading', { level: 1, name: DRAFT.title })).toBeTruthy()
    expect(consumePendingDraft).toHaveBeenCalled()
    expect(view.container.querySelectorAll('input').length).toBeGreaterThan(0)
  })

  it('saves the live editor content with the revision it was rendered from', async () => {
    const save = vi.fn()
    save.mockResolvedValue({ ok: true, draft: { ...DRAFT, revision: 3 } })
    renderPage({
      load: () => Promise.resolve({ workspaceKey: 'ws', drafts: [DRAFT], skills: [] }),
      save,
    })
    fireEvent.click(await screen.findByRole('tab', { name: '草稿' }))
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(DRAFT.title) }))
    const titleInput = await screen.findByDisplayValue(DRAFT.title)
    fireEvent.change(titleInput, { target: { value: 'STDF 批次异常分析 v2' } })
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }))
    await waitFor(() => { expect(save).toHaveBeenCalled() })
    const [draftId, content, revision] = save.mock.calls[0] as [string, PlazaDraftContent, number]
    expect(draftId).toBe(DRAFT.draftId)
    expect(content.title).toBe('STDF 批次异常分析 v2')
    expect(content.presentation?.workflow?.rootLayerId).toBe('flow')
    expect(revision).toBe(DRAFT.revision)
    expect(await screen.findByText('已保存')).toBeTruthy()
  })

  it('blocks publication on located problems and shows them', async () => {
    const publish = vi.fn()
    publish.mockResolvedValue({ ok: true })
    renderPage({
      load: () => Promise.resolve({ workspaceKey: 'ws', drafts: [DRAFT], skills: [] }),
      check: () => Promise.resolve([{
        code: 'decision-unlabeled',
        path: 'presentation.workflow.layers[0].edges[1].label',
        detail: 'the branch out of decision "validate" needs a condition label',
      }]),
      publish,
    })
    fireEvent.click(await screen.findByRole('tab', { name: '草稿' }))
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(DRAFT.title) }))
    fireEvent.click(await screen.findByRole('button', { name: '发布' }))
    expect(await screen.findByText('presentation.workflow.layers[0].edges[1].label')).toBeTruthy()
    expect(publish).not.toHaveBeenCalled()
    expect(screen.getByText('还有问题需要处理，暂不能发布。')).toBeTruthy()
  })

  it('surfaces a revision conflict with the local content kept', async () => {
    renderPage({
      load: () => Promise.resolve({ workspaceKey: 'ws', drafts: [DRAFT], skills: [] }),
      save: () => Promise.resolve({
        ok: false,
        error: 'the draft moved to revision 5; reload before saving',
        conflict: true,
      }),
    })
    fireEvent.click(await screen.findByRole('tab', { name: '草稿' }))
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(DRAFT.title) }))
    fireEvent.click(await screen.findByRole('button', { name: '保存草稿' }))
    expect(await screen.findByText('草稿已被更新')).toBeTruthy()
    expect(screen.getByRole('button', { name: '载入最新草稿' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '复制本地内容' })).toBeTruthy()
  })

  it('previews the live editor content instead of the published version', async () => {
    renderPage({
      load: () => Promise.resolve({ workspaceKey: 'ws', drafts: [DRAFT], skills: [] }),
      detail: () => Promise.reject(new Error('the preview must not read the published version')),
    })
    fireEvent.click(await screen.findByRole('tab', { name: '草稿' }))
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(DRAFT.title) }))
    const titleInput = await screen.findByDisplayValue(DRAFT.title)
    fireEvent.change(titleInput, { target: { value: '草稿预览标题' } })
    fireEvent.click(screen.getByRole('button', { name: '预览' }))
    expect(await screen.findByRole('heading', { level: 1, name: '草稿预览标题' })).toBeTruthy()
    expect(screen.getByText('草稿预览（尚未发布）')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '在对话中使用' })?.hasAttribute('disabled')).toBe(true)
  })

  it('retries a failed catalog read', async () => {
    const load = vi.fn()
    load.mockRejectedValueOnce(new Error('gateway/internal: offline'))
    load.mockResolvedValue({ workspaceKey: 'ws', drafts: [], skills: [SKILL] })
    renderPage({ load })
    expect(await screen.findByText('读取失败')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText(SKILL.title)).toBeTruthy()
  })

  it('starts a generation from the action', () => {
    const start = vi.fn()
    renderAction({ start })
    fireEvent.click(screen.getByRole('button', { name: '生成 Skill' }))
    expect(start).toHaveBeenCalledWith('message-1')
  })

  it('shows a running generation on the action and keeps it disabled', () => {
    renderAction({}, { 'message-1': runningTask() })
    const button = screen.getByRole('button', { name: '正在生成…' })
    expect(button.hasAttribute('disabled')).toBe(true)
  })

  it('opens the finished draft from the action', () => {
    const openDraft = vi.fn()
    renderAction({ openDraft }, { 'message-1': finishedTask() })
    fireEvent.click(screen.getByRole('button', { name: '已生成 · 查看' }))
    expect(openDraft).toHaveBeenCalledWith('draft-1')
  })

  it('renders nothing for a turn that never started a generation', () => {
    const view = renderCard()
    expect(view.container.firstChild).toBeNull()
  })

  it('paints the stages a running task reached and the characters so far', () => {
    renderCard({ messageId: 'message-1' as never }, { 'message-1': runningTask() })
    expect(screen.getByText('正在把这个回复提炼成技能')).toBeTruthy()
    expect(screen.getByText('读取这一轮对话')).toBeTruthy()
    const stages = screen.getAllByRole('listitem')
    expect(stages[0]?.getAttribute('data-state')).toBe('done')
    expect(stages[1]?.getAttribute('data-state')).toBe('run')
    expect(stages[2]?.getAttribute('data-state')).toBe('wait')
    expect(screen.getByText('模型正在写 · 880 字')).toBeTruthy()
  })

  it('stops a running task from its card', () => {
    const cancel = vi.fn()
    renderCard({ cancel }, { 'message-1': runningTask() })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(cancel).toHaveBeenCalledWith('message-1')
  })

  it('summarizes the draft a finished task produced', () => {
    const openDraft = vi.fn()
    renderCard({ openDraft }, { 'message-1': finishedTask() })
    expect(screen.getByText('发布前指标对比')).toBeTruthy()
    expect(screen.getByText('研发效能')).toBeTruthy()
    expect(screen.getByText('4 步')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '打开技能广场' }))
    expect(openDraft).toHaveBeenCalledWith('draft-1')
  })

  it('offers a retry after a failed task and names the reason', () => {
    const retry = vi.fn()
    renderCard({ retry }, {
      'message-1': { status: 'failed', attempt: 1, startedAt: Date.now(), error: 'model unavailable' },
    })
    expect(screen.getByText('生成失败')).toBeTruthy()
    expect(screen.getByText('model unavailable')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(retry).toHaveBeenCalledWith('message-1')
  })

  it('keeps the picker behaviour', async () => {
    const pick = vi.fn()
    const picker = renderPicker({ pick })
    const summary = picker.container.querySelector('summary')
    expect(summary).not.toBeNull()
    fireEvent.click(summary as HTMLElement)
    await waitFor(() => { expect(screen.getByText(SKILL.title)).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(SKILL.title) }))
    expect(pick).toHaveBeenCalledWith(SKILL)
  })

  it('renders the sidebar glyph', () => {
    const view = render(<PlazaPanelIcon />)
    expect(view.container.querySelector('svg')).not.toBeNull()
  })
})
