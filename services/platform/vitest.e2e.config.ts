import { defineConfig } from 'vitest/config'

/**
 * End-to-end platform suite: real identity database, real process-backend DSH
 * runtimes, real HTTP and WebSocket traffic. Slower and stateful, so it runs in
 * one fork and is opt-in through `pnpm run test:platform:e2e`.
 */
export default defineConfig({
  test: {
    include: ['services/platform/tests/e2e/**/*.spec.ts'],
    setupFiles: [],
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 900_000,
    hookTimeout: 300_000,
  },
})
