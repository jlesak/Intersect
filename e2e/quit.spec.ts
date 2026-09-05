import { mkdirSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { hasExited } from '../tooling/e2eApps'
import {
  addWorkspace,
  expect,
  launch,
  signalSystemShutdown,
  stubQuitConfirm,
  stubQuitConfirmCancel,
  tempDir,
  test,
  userDataDir
} from './harness'

/**
 * The two halves of the quit guard, proved against each other.
 *
 * A live Claude session puts a confirmation in front of every quit, and the confirmation waits for
 * an answer with no deadline. That is right while somebody is there and ruinous while nobody is: a
 * logout, restart or shut down sends the app the same quit request, and an app that sits on an
 * unanswered dialog halts the whole logout with no window on screen to explain why.
 *
 * Both tests answer the confirmation with Cancel, which is what makes them mean anything. Under a
 * Cancel-answering stub an app that exits can only have exited without asking, and an app that is
 * asked stays alive - so the first test's clean exit and the second test's survival are each proof
 * the other path was taken.
 */

/** Open a Claude Code tab in the active workspace, which is what makes a quit ask. */
async function openClaudeTab(win: Awaited<ReturnType<typeof launch>>['win']): Promise<void> {
  await win.locator('.ix-iconbtn[title="New terminal"]').click()
  await win.locator('.ix-preset', { hasText: 'Claude Code' }).click()
  await expect(win.locator('.ix-tab')).toHaveCount(1)
  await expect(win.locator('.xterm')).toBeVisible()
}

/** Read the one Claude tab's durable suspend marker straight from the app profile. */
function readClaudeSuspend(profileDir: string): {
  session_status: string | null
  suspend_reason: string | null
} {
  const db = new DatabaseSync(join(profileDir, 'intersect.db'))
  try {
    return db
      .prepare(
        "SELECT session_status, suspend_reason FROM tabs WHERE preset = 'claude' ORDER BY sort_order LIMIT 1"
      )
      .get() as { session_status: string | null; suspend_reason: string | null }
  } finally {
    db.close()
  }
}

/**
 * A real Claude transcript under the exact HOME/cwd-derived path boot reconciliation verifies.
 * Keeping HOME isolated means the test proves resume without reading or writing user data.
 */
function resumeFixture(cwd: string): {
  env: Record<string, string>
} {
  const fakeHome = tempDir('restart-home-')
  const projectsDir = join(fakeHome, '.claude', 'projects')
  const projectDir = join(projectsDir, cwd.replace(/[^A-Za-z0-9]/g, '-'))
  const sessionId = '11211211-2211-3211-4211-521152115211'
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(
    join(projectDir, `${sessionId}.jsonl`),
    [
      { type: 'ai-title', aiTitle: 'Restart-safe session', sessionId },
      {
        type: 'user',
        message: { role: 'user', content: 'keep this conversation across restart' },
        timestamp: new Date().toISOString(),
        cwd,
        gitBranch: 'main',
        isMeta: false
      }
    ]
      .map((line) => JSON.stringify(line))
      .join('\n')
  )
  return {
    env: { HOME: fakeHome, INTERSECT_CLAUDE_PROJECTS_DIR: projectsDir }
  }
}

test('restart schedules one relaunch but exits only after the coordinated suspend teardown', async () => {
  const profileDir = userDataDir()
  const wsDir = tempDir('restartws-')
  const fixture = resumeFixture(wsDir)
  const { app, win } = await launch(profileDir, { env: fixture.env, openOther: true })
  const proc = app.process()
  await win.locator('.ix-rail__btn', { hasText: 'Sessions' }).click()
  await win.locator('.ix-session-row', { hasText: 'Restart-safe session' }).click()
  await win.locator('.ix-transcript__header .ix-btn--primary', { hasText: 'Resume' }).click()
  await expect(win.locator('.ix-tab')).toHaveCount(1)
  await expect(win.locator('.xterm')).toBeVisible()

  // Keep main alive after its exit call so the test can inspect both the Electron calls and the DB
  // state at precisely the point production would disappear. The saved closure invokes the real
  // exit afterwards, so teardown never leaves a zombie app behind even while this test is RED.
  await app.evaluate(({ app: electronApp, dialog }) => {
    const finish = electronApp.exit.bind(electronApp)
    const state = globalThis as unknown as {
      __restartProbe: { relaunches: number; exits: number; prompts: number }
      __finishRestartProbe: () => void
    }
    state.__restartProbe = { relaunches: 0, exits: 0, prompts: 0 }
    state.__finishRestartProbe = () => finish(0)
    ;(electronApp as unknown as { relaunch: () => void }).relaunch = () => {
      state.__restartProbe.relaunches += 1
    }
    ;(electronApp as unknown as { exit: (code?: number) => void }).exit = () => {
      state.__restartProbe.exits += 1
    }
    ;(dialog as unknown as { showMessageBox: () => Promise<{ response: number; checkboxChecked: boolean }> })
      .showMessageBox = async () => {
      state.__restartProbe.prompts += 1
      return { response: 1, checkboxChecked: false }
    }
  })

  try {
    await win.evaluate(() => {
      void (
        window as unknown as { intersect: { system: { restartApp(): Promise<void> } } }
      ).intersect.system.restartApp()
    })
    await expect
      .poll(
        () =>
          app.evaluate(
            () =>
              (globalThis as unknown as { __restartProbe: unknown }).__restartProbe as {
                relaunches: number
                exits: number
                prompts: number
              }
          ),
        { message: 'restart never reached its final exit' }
      )
      .toEqual({ relaunches: 1, exits: 1, prompts: 0 })

    // `app.exit` without CoreHost.shutdown leaves this null. A coordinated restart reaches the
    // core's transaction first, so the marker is durable before the final exit is attempted.
    expect(readClaudeSuspend(profileDir)).toEqual({
      session_status: 'suspended',
      suspend_reason: 'app-quit-suspend'
    })
  } finally {
    await app
      .evaluate(() =>
        (globalThis as unknown as { __finishRestartProbe: () => void }).__finishRestartProbe()
      )
      .catch(() => undefined)
  }

  await expect.poll(() => hasExited(proc)).toBe(true)
  const { app: relaunched, win: relaunchedWin } = await launch(profileDir, {
    env: fixture.env,
    openOther: true
  })
  try {
    await expect(relaunchedWin.locator('.ix-tab')).toHaveCount(1)
    await expect(relaunchedWin.locator('.xterm')).toBeVisible()
    await expect(relaunchedWin.locator('.ix-pane__restored')).toContainText('Obnoveno po ukončení')
    await expect.poll(() => readClaudeSuspend(profileDir)).toEqual({
      session_status: null,
      suspend_reason: null
    })
  } finally {
    await stubQuitConfirm(relaunched).catch(() => undefined)
    await relaunched.close().catch(() => undefined)
  }
})

test('two quit requests while the first answer is pending raise exactly one confirmation', async () => {
  const wsDir = tempDir('doublequitws-')
  const { app, win } = await launch(userDataDir(), { openOther: true })
  await addWorkspace(win, app, wsDir)
  await openClaudeTab(win)

  await app.evaluate(({ dialog }) => {
    type Answer = { response: number; checkboxChecked: boolean }
    const state = globalThis as unknown as {
      __pendingQuitProbe: {
        calls: number
        active: number
        resolvers: Array<(answer: Answer) => void>
      }
    }
    state.__pendingQuitProbe = { calls: 0, active: 0, resolvers: [] }
    ;(dialog as unknown as { showMessageBox: () => Promise<Answer> }).showMessageBox = async () => {
      state.__pendingQuitProbe.calls += 1
      state.__pendingQuitProbe.active += 1
      try {
        return await new Promise<Answer>((resolve) => state.__pendingQuitProbe.resolvers.push(resolve))
      } finally {
        state.__pendingQuitProbe.active -= 1
      }
    }
  })

  try {
    await app.evaluate(({ app: electronApp }) => {
      electronApp.quit()
      electronApp.quit()
    })
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as unknown as { __pendingQuitProbe: { calls: number } }).__pendingQuitProbe
              .calls
        )
      )
      .toBe(1)

    // Cancel must release the single-flight guard so a genuinely later quit asks again.
    await app.evaluate(() => {
      const state = (
        globalThis as unknown as {
          __pendingQuitProbe: {
            resolvers: Array<(answer: { response: number; checkboxChecked: boolean }) => void>
          }
        }
      ).__pendingQuitProbe
      for (const resolve of state.resolvers.splice(0)) {
        resolve({ response: 1, checkboxChecked: false })
      }
    })
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as unknown as { __pendingQuitProbe: { active: number } }).__pendingQuitProbe
              .active
        )
      )
      .toBe(0)

    const laterPromptCount = await stubQuitConfirmCancel(app)
    await app.evaluate(({ app: electronApp }) => electronApp.quit())
    await expect.poll(laterPromptCount).toBe(1)
    expect(hasExited(app.process()), 'Cancel unexpectedly tore the app down').toBe(false)
  } finally {
    await app
      .evaluate(() => {
        const probe = (
          globalThis as unknown as {
            __pendingQuitProbe?: {
              resolvers: Array<(answer: { response: number; checkboxChecked: boolean }) => void>
            }
          }
        ).__pendingQuitProbe
        for (const resolve of probe?.resolvers.splice(0) ?? []) {
          resolve({ response: 1, checkboxChecked: false })
        }
      })
      .catch(() => undefined)
    await stubQuitConfirm(app).catch(() => undefined)
    await app.close().catch(() => undefined)
  }
})

