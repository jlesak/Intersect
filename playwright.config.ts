import { defineConfig } from '@playwright/test'

// E2E over the built Electron app (out/main/index.js). Serial, single worker: one app instance.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']]
})
