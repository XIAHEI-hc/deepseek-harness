/**
 * Durable plaza records and the storage domain that owns them.
 *
 * The domain keeps four append-mostly tables in one JSON unit under the
 * Harness home: drafts (mutable, revision-guarded), published versions
 * (immutable), the active-version catalog, and generation attempts. Every
 * record carries the workspace directory it belongs to, so workspace isolation
 * is a read filter rather than a second store.
 *
 * @module @deepseek-ai/dsh-skill-plaza
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** Structural check shared by generated and hand-edited draft content. */
export const plazaContentSchema = z.object({
  title: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().min(1),
  inputs: z.array(z.string()),
  steps: z.array(z.string()),
  outputs: z.array(z.string()),
  verification: z.string(),
  failureHandling: z.string(),
  toolDependencies: z.array(z.string()),
})

/** Validated draft content in its stored representation. */
export type PlazaContent = z.infer<typeof plazaContentSchema>

/** Stored draft: editable content plus optimistic-concurrency state. */
export const draftRecordSchema = plazaContentSchema.extend({
  draftId: z.string().min(1),
  workspace: z.string().min(1),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string(),
  skillId: z.string().optional(),
  source: z.object({ sessionId: z.string(), turnId: z.string() }).optional(),
})

/** Stored draft record. */
export type PlazaDraftRecord = z.infer<typeof draftRecordSchema>

/** Stored immutable published version. */
export const versionRecordSchema = plazaContentSchema.extend({
  skillId: z.string().min(1),
  version: z.number().int().positive(),
  workspace: z.string().min(1),
  publishedAt: z.string(),
  draftId: z.string().min(1),
  draftRevision: z.number().int().nonnegative(),
  body: z.string(),
})

/** Stored published version. */
export type PlazaVersionRecord = z.infer<typeof versionRecordSchema>

/** Stored catalog row pointing at one skill's active version. */
export const skillRecordSchema = z.object({
  skillId: z.string().min(1),
  workspace: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  activeVersion: z.number().int().positive(),
  updatedAt: z.string(),
})

/** Stored catalog row. */
export type PlazaSkillRecord = z.infer<typeof skillRecordSchema>

/** Stored generation attempt. */
export const jobRecordSchema = z.object({
  jobId: z.string().min(1),
  workspace: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  attempt: z.number().int().positive(),
  updatedAt: z.string(),
  draftId: z.string().optional(),
  error: z.string().optional(),
})

/** Stored generation attempt. */
export type PlazaJobRecord = z.infer<typeof jobRecordSchema>

/** The plaza's durable storage domain. */
export const skillPlazaDomain = defineDomain({
  name: 'skill_plaza',
  version: 1,
  tables: {
    drafts: domainTable<string, PlazaDraftRecord>(draftRecordSchema),
    versions: domainTable<string, PlazaVersionRecord>(versionRecordSchema),
    skills: domainTable<string, PlazaSkillRecord>(skillRecordSchema),
    jobs: domainTable<string, PlazaJobRecord>(jobRecordSchema),
  },
})