test('a hidden window is shown before the quit confirmation is attached as a sheet', async () => {
  const wsDir = tempDir('hiddenquitws-')
  const { app, win } = await launch(userDataDir(), { openOther: true })
  await addWorkspace(win, app, wsDir)
  await openClaudeTab(win)

  await app.evaluate(({ dialog }) => {
    const state = globalThis as unknown as {
      __dialogParentProbe: { calls: number; argumentCount: number; parentVisible: boolean }
    }
    state.__dialogParentProbe = { calls: 0, argumentCount: 0, parentVisible: false }
    ;(
      dialog as unknown as {
        showMessageBox: (...args: unknown[]) => Promise<{ response: number; checkboxChecked: boolean }>
      }
    ).showMessageBox = async (...args: unknown[]) => {
      const parent = args.length === 2 ? (args[0] as { isVisible(): boolean }) : null
      state.__dialogParentProbe = {
        calls: state.__dialogParentProbe.calls + 1,
        argumentCount: args.length,
        parentVisible: parent?.isVisible() ?? false
      }
      return { response: 1, checkboxChecked: false }
    }
  })

  try {
    await app.evaluate(({ app: electronApp }) => electronApp.quit())
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as unknown as { __dialogParentProbe: unknown }).__dialogParentProbe as {
              calls: number
              argumentCount: number
              parentVisible: boolean
            }
        )
      )
      .toEqual({ calls: 1, argumentCount: 2, parentVisible: true })
    expect(hasExited(app.process()), 'Cancel unexpectedly tore the app down').toBe(false)
  } finally {
    await stubQuitConfirm(app).catch(() => undefined)
    await app.close().catch(() => undefined)
  }
})

