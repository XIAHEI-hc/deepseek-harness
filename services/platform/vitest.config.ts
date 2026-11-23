import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['services/platform/tests/**/*.spec.ts'],
    exclude: ['services/platform/tests/e2e/**'],
    setupFiles: [],
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
