import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@common': resolve(__dirname, '../../src/common') } },
  test: { include: ['evals/time-summary/*.test.ts'], environment: 'node',
    testTimeout: 600_000, maxWorkers: 1 }
})
