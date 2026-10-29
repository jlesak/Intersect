import { beforeEach, describe, expect, test, vi } from 'vitest'

// Registering touches no IPC, but nothing here may reach a bridge that does not exist under test.
vi.mock('@renderer/shared/ipc/client', () => ({ ipc: vi.fn() }))
import { registerNotesFeature } from '@renderer/features/notes'
import { registerOneOnOneFeature } from '@renderer/features/oneOnOne'
import { registerTimeTrackingFeature } from '@renderer/features/timeTracking'
import { registerTodoFeature } from '@renderer/features/todo'
import {
  __resetCaptureRegistryForTests,
  matchCapture
} from '@renderer/shared/registries/captureRegistry'
import { __resetCommandRegistryForTests } from '@renderer/shared/registries/commandRegistry'
import { __resetSidebarRegistryForTests } from '@renderer/shared/registries/sidebarRegistry'

/**
 * The real capture prefixes side by side. A new prefix lands in one shared registry, so this is
 * where a clash or a prefix that swallows another would show.
 */
beforeEach(() => {
  __resetCaptureRegistryForTests()
  __resetSidebarRegistryForTests()
  __resetCommandRegistryForTests()
  registerTodoFeature()
  registerNotesFeature()
  registerOneOnOneFeature()
  registerTimeTrackingFeature()
})

describe('quick capture prefixes', () => {
  test.each([
    ['note: call Bob', 'note:', 'call Bob'],
    ['NOTE: x', 'note:', 'x'],
    ['todo: a', 'todo:', 'a'],
    ['time: 1h', 'time:', '1h'],
    ['1:1: X', '1:1:', 'X']
  ])('"%s" goes to %s', (line, prefix, rest) => {
    const matched = matchCapture(line)
    expect(matched?.capture.prefix).toBe(prefix)
    expect(matched?.rest).toBe(rest)
  })
})
