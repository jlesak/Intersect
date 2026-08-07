import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('./ipc')
import { dayKeyOf } from '@common/week'
import {
  __resetCaptureRegistryForTests,
  matchCapture
} from '@renderer/shared/registries/captureRegistry'
import { __resetSidebarRegistryForTests } from '@renderer/shared/registries/sidebarRegistry'
import { useToastStore } from '@renderer/shared/ui/toast'
import * as api from './ipc'
import { registerTodoFeature } from './register'

const mocked = vi.mocked(api)

const messages = (): string[] => useToastStore.getState().toasts.map((t) => t.message)

const capture = (line: string): Promise<void> | void => {
  const matched = matchCapture(line)!
  return matched.capture.run(matched.rest)
}

beforeEach(() => {
  __resetCaptureRegistryForTests()
  __resetSidebarRegistryForTests()
  useToastStore.setState({ toasts: [] }, false)
  vi.clearAllMocks()
  mocked.list.mockResolvedValue({ open: [], done: [] })
  registerTodoFeature()
})

describe('the todo: capture', () => {
  test('writes the task with the due day its wording named', async () => {
    mocked.add.mockResolvedValue({} as never)
    await capture('todo: call the vendor tomorrow')

    const today = dayKeyOf(Date.now())
    const [text, dueDay] = mocked.add.mock.calls[0]
    expect(text).toBe('call the vendor')
    expect(dueDay).not.toBe(today)
    expect(dueDay).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test('confirms what it wrote, so a user who cannot see the list still knows', async () => {
    mocked.add.mockResolvedValue({} as never)
    await capture('todo: call the vendor tomorrow')
    expect(messages()).toEqual(['Task added: call the vendor, due tomorrow'])
  })

  test('a task that could not be written is never confirmed as written', async () => {
    mocked.add.mockRejectedValue(new Error('database is locked'))
    await capture('todo: call the vendor tomorrow')

    // The failure is reported; the success line that would contradict it must not appear.
    expect(messages()).toEqual(['Could not add the task: database is locked'])
  })

  test('nothing usable after the prefix writes nothing at all', async () => {
    await capture('todo:   ')
    expect(mocked.add).not.toHaveBeenCalled()
    expect(messages()).toEqual([])
  })
})
