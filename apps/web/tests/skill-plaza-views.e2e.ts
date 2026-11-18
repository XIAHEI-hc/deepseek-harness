/**
 * Skill plaza process views over the real Host and the built Web client.
 *
 * Seeds the shipped `skillPlaza` service the way the editor writes: one result
 * image through the media entry, one published version with display content,
 * and one published version without it. The spec then reads the surfaces the
 * redesign describes — the process thumbnails, the single detail page, a
 * selected process node, the full page with its package section, and a narrow
 * viewport pass — and writes one screenshot per surface.
 */
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'

const SHOTS = fileURLToPath(new URL('../../../.artifacts', import.meta.url))

/** One draft's operating and display content, as the editor submits it. */
interface SeedContent {
  readonly title: string
  readonly slug: string
  readonly description: string
  readonly inputs: readonly string[]
  readonly steps: readonly string[]
  readonly outputs: readonly string[]
  readonly verification: string
  readonly failureHandling: string
  readonly toolDependencies: readonly string[]
  readonly presentation?: Record<string, unknown>
}

/** The plaza writes this spec drives, as the pages reach them. */
interface PlazaSeed {
  uploadMedia(request: { name: string; data: string }): Promise<{ asset: { assetId: string } }>
  saveDraft(request: { content: SeedContent }): Promise<{ draft: { draftId: string; revision: number } }>
  publish(request: {
    draftId: string
    expectedRevision: number
    idempotencyKey: string
  }): Promise<{ skill: { skillId: string; version: number } }>
}

/** Narrow an untyped service lookup to the plaza writes this spec uses. */
function plazaSeed(value: unknown): PlazaSeed {
  const candidate = value as Partial<PlazaSeed> | undefined
  if (candidate === undefined
    || typeof candidate.uploadMedia !== 'function'
    || typeof candidate.saveDraft !== 'function'
    || typeof candidate.publish !== 'function') {
    throw new Error('the skillPlaza service is not mounted in this profile')
  }
  return candidate as PlazaSeed
}

/** Render one wafer-map style PNG, so the result image is a real image. */
async function waferMap(): Promise<Buffer> {
  const cells: string[] = []
  for (let row = 0; row < 24; row += 1) {
    for (let column = 0; column < 24; column += 1) {
      const inWafer = (column - 11.5) ** 2 + (row - 11.5) ** 2 < 130
      if (!inWafer) continue
      const anomalous = (row * 7 + column * 3) % 29 === 0
      cells.push(
        `<rect x="${20 + column * 18}" y="${20 + row * 18}" width="16" height="16" rx="2" fill="${anomalous ? '#e8a33d' : '#2f6fd0'}" opacity="${anomalous ? 1 : 0.85}"/>`,
      )
    }
  }
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="360" viewBox="0 0 600 360">',
    '<rect width="600" height="360" fill="#f7f8fa"/>',
    cells.join(''),
    '<text x="470" y="40" font-family="sans-serif" font-size="14" fill="#3b4252">Wafer Map</text>',
    '<text x="470" y="62" font-family="sans-serif" font-size="12" fill="#6b7280">异常 Die 287 / 66,049</text>',
    '</svg>',
  ].join('')
  return await sharp(Buffer.from(svg)).png().toBuffer()
}

/** Content of the sample skill the prototypes show. */
function stdfContent(assetId: string): SeedContent {
  return {
    title: 'STDF 批次异常分析',
    slug: 'stdf-anomaly',
    description: '定位异常 Die，输出 Wafer Map 和异常清单。',
    inputs: ['STDF 文件', '判定规则'],
    steps: [
      '读取 STDF 文件并检查格式和晶圆编号。',
      '校验失败时说明原因，提示重新上传。',
      '对通过校验的输入执行异常判定规则。',
      '生成 Wafer Map、异常 Die 清单和批次报告。',
    ],
    outputs: ['Wafer Map', '异常 Die 清单', '批次报告'],
    verification: '核对批次与晶圆编号，确认清单中的坐标均可在 Wafer Map 中定位。',
    failureHandling: '文件校验失败则保留错误原因，提示用户重新上传。',
    toolDependencies: ['STDF 解析器'],
    presentation: {
      schemaVersion: 1,
      category: '数据分析',
      scenarios: ['需要基于 STDF 数据定位批次中的异常 Die', '对比多个批次的不良率'],
      examplePrompt: '分析这个批次，找出异常 Die 并生成 Wafer Map。',
      coverAssetId: assetId,
      examples: [{
        assetId,
        title: 'Wafer Map 与批次趋势',
        alt: '晶圆图上以琥珀色突出异常 Die，其余为良品。',
        caption: '示例数据 · Wafer Map 与批次趋势',
      }],
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
                purpose: '确认上传的记录可解析，且晶圆编号自洽。',
                inputs: ['STDF 文件'],
                checks: ['记录格式', '晶圆编号'],
                verification: '执行异常判定规则',
                failureHandling: '显示错误原因，提示重新上传。',
                subflowLayerId: 'check-detail',
              },
              { id: 'apply', type: 'action', title: '执行规则', outputs: ['异常 Die 清单'] },
              { id: 'report', type: 'action', title: '生成报告', assetIds: [assetId] },
              { id: 'reupload', type: 'action', title: '提示重新上传' },
            ],
            edges: [
              { from: 'read', to: 'validate' },
              { from: 'validate', to: 'apply', label: '通过' },
              { from: 'validate', to: 'reupload', label: '失败' },
              { from: 'apply', to: 'report' },
            ],
          },
          {
            id: 'check-detail',
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
}

