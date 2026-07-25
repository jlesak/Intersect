import { beforeEach, describe, expect, test, vi } from 'vitest'

// The only bridge surface this wiring touches is the shortcut broadcast; faking the client keeps
// the test to dispatch behaviour and lets it push ids at will.
const bridgeMock = vi.hoisted(() => {
  let invoked: ((id: string) => void) | null = null
  const api = {
    shortcuts: {
      onInvoked: (cb: (id: string) => void) => {
        invoked = cb
        return () => {}
      }
    }
  }
  return { api, invoke: (id: string) => invoked?.(id) }
})
vi.mock('@renderer/shared/ipc/client', () => ({ ipc: () => bridgeMock.api }))

import {
  registerCommand,
  __resetCommandRegistryForTests
} from '@renderer/shared/registries/commandRegistry'
import { wireShortcuts } from './shortcutWiring'

beforeEach(() => {
  __resetCommandRegistryForTests()
  vi.clearAllMocks()
})

describe('wireShortcuts', () => {
  test('an invoked shortcut runs the command registered under that id', () => {
    const handler = vi.fn()
    registerCommand({ id: 'tabs.new', title: 'New Tab', handler })
    wireShortcuts()

    bridgeMock.invoke('tabs.new')

    expect(handler).toHaveBeenCalledTimes(1)
  })

  // The menu is built from the shortcut map while commands come from feature registration, so
  // the two can be out of step during startup or after a feature is removed. A miss must stay
  // silent rather than take the renderer down.
  test('an id no command claims is ignored without throwing', () => {
    wireShortcuts()

    expect(() => bridgeMock.invoke('nothing.here')).not.toThrow()
  })
})
