import { describe, expect, test, vi } from 'vitest'
import type { Logger } from '@common/logging/logger'
import { loadNativeReminders, nativeAddonPath } from './native'

const logger = (): Logger & { warn: ReturnType<typeof vi.fn> } => {
  const l = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => l }
  return l
}

describe('nativeAddonPath', () => {
  test('points out of the asar archive, where a native addon can be loaded', () => {
    expect(nativeAddonPath('/Applications/Intersect.app/Contents/Resources/app.asar/out/main'))
      .toBe('/Applications/Intersect.app/Contents/Resources/app.asar.unpacked/out/native/todo_reminders.node')
  })

  test('outside an archive the path is left as it is', () => {
    expect(nativeAddonPath('/repo/out/main')).toBe('/repo/out/native/todo_reminders.node')
  })
})

describe('loadNativeReminders', () => {
  test('a missing addon file gives null and a warning', () => {
    const log = logger()
    const dlopen = vi.fn()
    expect(loadNativeReminders({ mainDir: '/repo/out/main', logger: log, exists: () => false,
      dlopen })).toBeNull()
    expect(dlopen).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  test('an addon that fails to load gives null and a warning', () => {
    const log = logger()
    expect(loadNativeReminders({ mainDir: '/repo/out/main', logger: log, exists: () => true,
      dlopen: () => {
        throw new Error('wrong architecture')
      } })).toBeNull()
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  test('a loaded addon hands back its exports', () => {
    const exports = { authorizationStatus: vi.fn() }
    const loaded = loadNativeReminders({ mainDir: '/repo/out/main', logger: logger(),
      exists: () => true,
      dlopen: (module) => {
        module.exports = exports
      } })
    expect(loaded).toBe(exports)
  })
})
