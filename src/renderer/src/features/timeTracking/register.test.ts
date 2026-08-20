import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('./ipc')
vi.mock('./agentRuntimeIpc')
import { dayKeyOf } from '@common/week'
import {
  __resetCaptureRegistryForTests,
  matchCapture
} from '@renderer/shared/registries/captureRegistry'
import {
  __resetCommandRegistryForTests,
  getCommand
} from '@renderer/shared/registries/commandRegistry'
import {
  __resetSidebarRegistryForTests,
  getSidebarSections
} from '@renderer/shared/registries/sidebarRegistry'
import { useToastStore } from '@renderer/shared/ui/toast'
import * as api from './ipc'
import { registerTimeTrackingFeature } from './register'

const mocked = vi.mocked(api)

const messages = (): string[] => useToastStore.getState().toasts.map((t) => t.message)

const capture = (line: string): Promise<void> | void => {
  const matched = matchCapture(line)!
  return matched.capture.run(matched.rest)
}

beforeEach(() => {
  __resetCaptureRegistryForTests()
  __resetCommandRegistryForTests()
  __resetSidebarRegistryForTests()
  useToastStore.setState({ toasts: [] }, false)
  vi.clearAllMocks()
  mocked.getWeek.mockResolvedValue([])
  mocked.getTimer.mockResolvedValue(null)
  registerTimeTrackingFeature()
})

describe('the time: capture', () => {
  test('logs the span against today, with the issue key it named', async () => {
    mocked.addManual.mockResolvedValue({} as never)
    await capture('time: 1h 30m fid-123 sprint review')

    expect(mocked.addManual).toHaveBeenCalledWith({
      day: dayKeyOf(Date.now()),
      description: 'sprint review',
      issueKey: 'FID-123',
      durationMs: 5_400_000
    })
  })

  test('confirms what it logged, so a user who cannot see the board still knows', async () => {
    mocked.addManual.mockResolvedValue({} as never)
    await capture('time: 30m FID-123 sprint review')
    expect(messages()[0]).toContain('30m')
    expect(messages()[0]).toContain('FID-123')
  })

  // The capture always logs to today, so which branch of the confirmation runs is decided by the
  // calendar. Both are pinned here rather than left to the day the suite happens to run on.
  describe.each([
    ['a weekday', '2026-08-05T10:00:00'],
    ['a weekend day', '2026-08-08T10:00:00']
  ])('captured on %s', (_when, now) => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(now))
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    test('the confirmation names the issue the time went to', async () => {
      mocked.addManual.mockResolvedValue({} as never)
      await capture('time: 30m FID-123 sprint review')
      expect(messages()[0]).toContain('30m')
      expect(messages()[0]).toContain('FID-123')
    })
  })

  test('a weekend capture still warns that the board will not show it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-08T10:00:00'))
    try {
      mocked.addManual.mockResolvedValue({} as never)
      await capture('time: 30m FID-123 sprint review')
      expect(messages()[0]).toContain('Saturday')
      expect(messages()[0]).toContain('does not show weekend days')
    } finally {
      vi.useRealTimers()
    }
  })

  test('a span that could not be written is never confirmed as written', async () => {
    mocked.addManual.mockRejectedValue(new Error('database is locked'))
    await capture('time: 30m FID-123 sprint review')

    expect(messages()).toEqual(['Could not add the entry: database is locked'])
  })

  test('a line with no duration logs nothing at all', async () => {
    await capture('time: sprint review')
    expect(mocked.addManual).not.toHaveBeenCalled()
    expect(messages()).toEqual([])
  })
})

describe('the week export commands', () => {
  const clipboard = { writeText: vi.fn<(text: string) => Promise<void>>() }

  beforeEach(() => {
    clipboard.writeText.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
  })

  test('copy as text puts the shown week on the clipboard in its readable form', async () => {
    await getCommand('timeTracking.copyWeekText')!.handler()
    expect(clipboard.writeText).toHaveBeenCalledWith(
      'Date\tIssue\tDescription\tDuration\nTotal\t\t\t0m'
    )
  })

  test('copy as CSV puts the shown week on the clipboard as columns', async () => {
    await getCommand('timeTracking.copyWeekCsv')!.handler()
    expect(clipboard.writeText).toHaveBeenCalledWith('Date,Issue,Description,Duration')
  })
})

describe('the sidebar section', () => {
  test('carries a running-timer marker, so the icon rail can show one too', () => {
    const section = getSidebarSections().find((s) => s.id === 'timeTracking')
    expect(section?.badge).toBeTypeOf('function')
  })
})
