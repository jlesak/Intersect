import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// The packaged-app smoke test needs `npm run pack:mac` first, so it stays out of `npm test`.
export default defineConfig({
  resolve: { alias: { '@common': resolve(__dirname, 'src/common') } },
  test: {
    name: 'smoke',
    environment: 'node',
    include: ['tooling/**/*.smoke.ts'],
    testTimeout: 30_000
  }
})
