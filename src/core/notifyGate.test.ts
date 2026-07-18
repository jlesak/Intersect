import { describe, it, expect, vi } from 'vitest'
import type { NotificationSettings } from '@common/domain'
import { createNotifyGate } from './notifyGate'

const ALL_ON: NotificationSettings = {
  enabled: true,
  working: true,
  waiting: true,
  done: true,
  sound: true
}

describe('createNotifyGate', () => {
  it('raises the notification with the sound preference when the status is enabled', () => {
    const raise = vi.fn()
    const notify = createNotifyGate(() => ALL_ON, raise)
    notify('w:a', 'waiting')
    expect(raise).toHaveBeenCalledWith('w:a', 'waiting', true)
  })

  it('drops every status when notifications are globally disabled', () => {
    const raise = vi.fn()
    const notify = createNotifyGate(() => ({ ...ALL_ON, enabled: false }), raise)
    notify('w:a', 'working')
    notify('w:a', 'waiting')
    notify('w:a', 'done')
    expect(raise).not.toHaveBeenCalled()
  })

  it('drops only the status whose per-status toggle is off', () => {
    const raise = vi.fn()
    const notify = createNotifyGate(() => ({ ...ALL_ON, waiting: false }), raise)
    notify('w:a', 'waiting')
    notify('w:a', 'done')
    expect(raise).toHaveBeenCalledTimes(1)
    expect(raise).toHaveBeenCalledWith('w:a', 'done', true)
  })

  it('carries a muted sound preference through to the raised notification', () => {
    const raise = vi.fn()
    const notify = createNotifyGate(() => ({ ...ALL_ON, sound: false }), raise)
    notify('w:a', 'done')
    expect(raise).toHaveBeenCalledWith('w:a', 'done', false)
  })

  it('carries the message and risk metadata through to the raised notification', () => {
    const raise = vi.fn()
    const notify = createNotifyGate(() => ALL_ON, raise)
    notify('w:a', 'waiting', 'perm?', 'dangerous')
    expect(raise).toHaveBeenCalledWith('w:a', 'waiting', true, 'perm?', 'dangerous')
  })

  it('omits trailing undefined message/risk so callers without them stay unchanged', () => {
    const raise = vi.fn()
    const notify = createNotifyGate(() => ALL_ON, raise)
    notify('w:a', 'done', 'finished')
    expect(raise).toHaveBeenCalledWith('w:a', 'done', true, 'finished')
  })

  it('reads the preferences fresh on every event so a toggle applies without restart', () => {
    let prefs: NotificationSettings = { ...ALL_ON }
    const raise = vi.fn()
    const notify = createNotifyGate(() => prefs, raise)

    notify('w:a', 'waiting')
    expect(raise).toHaveBeenCalledTimes(1)

    // The user turns the 'waiting' toggle off between events; the next alert must be dropped.
    prefs = { ...ALL_ON, waiting: false }
    notify('w:a', 'waiting')
    expect(raise).toHaveBeenCalledTimes(1)

    // Turning it back on re-enables the alert, still without rebuilding the gate.
    prefs = { ...ALL_ON }
    notify('w:a', 'waiting')
    expect(raise).toHaveBeenCalledTimes(2)
  })
})
