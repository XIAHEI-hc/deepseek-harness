/**
 * The node half exists so the plugin is a Loader row; it contributes nothing to
 * the Host composition.
 */
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { apply } from '../src/index.ts'

it('is an inert Host plugin body', async () => {
  const ctx = new Context()
  const fiber = await ctx.plugin({ apply }).await()
  expect(apply()).toBeUndefined()
  await fiber.dispose()
})
