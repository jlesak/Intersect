import { defineConfig } from '@playwright/test'

// E2E over the built Electron app (out/main/index.js). Serial, single worker: one app instance.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  // Deliberately no retries: this suite is a merge gate, and a retry turns a flake into a pass
  // instead of a signal. A trace is kept for failures because without one every failure reads as a
  // bare timeout, which is what made the stale suite so expensive to diagnose. Playwright's
  // screenshot option does not apply to Electron, so the trace is the whole story.
  retries: 0,
  use: {
    trace: 'retain-on-failure'
  }
})
