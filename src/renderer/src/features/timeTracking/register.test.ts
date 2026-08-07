import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('./ipc')
vi.mock('./agentRuntimeIpc')
import { dayKeyOf } from '@common/week'
import {
  __resetCaptureRegistryForTests,
  matchCapture
} from '@renderer/shared/registries/captureRegistry'
import { __resetCommandRegistryForTests } from '@renderer/shared/registries/commandRegistry'
import { __resetSidebarRegistryForTests } from '@renderer/shared/registries/sidebarRegistry'
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