test('a quit with no window creates a visible sheet parent instead of a blocking app modal', async () => {
  const wsDir = tempDir('windowlessquitws-')
  const { app, win } = await launch(userDataDir(), { openOther: true })
  await addWorkspace(win, app, wsDir)
  await openClaudeTab(win)

  await app.evaluate(({ dialog }) => {
    const state = globalThis as unknown as {
      __windowlessDialogProbe: { calls: number; argumentCount: number; parentVisible: boolean }
    }
    state.__windowlessDialogProbe = { calls: 0, argumentCount: 0, parentVisible: false }
    ;(
      dialog as unknown as {
        showMessageBox: (...args: unknown[]) => Promise<{ response: number; checkboxChecked: boolean }>
      }
    ).showMessageBox = async (...args: unknown[]) => {
      const parent = args.length === 2 ? (args[0] as { isVisible(): boolean }) : null
      state.__windowlessDialogProbe = {
        calls: state.__windowlessDialogProbe.calls + 1,
        argumentCount: args.length,
        parentVisible: parent?.isVisible() ?? false
      }
      return { response: 1, checkboxChecked: false }
    }
  })

  await win.close()
  try {
    await app.evaluate(({ app: electronApp }) => electronApp.quit())
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as unknown as { __windowlessDialogProbe: unknown }).__windowlessDialogProbe as {
              calls: number
              argumentCount: number
              parentVisible: boolean
            }
        )
      )
      .toEqual({ calls: 1, argumentCount: 2, parentVisible: true })
    expect(hasExited(app.process()), 'Cancel unexpectedly tore the app down').toBe(false)
  } finally {
    await stubQuitConfirm(app).catch(() => undefined)
    await app.close().catch(() => undefined)
  }
})

