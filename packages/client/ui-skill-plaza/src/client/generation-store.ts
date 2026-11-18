/**
 * Generation tasks one conversation turn shows while its reply is distilled
 * into a skill, and after it settles.
 *
 * The Host owns the attempt record; this store mirrors what the card needs to
 * paint it. One instance exists per Session, so a message identity is a
 * sufficient key.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { PropsStore } from '@deepseek-ai/dsh-client-ui-slots'

/** Stage a running generation reports, in the order it reaches them. */
export type GenerationStage = 'harvest' | 'distill' | 'check' | 'save'

/** Status of one turn's generation. */
export type GenerationStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'

/** The draft a succeeded generation produced, summarized for the card. */
export interface GenerationDraftSummary {
  /** Durable draft identity the plaza page opens. */
  readonly draftId: string
  /** Display title the model wrote. */
  readonly title: string
  /** What the skill is for. */
  readonly description: string
  /** Callable kebab-case name. */
  readonly slug: string
  /** Draft revision, always 1 for a freshly generated draft. */
  readonly revision: number
  /** Operating steps the draft holds. */
  readonly steps: number
  /** Tool dependencies the draft names. */
  readonly tools: number
  /** Display category, when the model supplied one. */
  readonly category?: string
}

/** One turn's generation task. */
export interface GenerationTask {
  /** Where the attempt stands. */
  readonly status: GenerationStatus
  /** Attempt counter the Host reports. */
  readonly attempt: number
  /** Durable attempt identity, once the Host answered. */
  readonly jobId?: string
  /** Stage a running attempt reached. */
  readonly stage?: GenerationStage
  /** Characters the model had produced when the attempt last reported. */
  readonly chars?: number
  /** Wall-clock start, on the browser's clock, so the card can show elapsed time. */
  readonly startedAt: number
  /** Readable reason a failed attempt produced no draft. */
  readonly error?: string
  /** Draft a succeeded attempt produced. */
  readonly draft?: GenerationDraftSummary
}

interface GenerationState {
  /** Tasks by the durable message identity of the Turn they belong to. */
  tasks: Record<string, GenerationTask | undefined>
}

const generationActions = {
  setTask: (state: GenerationState, messageId: string, task: GenerationTask) => {
    state.tasks[messageId] = task
  },
  clearTask: (state: GenerationState, messageId: string) => {
    state.tasks = Object.fromEntries(Object.entries(state.tasks).filter(([id]) => id !== messageId))
  },
}

/**
 * Declare the generation tasks one Session's turns show.
 * @returns the store handle the chip and the card both bind.
 */
export function createGenerationStore(): EngineStoreHandle<GenerationState, typeof generationActions> {
  return defineStore({
    init: (): GenerationState => ({ tasks: {} }),
    actions: generationActions,
  })
}

/** Framework-bound selectors and actions; components never receive the store itself. */
export type GenerationStoreProps = PropsStore<ReturnType<typeof createGenerationStore>>
