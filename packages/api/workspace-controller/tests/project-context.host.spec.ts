/** Project instructions reach the turn through the real `agent/pre-step` waterfall. */
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SESSION_FORMAT_VERSION, Session, type SessionId } from '@deepseek-ai/dsh-session'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { installProjectContext } from '../src/project-context.ts'

const DIR = '/workspace/project-a'

/** Minimal Agent over a real Session header at the project directory. */
function fakeAgent(): Agent {
  const sessionId = brandString<SessionId>('session-project')
  const session = Session.create(sessionId, [], {
    version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, cwd: DIR, isSeeded: false,
  })
  return {
    ctx: new Context(),
    id: sessionId,
    options: {},
    session,
    model: unsupportedModel(),
    inbox: unsupportedInbox(),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('project context never injects into the inbox') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** Mount only the project-context listener over stub services. */
async function mount(instructions: string, revision: number, path = DIR) {
  const ctx = new Context()
  const workspace = {
    id: brandString<WorkspaceId>('workspace-a'), title: 'Benchmark', instructions, instructionsRevision: revision,
  }
  ctx.provide('workspaceRegistry', { resolveByPath: async (value: string) => value === path ? workspace : undefined } as never)
  ctx.provide('workingDirectory', { ensure: async () => path } as never)
  installProjectContext(ctx)
  await new Promise(resolve => setTimeout(resolve, 10))
  return ctx
}

/** Run one pre-step through the waterfall and return its decision. */
async function step(ctx: Context, agent: Agent) {
  return await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    {
      modelSelection: { provider: 'mock', model: 'mock' },
      messages: [createUserMessage({ content: [{ type: 'text', text: 'compare the releases' }], source: { kind: 'user' } })],
      turn: 1, step: 1, signal: new AbortController().signal,
    },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
}

it('prepends the project instructions with the revision the turn ran with', async () => {
  const ctx = await mount('Compare datasets before metrics.', 2)
  const decision = await step(ctx, fakeAgent())
  expect(decision.kind).toBe('enter')
  if (decision.kind !== 'enter') return
  expect(decision.messages).toHaveLength(1)
  const source = decision.messages[0]?.source
  expect(source).toMatchObject({ kind: 'project-context', workspaceId: 'workspace-a', instructionsRevision: 2 })
  expect(JSON.stringify(decision.messages[0]?.content)).toContain('Compare datasets before metrics.')
})

it('leaves the turn untouched when the project has no instructions', async () => {
  const ctx = await mount('', 0)
  const decision = await step(ctx, fakeAgent())
  expect(decision).toEqual({ kind: 'enter', messages: [] })
})
