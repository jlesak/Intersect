import { beforeEach, describe, expect, test } from 'vitest'
import {
  createReminderActivation,
  reminderTaskIdFromLaunchInfo,
  type ActivationWindow,
  type ReminderActivation
} from './activation'

describe('reminderTaskIdFromLaunchInfo', () => {
  test('a launch from a reminder response names its task', () => {
    expect(reminderTaskIdFromLaunchInfo({
      identifier: 'todo-reminder:abc',
      actionIdentifier: 'com.apple.UNNotificationDefaultActionIdentifier',
      date: 1_763_000_000_000,
      userInfo: {}
    })).toBe('abc')
  })

  test('every other launch names no task', () => {
    expect(reminderTaskIdFromLaunchInfo({})).toBeNull()
    expect(reminderTaskIdFromLaunchInfo(undefined)).toBeNull()
    expect(reminderTaskIdFromLaunchInfo(null)).toBeNull()
    // An NSUserNotification launch carries only its userInfo.
    expect(reminderTaskIdFromLaunchInfo({ sessionId: 'w:t' })).toBeNull()
    expect(reminderTaskIdFromLaunchInfo({ identifier: 'session-banner-id', userInfo: {} }))
      .toBeNull()
    expect(reminderTaskIdFromLaunchInfo({ identifier: 42 })).toBeNull()
  })
})

/** A window with the BrowserWindow surface the activation uses, recording what was done to it. */
function fakeWindow(state: { minimized?: boolean; visible?: boolean } = {}) {
  const calls: string[] = []
  let destroyed = false
  const win: ActivationWindow & { calls: string[]; destroy(): void } = {
    calls,
    destroy: () => {
      destroyed = true
    },
    isDestroyed: () => destroyed,
    isMinimized: () => state.minimized === true,
    restore: () => {
      calls.push('restore')
    },
    isVisible: () => state.visible !== false,
    show: () => {
      calls.push('show')
    },
    focus: () => {
      calls.push('focus')
    }
  }
  return win
}

describe('createReminderActivation', () => {
  let current: ReturnType<typeof fakeWindow> | null
  let created: number
  let focusedApp: number
  let sent: string[]
  let activation: ReminderActivation
  let order: string[]

  beforeEach(() => {
    current = null
    created = 0
    focusedApp = 0
    sent = []
    order = []
    activation = createReminderActivation({
      getWindow: () => current,
      createWindow: () => {
        created += 1
        current = fakeWindow()
        activation.windowCreated()
      },
      focusApp: () => {
        focusedApp += 1
        order.push('focusApp')
      },
      send: (taskId) => {
        sent.push(taskId)
        order.push(`send:${taskId}`)
      }
    })
  })

  test('enqueue never creates a window', () => {
    activation.enqueue('t1')
    expect(created).toBe(0)
    expect(sent).toEqual([])
  })

  test('an id enqueued before any window is sent once, when the first window has loaded', () => {
    activation.enqueue('t1')
    current = fakeWindow()
    activation.windowCreated()
    expect(sent).toEqual([])
    activation.windowLoaded()
    expect(sent).toEqual(['t1'])
    activation.windowLoaded()
    expect(sent).toEqual(['t1'])
  })

  test('activate with no window creates one window and sends only after it loads', () => {
    activation.activate('t1')
    expect(created).toBe(1)
    expect(sent).toEqual([])
    activation.windowLoaded()
    expect(sent).toEqual(['t1'])
  })

  test('activate with a live loaded window raises it, then sends at once', () => {
    const win = fakeWindow({ minimized: true, visible: false })
    current = win
    activation.windowCreated()
    activation.windowLoaded()
    activation.activate('t1')
    expect(created).toBe(0)
    expect(win.calls).toEqual(['restore', 'show', 'focus'])
    expect(focusedApp).toBe(1)
    expect(order).toEqual(['focusApp', 'send:t1'])
  })

  test('a window that is still loading gets the id when it finishes', () => {
    current = fakeWindow()
    activation.windowCreated()
    activation.activate('t1')
    expect(sent).toEqual([])
    activation.windowLoaded()
    expect(sent).toEqual(['t1'])
  })

  test('a window closed before it loaded leaves the id queued for the next window', () => {
    current = fakeWindow()
    activation.windowCreated()
    activation.enqueue('t1')
    current.destroy()
    current = null
    activation.windowClosed()
    expect(sent).toEqual([])
    // The next window, here one the Dock created.
    current = fakeWindow()
    activation.windowCreated()
    activation.windowLoaded()
    expect(sent).toEqual(['t1'])
  })

  test('two clicks before the window loads open the task clicked last', () => {
    activation.activate('t1')
    activation.activate('t2')
    expect(created).toBe(1)
    activation.windowLoaded()
    expect(sent).toEqual(['t2'])
  })

  test('a destroyed window is treated as no window', () => {
    const win = fakeWindow()
    current = win
    activation.windowCreated()
    activation.windowLoaded()
    win.destroy()
    activation.activate('t1')
    expect(created).toBe(1)
    expect(win.calls).toEqual([])
  })
})
