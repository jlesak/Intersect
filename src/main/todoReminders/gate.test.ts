import { describe, expect, test } from 'vitest'
import { useNativeReminders } from './gate'

const DEFAULT = '/Users/me/Library/Application Support/Intersect'

describe('useNativeReminders', () => {
  // The pending store belongs to the bundle id, so every build that is not the installed app on
  // its own profile would wipe or double the owner's reminders.
  const cases = [
    { packaged: true, e2e: false, userDataDir: DEFAULT, expected: true },
    { packaged: true, e2e: false, userDataDir: '/tmp/other-profile', expected: false },
    { packaged: true, e2e: true, userDataDir: DEFAULT, expected: false },
    { packaged: true, e2e: true, userDataDir: '/tmp/other-profile', expected: false },
    { packaged: false, e2e: false, userDataDir: DEFAULT, expected: false },
    { packaged: false, e2e: false, userDataDir: '/tmp/other-profile', expected: false },
    { packaged: false, e2e: true, userDataDir: DEFAULT, expected: false },
    { packaged: false, e2e: true, userDataDir: '/tmp/other-profile', expected: false }
  ]

  test.each(cases)(
    'packaged=$packaged e2e=$e2e userDataDir=$userDataDir -> $expected',
    ({ packaged, e2e, userDataDir, expected }) => {
      expect(useNativeReminders({ packaged, e2e, userDataDir, defaultUserDataDir: DEFAULT }))
        .toBe(expected)
    }
  )

  test('the same default profile spelled with a trailing slash still counts as the default', () => {
    expect(useNativeReminders({ packaged: true, e2e: false, userDataDir: `${DEFAULT}/`,
      defaultUserDataDir: DEFAULT })).toBe(true)
  })
})
