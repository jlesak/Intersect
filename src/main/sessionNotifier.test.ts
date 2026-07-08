import { describe, it, expect, vi } from 'vitest'
import type { AttentionKind } from './pty/attentionMarkers'
import { createSessionNotifier, type SessionNotifierDeps } from './sessionNotifier'

/** Build a notifier with spy collaborators and a scripted detector. */
function harness(opts: { focused?: boolean; detect?: (chunk: string) => AttentionKind | null } = {}) {
  const notify = vi.fn()
  const broadcastStatus = vi.fn()
  let focused = opts.focused ?? false
  const detect = opts.detect ?? ((chunk: string) => (chunk.includes('WANT') ? 'idle' : null))
  const deps: SessionNotifierDeps = {
    detect: (_sessionId, chunk) => detect(chunk),
    notify,
    broadcastStatus,
    isWindowFocused: () => focused
  }
  const notifier = createSessionNotifier(deps)
  return { notifier, notify, broadcastStatus, setFocused: (f: boolean) => (focused = f) }
}

describe('sessionNotifier', () => {
  it('alerts (notify + broadcast) with the mapped status when a chunk signals attention', () => {
    const h = harness()
    h.notifier.onChunk('w:a', 'please WANT input')
    expect(h.notify).toHaveBeenCalledWith('w:a', 'done')
    expect(h.broadcastStatus).toHaveBeenCalledWith('w:a', 'done')
  })

  it('maps a permission marker to the waiting status', () => {
    const h = harness({ detect: () => 'permission' })
    h.notifier.onChunk('w:a', 'x')
    expect(h.notify).toHaveBeenCalledWith('w:a', 'waiting')
    expect(h.broadcastStatus).toHaveBeenCalledWith('w:a', 'waiting')
  })

  it('does nothing for chunks with no marker', () => {
    const h = harness()
    h.notifier.onChunk('w:a', 'ordinary output')
    expect(h.notify).not.toHaveBeenCalled()
    expect(h.broadcastStatus).not.toHaveBeenCalled()
  })

  it('suppresses the alert when the window is focused on the active session', () => {
    const h = harness({ focused: true })
    h.notifier.reportActive('w:a')
    h.notifier.onChunk('w:a', 'WANT')
    expect(h.notify).not.toHaveBeenCalled()
    expect(h.broadcastStatus).not.toHaveBeenCalled()
  })

  it('still alerts a focused window when a different session signals', () => {
    const h = harness({ focused: true })
    h.notifier.reportActive('w:a')
    h.notifier.onChunk('w:b', 'WANT')
    expect(h.notify).toHaveBeenCalledWith('w:b', 'done')
  })

  it('alerts a background session even when its tab is the active one (window not focused)', () => {
    const h = harness({ focused: false })
    h.notifier.reportActive('w:a')
    h.notifier.onChunk('w:a', 'WANT')
    expect(h.notify).toHaveBeenCalledWith('w:a', 'done')
  })

  it('does not stack a second alert while one is still pending', () => {
    const h = harness()
    h.notifier.onChunk('w:a', 'WANT')
    h.notifier.onChunk('w:a', 'WANT again')
    expect(h.notify).toHaveBeenCalledTimes(1)
  })

  it('re-alerts when a pending idle session escalates to needing permission', () => {
    let kind: AttentionKind = 'idle'
    const h = harness({ detect: () => kind })
    h.notifier.onChunk('w:a', 'x')
    expect(h.notify).toHaveBeenLastCalledWith('w:a', 'done')
    kind = 'permission'
    h.notifier.onChunk('w:a', 'x')
    expect(h.notify).toHaveBeenCalledTimes(2)
    expect(h.notify).toHaveBeenLastCalledWith('w:a', 'waiting')
  })

  it('alerts again after the user acknowledges by viewing the session', () => {
    const h = harness()
    h.notifier.onChunk('w:a', 'WANT')
    h.notifier.reportActive('w:a') // user opens it -> acknowledged
    h.notifier.onChunk('w:a', 'WANT')
    expect(h.notify).toHaveBeenCalledTimes(2)
  })

  it('alerts again after the session exits and re-signals', () => {
    const h = harness()
    h.notifier.onChunk('w:a', 'WANT')
    h.notifier.forget('w:a') // pty exited
    h.notifier.onChunk('w:a', 'WANT')
    expect(h.notify).toHaveBeenCalledTimes(2)
  })

  describe('onInput', () => {
    it('broadcasts working and notifies once on the transition into working', () => {
      const h = harness()
      h.notifier.onInput('w:a')
      expect(h.broadcastStatus).toHaveBeenCalledWith('w:a', 'working')
      expect(h.notify).toHaveBeenCalledWith('w:a', 'working')
    })

    it('does not re-notify working for further prompts within the same turn', () => {
      const h = harness()
      h.notifier.onInput('w:a')
      h.notifier.onInput('w:a')
      expect(h.broadcastStatus).toHaveBeenCalledTimes(2)
      expect(h.notify).toHaveBeenCalledTimes(1)
    })

    it('suppresses the working notification when the user is viewing the session', () => {
      const h = harness({ focused: true })
      h.notifier.reportActive('w:a')
      h.notifier.onInput('w:a')
      expect(h.broadcastStatus).toHaveBeenCalledWith('w:a', 'working')
      expect(h.notify).not.toHaveBeenCalled()
    })

    it('notifies working again after a marker ended the previous turn', () => {
      const h = harness()
      h.notifier.onInput('w:a') // working (notified)
      h.notifier.onChunk('w:a', 'WANT') // done - turn over (notified)
      h.notifier.onInput('w:a') // a new turn starts working (notified)
      expect(h.notify).toHaveBeenCalledTimes(3)
      expect(h.notify).toHaveBeenLastCalledWith('w:a', 'working')
    })

    it('clears a stale pending alert so the same-kind marker can re-alert next turn', () => {
      const h = harness()
      h.notifier.onChunk('w:a', 'WANT') // done, now pending
      h.notifier.onInput('w:a') // user submits a new prompt - old alert is stale
      h.notifier.onChunk('w:a', 'WANT') // same kind as before, but should re-alert
      expect(h.notify.mock.calls.filter(([, s]) => s === 'done')).toHaveLength(2)
    })
  })
})
