import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { type ElectronApplication, type Page } from '@playwright/test'
import { expect, invokeMenu, launch, openRailSection, test, userDataDir } from './harness'

/** The local `yyyy-mm-dd` day key `offset` days from today, as the app computes it. */
function dayKey(offset = 0): string {
  const now = new Date()
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 12)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Write entries straight into a closed profile's database, the way past days come to exist. The
 * search index follows through its triggers, so these rows are as findable as captured ones.
 */
function seedNotes(profileDir: string, rows: { day: string; body: string }[]): void {
  const db = new DatabaseSync(join(profileDir, 'intersect.db'))
  try {
    const insert = db.prepare(
      'INSERT INTO note_entry (id, day, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    )
    rows.forEach((row, i) => {
      const [y, m, d] = row.day.split('-').map(Number)
      const at = new Date(y, m - 1, d, 9, i).getTime()
      insert.run(`seed-${i}`, row.day, row.body, at, at)
    })
  } finally {
    db.close()
  }
}

async function openNotes(win: Page): Promise<void> {
  await openRailSection(win, 'Notes', '.ix-notes')
}

async function capture(app: ElectronApplication, win: Page, line: string): Promise<void> {
  await invokeMenu(app, 'palette.open')
  await win.locator('.ix-palette__input').fill(line)
  await win.keyboard.press('Enter')
  await expect(win.locator('.ix-palette')).toHaveCount(0)
}

const today = (win: Page) => win.locator('.ix-notes__today')
const historySection = (win: Page) => win.locator('.ix-notes__history')
const todayBodies = (win: Page) => today(win).locator('.ix-note__body')
const captureBox = (win: Page) => win.getByLabel('New note')
const searchBox = (win: Page) => win.getByLabel('Search notes')
const historyDays = (win: Page) => historySection(win).locator('.ix-notes__day')

/** The days the history shows, by their keys, newest first. */
async function shownDays(win: Page): Promise<(string | null)[]> {
  return historyDays(win).evaluateAll((els) => els.map((el) => el.getAttribute('data-day')))
}

test('"note:" in the palette previews, adds to today and confirms', async () => {
  const profileDir = userDataDir()
  const { app, win } = await launch(profileDir)

  await invokeMenu(app, 'palette.open')
  // The prefix alone explains itself and runs nothing.
  await win.locator('.ix-palette__input').fill('note:')
  await expect(win.locator('.ix-palette__capture-hint')).toContainText("today's note")
  await win.keyboard.press('Enter')
  await expect(win.locator('.ix-palette')).toBeVisible()

  await win.locator('.ix-palette__input').fill('note: Call Bob about the cache')
  await expect(win.locator('.ix-palette__capture .ix-palette__title')).toHaveText(
    "Add to today's note: Call Bob about the cache"
  )
  await win.keyboard.press('Enter')
  await expect(win.locator('.ix-palette')).toHaveCount(0)
  await expect(win.locator('.ix-toast')).toContainText("Added to today's note")

  // Any case of the prefix works the same.
  await capture(app, win, 'NOTE: shouting')

  await openNotes(win)
  await expect(todayBodies(win)).toHaveText(['Call Bob about the cache', 'shouting'])
  await expect(today(win).locator('.ix-note__time').first()).toHaveText(/^\d{2}:\d{2}$/)
})

test('the view adds, edits and deletes entries, and they survive a restart', async () => {
  const profileDir = userDataDir()
  const first = await launch(profileDir)
  const win = first.win
  await openNotes(win)

  // The capture box has the cursor as soon as Notes opens.
  await expect(captureBox(win)).toBeFocused()
  await expect(win.locator('.ix-notes__empty')).toBeVisible()

  // A multi-line entry by Cmd+Enter keeps its line breaks.
  await captureBox(win).fill('line one\nline two')
  await captureBox(win).press('Meta+Enter')
  await expect(todayBodies(win)).toHaveText(['line one\nline two'])
  await expect(captureBox(win)).toHaveValue('')
  await expect(win.locator('.ix-notes__empty')).toHaveCount(0)

  // Whitespace alone adds nothing, by either route.
  await captureBox(win).fill('   \n  ')
  await captureBox(win).press('Meta+Enter')
  await win.getByRole('button', { name: 'Add' }).click()
  await expect(todayBodies(win)).toHaveCount(1)

  await captureBox(win).fill('edit me by enter')
  await win.getByRole('button', { name: 'Add' }).click()
  await captureBox(win).fill('edit me by blur')
  await captureBox(win).press('Meta+Enter')
  await captureBox(win).fill('delete me')
  await captureBox(win).press('Meta+Enter')
  await expect(todayBodies(win)).toHaveCount(4)

  // Double-click, type, Enter.
  await todayBodies(win).filter({ hasText: 'edit me by enter' }).dblclick()
  const editor = win.getByLabel('Edit note')
  await editor.fill('edited by enter')
  await editor.press('Enter')
  await expect(editor).toHaveCount(0)

  // The pencil, type, click away.
  const blurRow = today(win).locator('.ix-note').filter({ hasText: 'edit me by blur' })
  await blurRow.hover()
  await blurRow.getByTitle('Edit').click()
  await editor.fill('edited by blur')
  await win.locator('.ix-notes__heading').first().click()
  await expect(editor).toHaveCount(0)

  // Delete asks nothing.
  const deleteRow = today(win).locator('.ix-note').filter({ hasText: 'delete me' })
  await deleteRow.hover()
  await deleteRow.getByTitle('Delete').click()

  const expected = ['line one\nline two', 'edited by enter', 'edited by blur']
  await expect(todayBodies(win)).toHaveText(expected)
  await first.app.close()

  const second = await launch(profileDir)
  await openNotes(second.win)
  await expect(todayBodies(second.win)).toHaveText(expected)
})

test('past days are listed newest first, searched by word prefix and limited by dates', async () => {
  const profileDir = userDataDir()
  const first = await launch(profileDir)
  await first.app.close()
  seedNotes(profileDir, [
    { day: dayKey(-10), body: 'Budget review with Alice' },
    { day: dayKey(-3), body: 'The CACHE was cold' },
    { day: dayKey(-3), body: 'Lunch with the team' },
    { day: dayKey(-1), body: 'Deploy blocked by cache invalidation' },
    { day: dayKey(0), body: 'Lunch today' }
  ])

  const { win } = await launch(profileDir)
  await openNotes(win)
  await expect(todayBodies(win)).toHaveText(['Lunch today'])
  await expect.poll(() => shownDays(win)).toEqual([dayKey(-1), dayKey(-3), dayKey(-10)])

  // Search: only the matching days, only the matching entries, the match marked.
  await searchBox(win).fill('cach')
  await expect.poll(() => shownDays(win)).toEqual([dayKey(-1), dayKey(-3)])
  await expect(historySection(win).locator('.ix-note__body')).toHaveText([
    'Deploy blocked by cache invalidation',
    'The CACHE was cold'
  ])
  await expect(historySection(win).locator('.ix-notes__hit')).toHaveText(['cach', 'CACH'])
  // Today stays whole whatever the filters say.
  await expect(todayBodies(win)).toHaveText(['Lunch today'])

  // Matching starts at a word only.
  await searchBox(win).fill('ache')
  await expect(win.locator('.ix-notes__no-match')).toBeVisible()
  await expect(historyDays(win)).toHaveCount(0)
  await expect(win.locator('.ix-notes__empty')).toHaveCount(0)

  await searchBox(win).fill('')
  await expect.poll(() => shownDays(win)).toEqual([dayKey(-1), dayKey(-3), dayKey(-10)])

  // From only: open towards today.
  const from = win.locator('.ix-notes__from')
  const to = win.locator('.ix-notes__to')
  await from.fill(dayKey(-3))
  await expect.poll(() => shownDays(win)).toEqual([dayKey(-1), dayKey(-3)])
  // Both: inclusive at each end.
  await to.fill(dayKey(-3))
  await expect.poll(() => shownDays(win)).toEqual([dayKey(-3)])
  // To only: open into the past.
  await from.fill('')
  await expect.poll(() => shownDays(win)).toEqual([dayKey(-3), dayKey(-10)])
  // Combined with search.
  await searchBox(win).fill('lunch')
  await expect(historySection(win).locator('.ix-note__body')).toHaveText(['Lunch with the team'])
  await expect(todayBodies(win)).toHaveText(['Lunch today'])
  // Cleared: the whole history again.
  await searchBox(win).fill('')
  await to.fill('')
  await expect.poll(() => shownDays(win)).toEqual([dayKey(-1), dayKey(-3), dayKey(-10)])
})

test('a fresh profile shows the empty line, and the capture still works', async () => {
  const { win } = await launch(userDataDir())
  await openNotes(win)
  await expect(win.locator('.ix-notes__empty')).toBeVisible()
  await expect(win.locator('.ix-notes__no-match')).toHaveCount(0)

  await searchBox(win).fill('zzz')
  await expect(win.locator('.ix-notes__no-match')).toBeVisible()
  await expect(win.locator('.ix-notes__empty')).toHaveCount(0)
  await searchBox(win).fill('')

  await captureBox(win).fill('the first note')
  await captureBox(win).press('Meta+Enter')
  await expect(todayBodies(win)).toHaveText(['the first note'])
  await expect(win.locator('.ix-notes__empty')).toHaveCount(0)
})

test('the view fits the minimum window without horizontal overflow', async () => {
  const profileDir = userDataDir()
  const first = await launch(profileDir)
  await first.app.close()
  seedNotes(profileDir, [
    { day: dayKey(-2), body: 'x'.repeat(400) },
    { day: dayKey(-1), body: `see https://example.test/${'very-long-path-segment/'.repeat(20)}` }
  ])

  const { app, win } = await launch(profileDir)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(940, 600))
  await expect
    .poll(() => win.evaluate(() => [window.innerWidth, window.innerHeight <= 600]))
    .toEqual([940, true])

  await openNotes(win)
  await captureBox(win).fill(`today ${'y'.repeat(400)}`)
  await captureBox(win).press('Meta+Enter')
  await expect(todayBodies(win)).toHaveCount(1)
  await expect(historyDays(win)).toHaveCount(2)

  const overflow = await win.evaluate(() => {
    const view = document.querySelector('.ix-notes') as HTMLElement
    const root = document.documentElement
    return {
      view: view.scrollWidth - view.clientWidth,
      page: root.scrollWidth - root.clientWidth
    }
  })
  expect(overflow).toEqual({ view: 0, page: 0 })

  // The filter controls lie inside the view.
  const viewBox = (await win.locator('.ix-notes').boundingBox())!
  const filterControls = [
    searchBox(win),
    win.locator('.ix-notes__from'),
    win.locator('.ix-notes__to')
  ]
  for (const control of filterControls) {
    const box = (await control.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(viewBox.x)
    expect(box.x + box.width).toBeLessThanOrEqual(viewBox.x + viewBox.width)
  }

  // The capture box stays reachable and still adds.
  await captureBox(win).scrollIntoViewIfNeeded()
  await expect(captureBox(win)).toBeInViewport()
  await captureBox(win).fill('still reachable')
  await win.getByRole('button', { name: 'Add' }).click()
  await expect(todayBodies(win)).toHaveCount(2)

  // Writing one note after another: once Today is taller than the view, each new entry pushes the
  // box down, and it has to come back fully into view without the user scrolling to it.
  const view = win.locator('.ix-notes')
  for (let i = 3; i <= 14; i++) {
    await captureBox(win).fill(`note number ${i}\nwith a second line`)
    await captureBox(win).press('Meta+Enter')
    await expect(todayBodies(win)).toHaveCount(i)
    await expect(captureBox(win)).toHaveValue('')
    await expect(captureBox(win)).toBeFocused()
    await expect
      .poll(async () => {
        const v = (await view.boundingBox())!
        const box = (await captureBox(win).boundingBox())!
        return box.y >= v.y && box.y + box.height <= v.y + v.height
      })
      .toBe(true)
  }
  // The rows really did outgrow the view, so the loop above tested the scroll and not a short list.
  expect(await view.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
})
