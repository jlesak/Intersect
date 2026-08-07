import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Page
} from '@playwright/test'

/**
 * Shared E2E harness. Every spec drove its own copy of these helpers, so a single navigation
 * rename broke fifteen tests across separate files independently - the helpers live here now so
 * that shape of change lands in one place.
 */

export const APP_ENTRY = join(__dirname, '..', 'out', 'main', 'index.js')

/**
 * Rail labels in render order on a fresh profile, which has no project pins. Settings is last
 * because it renders in the rail footer rather than the rail proper, so `.ix-rail .ix-rail__btn`
 * counts one fewer than `.ix-rail__label`.
 */
export const RAIL_LABELS = [
  'Dashboard',
  'Other',
  'People',
  'TODO',
  'Time Tracking',
  'My Work',
  'PR Review',
  'Sessions',
  'Settings'
] as const

// Temp directories are created per test and removed afterwards; a suite run otherwise left
// roughly ninety profile and workspace directories behind in the system temp dir.
const tempDirs: string[] = []

/**
 * The `test` every harness-using spec must import.
 *
 * Cleanup rides on an automatic fixture rather than a module-level `afterEach`: the harness is
 * imported once per worker, so a hook registered at module scope would only ever attach to the
 * first spec file that loaded it and every later file would leak silently.
 *
 * Because the drain empties the list after each test, `tempDir` must only ever be called from
 * inside a test. A directory taken at module scope or in a `beforeAll` would be removed once the
 * first test finished and every later test in that file would be pointed at nothing.
 */
export const test = base.extend<{ removeTempDirs: void }>({
  removeTempDirs: [
    async ({}, use) => {
      await use()
      while (tempDirs.length > 0) {
        const dir = tempDirs.pop()
        if (dir) rmSync(dir, { recursive: true, force: true })
      }
    },
    { auto: true }
  ]
})

export { expect } from '@playwright/test'

/** A tracked temp directory, removed when the current test finishes. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** A tracked, empty Electron profile directory. */
export function userDataDir(): string {
  return tempDir('intersect-e2e-')
}

/**
 * Environment for a machine with no Azure DevOps connection at all.
 *
 * Being connected is a property of the machine, not of the profile: a blank profile still inherits an
 * organisation URL and a token from `~/.claude.json` or from `AZURE_DEVOPS_*`, so on a developer
 * laptop a fresh profile is usually connected. That decides whether the app refreshes pull requests
 * by itself, which in turn decides how many syncs the canned backend has served by the time a spec
 * asserts anything - so a spec that counts syncs and does not say which machine it wants passes or
 * fails according to whose laptop ran it. Pointing the home directory at an empty temp dir and
 * blanking the environment pair is what makes "not connected" reproducible everywhere.
 */
export function unconfiguredAdo(): Record<string, string> {
  return { HOME: tempDir('intersect-empty-home-'), AZURE_DEVOPS_ORG_URL: '', AZURE_DEVOPS_PAT: '' }
}

/**
 * Environment for a connected machine, resolved from the same empty home so only these credentials
 * can count. The values are never dialled: an E2E run answers every Azure DevOps call from the canned
 * backend, and what is under test is which of those calls the app decides to make.
 */
export function connectedAdo(): Record<string, string> {
  return {
    HOME: tempDir('intersect-empty-home-'),
    AZURE_DEVOPS_ORG_URL: 'https://devops.example/e2e',
    AZURE_DEVOPS_PAT: 'e2e-token'
  }
}

export interface LaunchOptions {
  /** Extra environment for the app process. Overrides the harness defaults. */
  env?: Record<string, string>
  /**
   * Click the virtual Other context after boot. A fresh profile has no project pins, so
   * terminals and workspaces live under Other.
   */
  openOther?: boolean
}

/**
 * Launch the built app against a profile directory and wait until its shell has mounted.
 *
 * Session data is pointed at an empty fixture directory unless the caller supplies its own.
 * Without that, the indexer falls back to the real `~/.claude/projects`, so specs would read
 * whichever transcripts the developer happens to have and fail differently on every machine.
 */
export async function launch(
  profileDir: string,
  opts: LaunchOptions = {}
): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: [APP_ENTRY, `--user-data-dir=${profileDir}`],
    env: {
      ...process.env,
      INTERSECT_E2E: '1',
      INTERSECT_CLAUDE_PROJECTS_DIR: tempDir('intersect-empty-projects-'),
      ...opts.env
    }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('.ix-wordmark__name')
  await assertCoreHealthy(win)
  if (opts.openOther) await win.locator('.ix-rail__btn--other').click()
  return { app, win }
}

/**
 * Fail loudly when the core process did not reach ready.
 *
 * The failure overlay covers the viewport and does not disable pointer events, so it silently
 * swallows every click behind it. Left undetected, a core that failed to boot reports itself as
 * whichever selector the spec was about to click - which is how a stale build reads as a stale
 * test. Checked at boot; a core that dies mid-test still needs this called again to be named.
 */
export async function assertCoreHealthy(win: Page): Promise<void> {
  const overlay = win.locator('.ix-core-failure')
  if ((await overlay.count()) === 0) return
  const detail = (await overlay.textContent())?.replace(/\s+/g, ' ').trim()
  throw new Error(
    `core process is not ready - the failure overlay is up and will swallow clicks: ${detail}`
  )
}

/** Point the native folder picker at a directory so a pick-driven flow runs without UI. */
export async function stubFolderPick(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(({ dialog }, folder) => {
    ;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder]
    })
  }, dir)
}

/**
 * Answer the quit confirmation with "Suspend & Quit".
 *
 * Quitting with a live Claude session prompts, and an automated run has nobody to answer it.
 * Stubbing the prompt rather than suppressing the whole confirmation keeps the real teardown -
 * the suspend decision, the core shutdown, the exit - under test.
 */
export async function stubQuitConfirm(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({
      response: 0,
      checkboxChecked: false
    })
  })
}

/** Add a workspace through the folder picker and wait for it to become the active one. */
export async function addWorkspace(
  win: Page,
  app: ElectronApplication,
  dir: string
): Promise<void> {
  await stubFolderPick(app, dir)
  await win.locator('.ix-add').click()
  await win.locator('.ix-ws__rename').waitFor()
  await win.keyboard.press('Enter')
  await expect(win.locator('.ix-ws--active')).toBeVisible()
}

/**
 * Trigger an app-wide shortcut by activating its menu item.
 *
 * Every app-wide shortcut is a native menu accelerator, and synthetic key events sent over the
 * debugging protocol never reach the application menu - so a spec must click the item itself.
 */
export async function invokeMenu(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ Menu }, menuId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(menuId)
    if (!item) throw new Error(`no application menu item with id "${menuId}"`)
    item.click()
  }, id)
}

/** Open a rail destination by its label and wait for the given root selector to appear. */
export async function openRailSection(win: Page, label: string, root: string): Promise<void> {
  await win.locator('.ix-rail__btn', { hasText: label }).click()
  await win.locator(root).waitFor()
}
