import { describe, it, expect, vi } from 'vitest'
import type { AttentionAlert } from './pty/attentionDetector'
import type { AttentionKind } from './pty/attentionMarkers'
import { createSessionNotifier, type SessionNotifierDeps } from './sessionNotifier'

/** Build a notifier with spy collaborators and a scripted detector. */
function harness(
  opts: { focused?: boolean; detect?: (chunk: string) => AttentionAlert | null } = {}
) {
  const notify = vi.fn()
  const broadcastStatus = vi.fn()
  const onPendingChanged = vi.fn()
  let focused = opts.focused ?? false
  const detect = opts.detect ?? ((chunk: string) => (chunk.includes('WANT') ? { kind: 'idle' as AttentionKind } : null))
  const deps: SessionNotifierDeps = {
    detect: (_sessionId, chunk) => detect(chunk),
    notify,
    broadcastStatus,
    isWindowFocused: () => focused,
    onPendingChanged
  }
  const notifier = createSessionNotifier(deps)
  return { notifier, notify, broadcastStatus, onPendingChanged, setFocused: (f: boolean) => (focused = f) }
}

describe('sessionNotifier', () => {
  it('alerts (notify + broadcast) with the mapped status when a chunk signals attention', () => {
    const h = harness()
    h.notifier.onChunk('w:a', 'please WANT input')
    expect(h.notify).toHaveBeenCalledWith('w:a', 'done', undefined)
    expect(h.broadcastStatus).toHaveBeenCalledWith('w:a', 'done')
  })

  it('maps a permission marker to the waiting status', () => {
    const h = harness({ detect: () => ({ kind: 'permission' }) })
    h.notifier.onChunk('w:a', 'x')
    expect(h.notify).toHaveBeenCalledWith('w:a', 'waiting', undefined)
    expect(h.broadcastStatus).toHaveBeenCalledWith('w:a', 'waiting')
  })

  it('maps a stop marker to the done status', () => {
    const h = harness({ detect: () => ({ kind: 'stop' }) })
    h.notifier.onChunk('w:a', 'x')
    expect(h.notify).toHaveBeenCalledWith('w:a', 'done', undefined)
    expect(h.broadcastStatus).toHaveBeenCalledWith('w:a', 'done')
  })

  it('carries Claude\'s own message through to notify', () => {
    const h = harness({ detect: () => ({ kind: 'permission', message: 'Claude needs your permission to use Bash' }) })
    h.notifier.onChunk('w:a', 'x')
    expect(h.notify).toHaveBeenCalledWith('w:a', 'waiting', 'Claude needs your permission to use Bash')
  })

  it('does nothing for chunks with no marker', () => {
    const h = harness()
    h.notifier.onChunk('w:a', 'ordinary output')
    expect(h.notify).not.toHaveBeenCalled()
    expect(h.broadcastStatus).not.toHaveBeenCalled()
  })

  it('broadcasts status but suppresses notify when the window is focused on the active session', () => {
    const h = harness({ focused: true })
    h.notifier.reportActive('w:a')
    h.notifier.onChunk('w:a', 'WANT')
    expect(h.notify).not.toHaveBeenCalled()
    expect(h.broadcastStatus).toHaveBeenCalledWith('w:a', 'done')
    expect(h.onPendingChanged).not.toHaveBeenCalled()
  })

  it('a stop watched by the user, then the idle_prompt backstop for it, neither notifies nor changes the pending count', () => {
    let kind: AttentionKind = 'stop'
    const h = harness({ focused: true, detect: () => ({ kind }) })
    h.notifier.reportActive('w:a')
    h.notifier.onChunk('w:a', 'x') // Stop fires while the user is watching - repainted, acknowledged
    expect(h.broadcastStatus).toHaveBeenCalledWith('w:a', 'done')
    expect(h.notify).not.toHaveBeenCalled()
    h.onPendingChanged.mockClear()
    kind = 'idle'
    h.notifier.onChunk('w:a', 'x') // idle_prompt backstop ~60s later, same resulting status
    expect(h.notify).not.toHaveBeenCalled()
    expect(h.onPendingChanged).not.toHaveBeenCalled()
  })

  it('still alerts a focused window when a different session signals', () => {
    const h = harness({ focused: true })
    h.notifier.reportActive('w:a')
    h.notifier.onChunk('w:b', 'WANT')
    expect(h.notify).toHaveBeenCalledWith('w:b', 'done', undefined)
  })

  it('alerts a background session even when its tab is the active one (window not focused)', () => {
    const h = harness({ focused: false })
    h.notifier.reportActive('w:a')
    h.notifier.onChunk('w:a', 'WANT')
    expect(h.notify).toHaveBeenCalledWith('w:a', 'done', undefined)
  })

  it('does not stack a second alert while one is still pending', () => {
    const h = harness()
    h.notifier.onChunk('w:a', 'WANT')
    h.notifier.onChunk('w:a', 'WANT again')
    expect(h.notify).toHaveBeenCalledTimes(1)
  })

  it('dedups a stop alert followed by an idle alert for the same idle period (same status)', () => {
    let kind: AttentionKind = 'stop'
    const h = harness({ detect: () => ({ kind }) })
    h.notifier.onChunk('w:a', 'x') // Stop fires immediately at turn end
    expect(h.notify).toHaveBeenCalledTimes(1)
    kind = 'idle'
    h.notifier.onChunk('w:a', 'x') // idle_prompt fires ~60s later for the same idle period
    expect(h.notify).toHaveBeenCalledTimes(1) // both map to 'done' - no second alert
  })

  it('re-alerts when a pending idle session escalates to needing permission', () => {
    let kind: AttentionKind = 'idle'
    const h = harness({ detect: () => ({ kind }) })
    h.notifier.onChunk('w:a', 'x')
    expect(h.notify).toHaveBeenLastCalledWith('w:a', 'done', undefined)
    kind = 'permission'
    h.notifier.onChunk('w:a', 'x')
    expect(h.notify).toHaveBeenCalledTimes(2)
    expect(h.notify).toHaveBeenLastCalledWith('w:a', 'waiting', undefined)
  })

  it('reportActive acknowledges a pending alert, so a same-status backstop after it does not re-alert', () => {
    const h = harness() // window not focused, so the alert goes pending rather than acked directly
    h.notifier.onChunk('w:a', 'WANT') // idle -> done, pending, notified once
    expect(h.notify).toHaveBeenCalledTimes(1)
    h.notifier.reportActive('w:a') // user opens it - moves the pending 'done' into acked
    expect(h.onPendingChanged).toHaveBeenLastCalledWith(0)
    h.notifier.onChunk('w:a', 'WANT') // idle_prompt backstop for the same status
    expect(h.notify).toHaveBeenCalledTimes(1) // still just the one notify
  })

  it('alerts again once a new turn starts after the user acknowledged the previous one', () => {
    const h = harness()
    h.notifier.onChunk('w:a', 'WANT') // done, pending, notified once
    h.notifier.reportActive('w:a') // user opens it -> acknowledged
    h.notifier.onInput('w:a') // a new turn starts - clears the acked record too
    h.notifier.onChunk('w:a', 'WANT') // this turn's own stop/idle marker
    expect(h.notify.mock.calls.filter(([, s]) => s === 'done')).toHaveLength(2)
  })

  it('alerts again for a new turn even when the previous turn was only watched (acked), not pending', () => {
    const kind: AttentionKind = 'stop'
    const h = harness({ focused: true, detect: () => ({ kind }) })
    h.notifier.reportActive('w:a')
    h.notifier.onChunk('w:a', 'x') // watched stop - acked, not pending
    expect(h.notify).not.toHaveBeenCalled()
    h.notifier.onInput('w:a') // user starts a new turn - clears the acked record
    h.setFocused(false) // this turn is not being watched
    h.notifier.onChunk('w:a', 'x') // this turn's own stop marker
    expect(h.notify).toHaveBeenCalledWith('w:a', 'done', undefined)
  })

  it('still escalates from an acked done to a waiting alert', () => {
    let kind: AttentionKind = 'stop'
    const h = harness({ focused: true, detect: () => ({ kind }) })
    h.notifier.reportActive('w:a')
    h.notifier.onChunk('w:a', 'x') // watched stop - acked as 'done', not notified
    expect(h.notify).not.toHaveBeenCalled()
    h.setFocused(false) // user looked away before the session escalates
    kind = 'permission'
    h.notifier.onChunk('w:a', 'x') // escalates to 'waiting' - differs from the acked status
    expect(h.notify).toHaveBeenCalledWith('w:a', 'waiting', undefined)
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

  describe('onPendingChanged', () => {
    it('reports the count growing as unacknowledged alerts pile up across sessions', () => {
      const h = harness()
      h.notifier.onChunk('w:a', 'WANT')
      expect(h.onPendingChanged).toHaveBeenLastCalledWith(1)
      h.notifier.onChunk('w:b', 'WANT')
      expect(h.onPendingChanged).toHaveBeenLastCalledWith(2)
    })

    it('does not grow the count for a repeat alert of the same status (already pending)', () => {
      const h = harness()
      h.notifier.onChunk('w:a', 'WANT')
      h.onPendingChanged.mockClear()
      h.notifier.onChunk('w:a', 'WANT again')
      expect(h.onPendingChanged).not.toHaveBeenCalled()
    })

    it('reports the count dropping when an alert is acknowledged via reportActive', () => {
      const h = harness()
      h.notifier.onChunk('w:a', 'WANT')
      h.notifier.reportActive('w:a')
      expect(h.onPendingChanged).toHaveBeenLastCalledWith(0)
    })

    it('reports the count dropping when an alert is acknowledged via onInput', () => {
      const h = harness()
      h.notifier.onChunk('w:a', 'WANT')
      h.notifier.onInput('w:a')
      expect(h.onPendingChanged).toHaveBeenLastCalledWith(0)
    })

    it('reports the count dropping when a session is forgotten (pty exit)', () => {
      const h = harness()
      h.notifier.onChunk('w:a', 'WANT')
      h.notifier.forget('w:a')
      expect(h.onPendingChanged).toHaveBeenLastCalledWith(0)
    })

    it('does not fire for a session with no pending alert', () => {
      const h = harness()
      h.notifier.onInput('w:a') // never alerted - nothing to acknowledge
      h.notifier.reportActive('b')
      h.notifier.forget('c')
      expect(h.onPendingChanged).not.toHaveBeenCalled()
    })
  })
})
