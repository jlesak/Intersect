import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { TodoReminderActivatedEvent } from '@common/ipc'

// One fake preload bridge: a reminder click arrives through it, and the task lookup the focus
// request starts never answers, so no test depends on what the list would show.
const bridge = vi.hoisted(() => {
  let listener: ((msg: TodoReminderActivatedEvent) => void) | null = null
  return {
    api: {
      todo: {
        getById: () => new Promise(() => {}),
        onReminderActivated: (cb: (msg: TodoReminderActivatedEvent) => void) => {
          listener = cb
          return () => {
            if (listener === cb) listener = null
          }
        }
      }
    },
    click: (taskId: string) => listener?.({ taskId })
  }
})
vi.mock('@renderer/shared/ipc/client', () => ({ ipc: () => bridge.api }))

import { TODO_SECTION_ID, useTodoStore } from '@renderer/features/todo'
import { useShellStore } from './shellStore'
import { wireTodoFocus, wireTodoReminderActivation } from './todoFocusWiring'

let unwire: () => void

beforeEach(() => {
  unwire?.()
  useTodoStore.setState({ pendingFocusId: null })
  useShellStore.getState().setActiveSection('dashboard')
  unwire = wireTodoFocus()
})

describe('wireTodoFocus', () => {
  test('a focus request switches the shell to the TODO section', () => {
    useTodoStore.getState().focusTask('t1')
    expect(useShellStore.getState().context).toEqual({ kind: 'section', id: TODO_SECTION_ID })
  })

  test('the request survives the switch, because the list is what consumes it', () => {
    // Clearing the intent here - the order the other wiring modules use - would destroy the only
    // record of which row to reveal before the list has had a chance to mount and read it.
    useTodoStore.getState().focusTask('t1')
    expect(useTodoStore.getState().pendingFocusId).toBe('t1')
  })

  test('clearing the request does not navigate anywhere', () => {
    useTodoStore.getState().focusTask('t1')
    useShellStore.getState().setActiveSection('dashboard')
    useTodoStore.getState().clearFocus()
    expect(useShellStore.getState().context).toEqual({ kind: 'section', id: 'dashboard' })
  })

  test('unwiring stops the wiring from navigating again', () => {
    unwire()
    useTodoStore.getState().focusTask('t1')
    expect(useShellStore.getState().context).toEqual({ kind: 'section', id: 'dashboard' })
  })
})

describe('wireTodoReminderActivation', () => {
  test('a clicked reminder opens its task in the TODO section', () => {
    const unwireReminders = wireTodoReminderActivation()
    bridge.click('t9')
    expect(useTodoStore.getState().pendingFocusId).toBe('t9')
    expect(useShellStore.getState().context).toEqual({ kind: 'section', id: TODO_SECTION_ID })
    unwireReminders()
  })

  test('unwiring stops reminder clicks from opening tasks', () => {
    wireTodoReminderActivation()()
    bridge.click('t9')
    expect(useTodoStore.getState().pendingFocusId).toBeNull()
  })
})
