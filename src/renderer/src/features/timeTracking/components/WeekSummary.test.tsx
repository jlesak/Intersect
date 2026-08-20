import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Project, TimeEntry } from '@common/domain'

vi.mock('../ipc')
import { useProjectsStore } from '@renderer/features/projects'
import { useTimeTrackingStore } from '../store'
import { parseDuration, totalMs } from '../time'
import { WeekSummary } from './WeekSummary'

const MIN = 60_000

const entry = (id: string, over: Partial<TimeEntry> = {}): TimeEntry => ({
  id,
  source: 'manual',
  day: '2026-08-17',
  description: 'Work',
  issueKey: null,
  durationMs: 30 * MIN,
  ...over
})

const PROJECT: Project = {
  id: 'p1',
  name: 'Fabia',
  sortOrder: 0,
  archived: false,
  repoPaths: ['/repo'],
  jiraJql: 'project = FID2507',
  jiraBoardUrl: null,
  adoRepositories: []
}

const WEEK = [
  entry('a', { issueKey: 'FID2507-611', durationMs: 90 * MIN }),
  entry('b', { issueKey: null, durationMs: 30 * MIN })
]

const rows = (rollup: string): string[][] =>
  [...document.querySelectorAll(`[data-rollup="${rollup}"] .ix-tt-summary__row`)].map((row) =>
    [...row.children].map((cell) => cell.textContent?.trim() ?? '')
  )

const mount = async (): Promise<void> => {
  await act(async () => {
    render(<WeekSummary />)
  })
}

/**
 * Mounted client-side rather than as static markup: both rollups build fresh nested arrays, and
 * only a real root can expose a re-render loop from an unstable derivation.
 */
describe('WeekSummary', () => {
  beforeEach(() => {
    useTimeTrackingStore.setState({ entries: WEEK, summaryOpen: false })
    useProjectsStore.setState({ projects: [PROJECT], overrides: [] })
  })

  afterEach(() => {
    useTimeTrackingStore.setState({ entries: [], summaryOpen: false })
    useProjectsStore.setState({ projects: [], overrides: [] })
  })

  test('starts collapsed, with the export still reachable, and settles without a render loop', async () => {
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    try {
      await mount()
      expect(logged).toEqual([])
      expect(document.querySelector('.ix-tt-summary__body')).toBeNull()
      expect(document.querySelector('.ix-tt-summary__toggle')?.getAttribute('aria-expanded')).toBe(
        'false'
      )
      expect([...document.querySelectorAll('.ix-tt-summary__head .ix-btn')].map((b) => b.textContent)).toEqual(
        ['Copy text', 'Copy CSV']
      )
      // The week holds one real issue on one project plus half an hour of unattributed time, and
      // the hint counts only what is really attributed.
      expect(document.querySelector('.ix-tt-summary__count')?.textContent).toBe(
        '1 issue · 1 project'
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  test('opening shows both rollups, with unattributed time in its own named bucket', async () => {
    await mount()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.ix-tt-summary__toggle')?.click()
    })
    expect(rows('By issue')).toEqual([
      ['FID2507-611', '1', '1h 30m'],
      ['No issue', '1', '30m']
    ])
    expect(rows('By project')).toEqual([
      ['Fabia', '1', '1h 30m'],
      ['Other', '1', '30m']
    ])
  })

  test('the catch-all buckets are marked, so they never read as a real issue or project', async () => {
    useTimeTrackingStore.setState({ summaryOpen: true })
    await mount()
    const marked = [...document.querySelectorAll('.ix-tt-summary__label--catch-all')].map(
      (el) => el.textContent
    )
    expect(marked).toEqual(['No issue', 'Other'])
  })

  test('both rollups add up to the weekly grand total the topbar shows', async () => {
    useTimeTrackingStore.setState({ summaryOpen: true })
    await mount()
    for (const rollup of ['By issue', 'By project']) {
      const sum = rows(rollup).reduce((s, r) => s + (parseDuration(r[2]) ?? 0), 0)
      expect(sum).toBe(totalMs(WEEK))
    }
  })

  test('an empty week says so in both rollups rather than showing a blank panel', async () => {
    useTimeTrackingStore.setState({ entries: [], summaryOpen: true })
    await mount()
    expect(document.querySelectorAll('.ix-tt-summary__empty')).toHaveLength(2)
  })

  test('a copy button asks the store for the shown week', async () => {
    const copyWeek = vi.spyOn(useTimeTrackingStore.getState(), 'copyWeek').mockResolvedValue(undefined)
    await mount()
    await act(async () => {
      const buttons = document.querySelectorAll<HTMLButtonElement>('.ix-tt-summary__head .ix-btn')
      buttons[1]?.click()
    })
    expect(copyWeek).toHaveBeenCalledWith('csv')
    copyWeek.mockRestore()
  })
})
