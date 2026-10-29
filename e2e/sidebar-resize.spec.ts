import { type ElectronApplication, type Page } from '@playwright/test'
import { expect, launch, test, tempDir } from './harness'

/**
 * The sidebar's dividers, driven the way a user drives them: a real pointer drag, then a relaunch
 * against the same profile to prove the size was written and not merely held in memory. Nothing in
 * jsdom can show that a drag moves the actual layout, because jsdom runs no layout at all.
 */
/**
 * Window sizes the stacked panels have to survive, as outer window sizes. 685 high is what the CI
 * runner's screen gives the app (653px inside): there the rail, the usage panel and the footer
 * leave the middle slot almost nothing. 600 is the app's minimum, where they no longer fit at all
 * and the sidebar scrolls.
 */
const SHORT_WINDOWS = [
  { width: 1280, height: 685 },
  { width: 940, height: 600 }
]

/** Pin the window, and fail loudly if the screen would not give it that size. */
async function pinWindow(
  app: ElectronApplication,
  win: Page,
  size: { width: number; height: number }
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()[0].setSize(s.width, s.height)
  }, size)
  await expect
    .poll(() => win.evaluate(() => [window.innerWidth, window.innerHeight]))
    .toEqual([size.width, expect.any(Number)])
  const inner = await win.evaluate(() => window.innerHeight)
  expect(inner).toBeLessThanOrEqual(size.height)
  expect(inner).toBeGreaterThan(size.height - 60)
}

const sidebarWidth = async (win: Awaited<ReturnType<typeof launch>>['win']): Promise<number> =>
  (await win.locator('.ix-sidebar').boundingBox())!.width

test('the sidebar is resized by dragging, and the size survives a restart', async () => {
  const profileDir = tempDir('intersect-sidebar-resize-')
  const first = await launch(profileDir)

  const before = await sidebarWidth(first.win)
  const grip = first.win.locator('[data-testid="sidebar-width-resizer"]')
  await expect(grip).toBeVisible()

  const box = (await grip.boundingBox())!
  await first.win.mouse.move(box.x + box.width / 2, box.y + 200)
  await first.win.mouse.down()
  await first.win.mouse.move(box.x + box.width / 2 + 90, box.y + 200, { steps: 8 })
  await first.win.mouse.up()

  const widened = await sidebarWidth(first.win)
  expect(widened).toBeGreaterThan(before + 60)

  // The size is written when the drag ends. The short wait only gives that one IPC round trip time
  // to land before the window closes.
  await first.win.waitForTimeout(150)
  await first.app.close()

  const second = await launch(profileDir)
  expect(await sidebarWidth(second.win)).toBeCloseTo(widened, -1)

  // Double-click is the way back, and it is written too.
  await second.win.locator('[data-testid="sidebar-width-resizer"]').dblclick()
  await expect
    .poll(async () => Math.round(await sidebarWidth(second.win)))
    .toBe(Math.round(before))
})

for (const size of [null, ...SHORT_WINDOWS]) {
  const at = size === null ? 'the default window' : `${size.width}x${size.height}`

  test(`every divider has its own place, even with nothing in the middle slot, at ${at}`, async () => {
    // A fresh profile draws no workspace list, and with nothing between them the two horizontal
    // dividers landed on the same pixel: the lower one took every press, so dragging the section
    // rail silently resized the usage panel instead. A short window squeezes the empty slot the
    // same way, which is how one more rail section brought the overlap back on CI.
    const { app, win } = await launch(tempDir('intersect-sidebar-stack-'))
    if (size !== null) await pinWindow(app, win, size)

    const boxes = await win.evaluate(() =>
      [...document.querySelectorAll('[role="separator"][aria-orientation="horizontal"]')].map(
        (el) => el.getBoundingClientRect().top
      )
    )

    expect(boxes).toHaveLength(2)
    expect(Math.abs(boxes[0] - boxes[1])).toBeGreaterThan(20)
  })
}

for (const size of [null, ...SHORT_WINDOWS]) {
  const at = size === null ? 'the default window' : `${size.width}x${size.height}`

  test(`a stacked panel keeps the height it was dragged to, and the keyboard drives it too, at ${at}`, async () => {
    const { app, win } = await launch(tempDir('intersect-sidebar-panels-'))
    if (size !== null) await pinWindow(app, win, size)

    const rail = win.locator('.ix-rail')
    const startHeight = (await rail.boundingBox())!.height

    const divider = win.locator('[data-testid="sidebar-rail-resizer"]')
    const box = (await divider.boundingBox())!
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await win.mouse.down()
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 70, { steps: 8 })
    await win.mouse.up()

    await expect.poll(async () => (await rail.boundingBox())!.height).toBeGreaterThan(startHeight + 40)

    // Arrow keys move the same divider, so the layout is reachable without a pointer.
    const dragged = (await rail.boundingBox())!.height
    await divider.focus()
    await divider.press('ArrowUp')
    await divider.press('ArrowUp')
    await expect.poll(async () => (await rail.boundingBox())!.height).toBeLessThan(dragged)

    // Nothing may cover the controls above a resized panel: the section rail scrolls inside it.
    expect(await rail.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto')
  })
}
