/**
 * Durable plaza records and the storage domain that owns them.
 *
 * The domain keeps six append-mostly tables in one JSON unit under the
 * Harness home: drafts (mutable, revision-guarded), published versions
 * (immutable), the active-version catalog, generation attempts, workspace
 * media (immutable), and the versions pinned to a Session's next invocation.
 * Every record carries the workspace directory it belongs to, so workspace
 * isolation is a read filter rather than a second store. Version 1 domains
 * opened by an earlier release stay readable: `presentation` and every later
 * field are optional here.
 *
 * @module @deepseek-ai/dsh-skill-plaza
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { plazaPresentationSchema } from './presentation.ts'

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
  presentation: plazaPresentationSchema.optional(),
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
  category: z.string().optional(),
  coverAssetId: z.string().optional(),
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
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  attempt: z.number().int().positive(),
  updatedAt: z.string(),
  // Progress fields are absent on attempts written before a running attempt
  // reported them, and on every settled attempt.
  stage: z.enum(['harvest', 'distill', 'check', 'save']).optional(),
  chars: z.number().int().nonnegative().optional(),
  startedAt: z.string().optional(),
  draftId: z.string().optional(),
  error: z.string().optional(),
})

/** Stored generation attempt. */
export type PlazaJobRecord = z.infer<typeof jobRecordSchema>

/** Stored workspace image: detected facts plus the immutable bytes. */
export const mediaRecordSchema = z.object({
  assetId: z.string().min(1),
  workspace: z.string().min(1),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  byteLength: z.number().int().positive(),
  createdAt: z.string(),
  data: z.string(),
})

/** Stored workspace image. */
export type PlazaMediaRecord = z.infer<typeof mediaRecordSchema>

/** Stored version binding for one Session's next explicit invocation. */
export const pinRecordSchema = z.object({
  sessionId: z.string().min(1),
  workspace: z.string().min(1),
  skillId: z.string().min(1),
  version: z.number().int().positive(),
  slug: z.string().min(1),
  updatedAt: z.string(),
})

/** Stored version binding. */
export type PlazaPinRecord = z.infer<typeof pinRecordSchema>

/** The plaza's durable storage domain. */
export const skillPlazaDomain = defineDomain({
  name: 'skill_plaza',
  version: 2,
  // Version 1 stored drafts, versions, catalog rows, jobs, and pins without
  // presentation content or workspace media; every current record schema
  // accepts those records unchanged.
  compatibleVersions: [1],
  tables: {
    drafts: domainTable<string, PlazaDraftRecord>(draftRecordSchema),
    versions: domainTable<string, PlazaVersionRecord>(versionRecordSchema),
    skills: domainTable<string, PlazaSkillRecord>(skillRecordSchema),
    jobs: domainTable<string, PlazaJobRecord>(jobRecordSchema),
    media: domainTable<string, PlazaMediaRecord>(mediaRecordSchema),
    pins: domainTable<string, PlazaPinRecord>(pinRecordSchema),
  },
})
