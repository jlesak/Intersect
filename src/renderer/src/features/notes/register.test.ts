import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('./ipc')
import {
  __resetCaptureRegistryForTests,
  matchCapture
} from '@renderer/shared/registries/captureRegistry'
import {
  __resetSidebarRegistryForTests,
  getSidebarSections
} from '@renderer/shared/registries/sidebarRegistry'
import { useToastStore } from '@renderer/shared/ui/toast'
import * as api from './ipc'
import { registerNotesFeature } from './register'

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
  mocked.list.mockResolvedValue([])
  registerNotesFeature()
})

describe('the Notes section', () => {
  test('sits in the rail right after TODO and owns the main area', () => {
    const notes = getSidebarSections().find((s) => s.id === 'notes')!
    expect(notes.label).toBe('Notes')
    expect(notes.order).toBeGreaterThan(11)
    expect(notes.order).toBeLessThan(12)
    expect(notes.mainComponent).toBeDefined()
  })
})

describe('the note: capture', () => {
  test('previews exactly what it will add', () => {
    const matched = matchCapture('note: Call Bob about the cache')!
    expect(matched.capture.preview(matched.rest)).toBe(
      "Add to today's note: Call Bob about the cache"
    )
  })

  test('with nothing after the prefix it offers its hint and nothing to run', async () => {
    const matched = matchCapture('note:   ')!
    expect(matched.capture.hint).toMatch(/today's note/)
    expect(matched.capture.preview(matched.rest)).toBeNull()
    await capture('note:   ')
    expect(mocked.add).not.toHaveBeenCalled()
    expect(messages()).toEqual([])
  })

  test('any case of the prefix selects it', () => {
    expect(matchCapture('NOTE: x')?.capture.prefix).toBe('note:')
    expect(matchCapture('Note: x')?.rest).toBe('x')
  })

  test('adds the text to today and confirms it', async () => {
    mocked.add.mockResolvedValue({} as never)
    await capture('note: Call Bob about the cache')
    expect(mocked.add).toHaveBeenCalledWith('Call Bob about the cache')
    expect(messages()).toEqual(["Added to today's note"])
  })

  test('a note that could not be written is reported and never confirmed', async () => {
    mocked.add.mockRejectedValue(new Error('database is locked'))
    await capture('note: Call Bob')
    expect(messages()).toEqual(['Could not save the note: database is locked'])
  })
})