/** A published version written before display content existed. */
const LEGACY_CONTENT: SeedContent = {
  title: 'CSV 转换校验',
  slug: 'csv-convert-check',
  description: '把多种格式的表格转换成标准 CSV，并做格式与数据校验。',
  inputs: ['原始表格文件'],
  steps: ['读取源文件', '转换为标准 CSV', '逐列校验类型与取值范围'],
  outputs: ['标准 CSV', '校验报告'],
  verification: '行数与源文件一致，校验报告无错误项。',
  failureHandling: '给出出错行号与原因。',
  toolDependencies: ['file read'],
}

it('renders the plaza browse, overview, and process node surfaces', async () => {
  const scaffold = await launchWebScaffold({})
  onTestFinished(() => scaffold.close())
  const plaza = plazaSeed(scaffold.ctx.get('skillPlaza'))
  const image = await waferMap()
  const uploaded = await plaza.uploadMedia({ name: 'wafer-map.png', data: image.toString('base64') })

  const legacy = await plaza.saveDraft({ content: LEGACY_CONTENT })
  await plaza.publish({
    draftId: legacy.draft.draftId,
    expectedRevision: legacy.draft.revision,
    idempotencyKey: 'seed-legacy',
  })

  const stdf = await plaza.saveDraft({ content: stdfContent(uploaded.asset.assetId) })
  const published = await plaza.publish({
    draftId: stdf.draft.draftId,
    expectedRevision: stdf.draft.revision,
    idempotencyKey: 'seed-stdf',
  })
  expect(published.skill.version).toBe(1)

  mkdirSync(SHOTS, { recursive: true })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  })
  onTestFinished(() => context.close())
  const page = await context.newPage()
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })

  await page.getByText('技能广场', { exact: true }).first().click()
  await expect.poll(() => page.getByRole('region', { name: '推荐技能' }).count()).toBe(1)
  await expect.poll(() => page.locator('svg[role="img"]').count()).toBeGreaterThan(0)
  await page.screenshot({ path: `${SHOTS}/skill-plaza-01-browse.png` })

  await page.getByRole('button', { name: '查看详情', exact: true }).click()
  await expect.poll(() => page.getByRole('heading', { level: 1, name: 'STDF 批次异常分析' }).count()).toBe(1)
  await expect.poll(() => page.getByText('/stdf-anomaly', { exact: false }).count()).toBeGreaterThan(0)
  await expect.poll(() => page.getByAltText(/晶圆图上以琥珀色突出异常 Die/).count()).toBe(1)
  await page.screenshot({ path: `${SHOTS}/skill-plaza-02-overview.png` })

  await page.getByRole('button', { name: '文件校验', exact: true }).click()
  await expect.poll(() => page.getByText('记录格式', { exact: true }).count()).toBeGreaterThan(0)
  await page.screenshot({ path: `${SHOTS}/skill-plaza-03-workflow-node.png` })

  await page.setViewportSize({ width: 1440, height: 2400 })
  await expect.poll(() => page.getByText('技能正文').count()).toBe(1)
  await page.screenshot({ path: `${SHOTS}/skill-plaza-05-detail-tall.png` })

  await page.setViewportSize({ width: 768, height: 900 })
  await expect.poll(() => page.getByRole('button', { name: '文件校验', exact: true }).count()).toBe(1)
  await page.screenshot({ path: `${SHOTS}/skill-plaza-04-narrow.png` })
})