test('a system shutdown finishes the quit by itself, without asking to suspend', async () => {
  const wsDir = tempDir('shutdownws-')
  const { app, win } = await launch(userDataDir(), { openOther: true })
  await addWorkspace(win, app, wsDir)
  await stubQuitConfirmCancel(app)
  await openClaudeTab(win)

  // The real notification, then the quit the system sends after it - the order a logout produces.
  const proc = app.process()
  await signalSystemShutdown(app)
  await app.evaluate(({ app: electronApp }) => electronApp.quit())

  await expect
    .poll(() => hasExited(proc), {
      message: 'the app never finished a quit that nobody was there to answer'
    })
    .toBe(true)
  expect(proc.exitCode, 'the app did not exit through its own coordinated shutdown').toBe(0)
})

test('an ordinary quit still waits for the answer, and Cancel keeps everything running', async () => {
  const wsDir = tempDir('cancelws-')
  const { app, win } = await launch(userDataDir(), { openOther: true })
  await addWorkspace(win, app, wsDir)
  const promptCount = await stubQuitConfirmCancel(app)
  await openClaudeTab(win)

  const proc = app.process()
  await app.evaluate(({ app: electronApp }) => electronApp.quit())

  // Waiting for the confirmation to have been raised is what makes the survival below a statement
  // about Cancel rather than about a quit that had not got started yet.
  await expect
    .poll(promptCount, { message: 'the quit never raised the suspend confirmation' })
    .toBe(1)
  expect(hasExited(proc), 'Cancel tore the app down anyway').toBe(false)
  await expect(win.locator('.ix-tab')).toHaveCount(1)

  // And the app is still quittable: the cancelled quit left nothing latched.
  await stubQuitConfirm(app)
  await app.close()
  expect(hasExited(proc), 'the app would not quit after a cancelled one').toBe(true)
})

test('a shutdown that never took the app leaves the next quit guarded again', async () => {
  const wsDir = tempDir('abortedws-')
  const { app, win } = await launch(userDataDir(), { openOther: true })
  await addWorkspace(win, app, wsDir)
  const promptCount = await stubQuitConfirmCancel(app)
  await openClaudeTab(win)

  // A logout broadcasts the power-off to every app before it asks any of them to quit, and one
  // app refusing aborts the whole sequence. macOS announces the broadcast and never the abort, so
  // this is the state the app is left in: signalled, and still running with no quit request.
  await signalSystemShutdown(app)
  // A click and a keystroke, which are the part no shutdown sequence can fake.
  await win.locator('.xterm').click()
  await win.keyboard.press('Escape')

  const proc = app.process()
  await app.evaluate(({ app: electronApp }) => electronApp.quit())

  await expect
    .poll(promptCount, {
      message: 'the quit skipped the confirmation on a shutdown that never happened'
    })
    .toBe(1)
  expect(hasExited(proc), 'the sessions were torn down with no chance to cancel').toBe(false)
  await expect(win.locator('.ix-tab')).toHaveCount(1)

  await stubQuitConfirm(app)
  await app.close()
})
