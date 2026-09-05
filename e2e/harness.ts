import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { closeRegisteredApps, registerApp } from '../tooling/e2eApps'
import { appEntry } from '../tooling/e2eFreshness'
import { launchEnv, windowLaunchVars } from '../tooling/e2eLaunchEnv'

/**
 * Shared E2E harness. Every spec drove its own copy of these helpers, so a single navigation
 * rename broke fifteen tests across separate files independently - the helpers live here now so
 * that shape of change lands in one place.
 */

/**
 * The built app every spec launches. Taken from the freshness guard so that the file being launched
 * and the file being checked for staleness cannot drift apart.
 */
export const APP_ENTRY = appEntry(resolve(__dirname, '..'))

/**
 * Rail labels in render order on a fresh profile, which has no project pins. Settings is last
 * because it renders in the rail footer rather than the rail proper, so `.ix-rail .ix-rail__btn`
 * counts one fewer than `.ix-rail__label`.
 */
export const RAIL_LABELS = [
  'Dashboard',
  'Other',
  '1:1',
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
 * Both drains live in one fixture body so that their order is stated rather than inferred. Apps go
 * first: a profile directory removed out from under a process that is still running is a race, and
 * splitting the two across separate fixtures would leave that order resting on which of them
 * Playwright happened to set up first.
 *
 * Because the drain empties the list after each test, `tempDir` must only ever be called from
 * inside a test. A directory taken at module scope or in a `beforeAll` would be removed once the
 * first test finished and every later test in that file would be pointed at nothing.
 */
export const test = base.extend<{ cleanUp: void }>({
  cleanUp: [
    async ({}, use) => {
      await use()
      await closeRegisteredApps()
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
 *
 * The returned `errors` array accumulates renderer console errors and uncaught page errors for the
 * life of the window. Collection is unconditional because it has to start before the shell mounts:
 * a spec cannot subscribe after `launch` returns without having already missed everything the app
 * logged while booting, which is the part worth catching.
 *
 * Closing is the harness's job, not the spec's: every app is handed to the drain that runs after
 * the test whatever its outcome, so a failed assertion can no longer leave one running. It is
 * handed over the instant it exists, because everything between here and the return - waiting for
 * the window, waiting for the shell, the core health check that exists to throw - can fail on a
 * broken build, and an app abandoned mid-launch is abandoned just as thoroughly as one abandoned
 * mid-test.
 */
export async function launch(
  profileDir: string,
  opts: LaunchOptions = {}
): Promise<{ app: ElectronApplication; win: Page; errors: string[] }> {
  const app = await electron.launch({
    args: [APP_ENTRY, `--user-data-dir=${profileDir}`],
    env: launchEnv({
      INTERSECT_E2E: '1',
      ...windowLaunchVars(),
      INTERSECT_CLAUDE_PROJECTS_DIR: tempDir('intersect-empty-projects-'),
      ...opts.env
    })
  })
  registerApp(app)
  const win = await app.firstWindow()
  const errors: string[] = []
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  win.on('pageerror', (e) => errors.push(e.message))
  await win.waitForSelector('.ix-wordmark__name')
  await assertCoreHealthy(win)
  if (opts.openOther) await win.locator('.ix-rail__btn--other').click()
  return { app, win, errors }
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
 * Replace the system-browser launch with a recorder, and answer with what it has been handed.
 *
 * Opening a real browser mid-suite is both disruptive and unassertable, and the URL is the whole
 * point of a link: it travels the renderer, the preload bridge, the IPC allowlist and Electron's
 * shell, and only the far end proves the address a user would actually land on.
 */
export async function stubOpenExternal(app: ElectronApplication): Promise<() => Promise<string[]>> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = []
    ;(globalThis as unknown as { __openedExternal: string[] }).__openedExternal = opened
    ;(shell as unknown as { openExternal: unknown }).openExternal = async (url: string) => {
      opened.push(url)
    }
  })
  return () =>
    app.evaluate(() => (globalThis as unknown as { __openedExternal: string[] }).__openedExternal)
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

/**
 * Answer the quit confirmation with "Cancel", and report how many times it was raised.
 *
 * Cancel is what makes a quit assertion sharp. Under this stub the only way an app can exit is by
 * never having asked, so "the process is gone" states, on its own, that the confirmation was
 * skipped. The count says the same thing from the other side and is readable for as long as the app
 * is alive, which under Cancel is exactly the case where it is wanted.
 */
export async function stubQuitConfirmCancel(
  app: ElectronApplication
): Promise<() => Promise<number>> {
  await app.evaluate(({ dialog }) => {
    const state = globalThis as unknown as { __quitPrompts: number }
    state.__quitPrompts = 0
    ;(dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => {
      state.__quitPrompts += 1
      return { response: 1, checkboxChecked: false }
    }
  })
  return () => app.evaluate(() => (globalThis as unknown as { __quitPrompts: number }).__quitPrompts)
}

/**
 * Raise the system's genuine power-off signal inside the running app.
 *
 * `postWorkspaceNotification` posts NSWorkspaceWillPowerOffNotification, the very notification macOS
 * posts when the user asks to log out, restart or shut down, so the whole native chain runs: the
 * workspace observer, Electron's shutdown handler, and the JavaScript listener that reads it. The
 * call resolves on that listener firing, which reproduces the ordering a real logout provides -
 * the signal lands before the system's quit request does, so a quit that follows already knows.
 */
export async function signalSystemShutdown(app: ElectronApplication): Promise<void> {
  await app.evaluate(
    ({ powerMonitor, systemPreferences }) =>
      new Promise<void>((resolve) => {
        powerMonitor.once('shutdown', () => resolve())
        systemPreferences.postWorkspaceNotification('NSWorkspaceWillPowerOffNotification', {})
      })
  )
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
