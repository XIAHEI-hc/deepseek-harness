/**
 * Injects a Workspace's project instructions into every later turn of its Sessions.
 *
 * The injection is a logged user message with a `project-context` source, so the
 * transcript records which project and which instruction revision a turn ran with.
 * The source kind joins the merge-extensible message-source map instead of replacing it.
 * @module @deepseek-ai/dsh-api-workspace-controller/src/project-context
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-working-directory'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'project-context': {
      readonly kind: 'project-context'
      /** Workspace whose instructions this turn read. */
      readonly workspaceId: string
      /** Revision of the instructions at injection time. */
      readonly instructionsRevision: number
    }
  }
}

/**
 * Register the project-context pre-step listener when the composition runs agents.
 * @param ctx - Host context owning the Workspace registry.
 */
export function installProjectContext(ctx: Context): void {
  ctx.inject(['workingDirectory'], (scope) => {
    scope.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      signal.throwIfAborted()
      const directory = await scope.workingDirectory.ensure(agent, signal)
      const workspace = await ctx.workspaceRegistry.resolveByPath(directory)
      if (workspace === undefined || workspace.instructions === '') return decision
      const injection = createUserMessage({
        content: [{
          type: 'text',
          text: `Project instructions (${workspace.title}, revision ${workspace.instructionsRevision}):\n\n${workspace.instructions}`,
        }],
        source: {
          kind: 'project-context',
          workspaceId: workspace.id,
          instructionsRevision: workspace.instructionsRevision,
        },
      })
      const remaining = decision.messages.filter(message => message.source?.kind !== 'project-context'
        || message.source.workspaceId !== workspace.id)
      return { ...decision, messages: [injection, ...remaining] }
    })
  })
}
