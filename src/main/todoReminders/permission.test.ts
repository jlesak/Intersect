import { describe, expect, test, vi } from 'vitest'
import { ELECTRON_ONLY_CHANNELS } from '@common/coreBridge'
import { Channel } from '@common/ipc'
import { createLogger } from '@common/logging/logger'
import { registerCoreBridge } from '../ipc/bridge'
import { createReminderPermissionHandlers, NOTIFICATION_SETTINGS_URL } from './permission'
import type { AuthorizationStatus } from './native'

function harness(status: AuthorizationStatus = 'denied', available = true) {
  const native = {
    authorizationStatus: vi.fn(async () => status),
    requestAuthorization: vi.fn(), schedule: vi.fn(), cancel: vi.fn(), pending: vi.fn()
  }
  const openExternal = vi.fn<(url: string) => Promise<void>>(async () => {})
  const lines: string[] = []
  const logger = createLogger({ sink: { write: (line) => lines.push(line) },
    proc: 'main', pid: 1, scope: 'todo', level: 'debug' })
  const handlers = createReminderPermissionHandlers({ getNative: () => available ? native : null,
    openExternal, logger })
  return { native, openExternal, handlers, lines }
}

describe('reminder permission handlers', () => {
  test.each<AuthorizationStatus>(['denied', 'authorized', 'provisional', 'notDetermined', 'unknown'])(
    'reads %s without prompting or changing the schedule', async (status) => {
      const h = harness(status)
      expect(await h.handlers.getReminderPermission()).toBe(status)
      await h.handlers.openReminderSettings()
      expect(h.native.authorizationStatus).toHaveBeenCalledTimes(1)
      for (const method of ['requestAuthorization', 'schedule', 'cancel', 'pending'] as const) {
        expect(h.native[method]).not.toHaveBeenCalled()
      }
    })

  test('an unavailable adapter is distinct from denial', async () => {
    const h = harness('denied', false)
    expect(await h.handlers.getReminderPermission()).toBe('unavailable')
    expect(h.native.authorizationStatus).not.toHaveBeenCalled()
  })

  test('a failed read is logged, returns error, and can recover', async () => {
    const h = harness()
    h.native.authorizationStatus.mockRejectedValueOnce(new Error('Native read failed'))
    expect(await h.handlers.getReminderPermission()).toBe('error')
    expect(h.lines.join('\n')).toContain('Native read failed')
    expect(await h.handlers.getReminderPermission()).toBe('denied')
  })

  test('registered IPC uses the fixed settings target and never forwards to core', async () => {
    const h = harness()
    const handles = new Map<string, (...args: unknown[]) => unknown>()
    const request = vi.fn()
    registerCoreBridge({
      ipcMain: { handle: (channel, listener) => { handles.set(channel, listener as never) },
        on: vi.fn() },
      host: { request, notify: vi.fn(), onPush: () => () => {} },
      electronOnly: { ...Object.fromEntries([...ELECTRON_ONLY_CHANNELS].map((c) => [c, vi.fn()])),
        [Channel.todoGetReminderPermission]: h.handlers.getReminderPermission,
        [Channel.todoOpenReminderSettings]: h.handlers.openReminderSettings },
      sendToRenderer: vi.fn(), showNotification: vi.fn(), setDockBadge: vi.fn(),
      applyTodoReminders: vi.fn()
    })
    expect(await handles.get(Channel.todoGetReminderPermission)!({})).toBe('denied')
    await handles.get(Channel.todoOpenReminderSettings)!({}, 'https://untrusted.invalid', '--command')
    expect(h.openExternal).toHaveBeenCalledExactlyOnceWith(NOTIFICATION_SETTINGS_URL)
    expect(request).not.toHaveBeenCalled()
  })

  test('settings failure rejects for the user action to report', async () => {
    const h = harness()
    h.openExternal.mockRejectedValue(new Error('Cannot open settings'))
    await expect(h.handlers.openReminderSettings()).rejects.toThrow('Cannot open settings')
  })
})
