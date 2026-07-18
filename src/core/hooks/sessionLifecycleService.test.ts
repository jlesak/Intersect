import { describe, expect, it, vi } from 'vitest'
import { createSessionLifecycleService } from './sessionLifecycleService'

const SID = 'ws1:tab1'
const CWD = '/Users/me/project'

function harness() {
  const appendRawEvent = vi.fn()
  const storeClaudeSessionId = vi.fn()
  const alert = vi.fn()
  const markWorking = vi.fn()
  const log = vi.fn()
  const service = createSessionLifecycleService({
    appendRawEvent,
    storeClaudeSessionId,
    alert,
    markWorking,
    log
  })
  return { service, appendRawEvent, storeClaudeSessionId, alert, markWorking, log }
}

/** A spawned session that already completed its SessionStart handshake. */
function startedHarness() {
  const h = harness()
  h.service.onSpawn(SID, CWD)
  h.service.onHookEvent('SessionStart', { session_id: 'uuid-1', cwd: CWD }, SID)
  return h
}

describe('sessionLifecycleService', () => {
  describe('instance routing and guards', () => {
    it('persists every event raw before any guard, keyed by the instance id', () => {
      const h = harness()
      h.service.onHookEvent('Stop', { cwd: '/anywhere' }, 'unknown:instance')
      expect(h.appendRawEvent).toHaveBeenCalledWith('unknown:instance', 'Stop', {
        cwd: '/anywhere'
      })
    })

    it('an event for an unmanaged instance never alerts or stores anything', () => {
      const h = harness()
      h.service.onHookEvent('SessionStart', { session_id: 'x', cwd: CWD }, 'unknown:instance')
      expect(h.storeClaudeSessionId).not.toHaveBeenCalled()
      expect(h.alert).not.toHaveBeenCalled()
      expect(h.markWorking).not.toHaveBeenCalled()
    })

    it('a nested different-cwd SessionStart cannot overwrite the parent resume id or state', () => {
      const h = startedHarness()
      h.storeClaudeSessionId.mockClear()
      h.service.onHookEvent('SessionStart', { session_id: 'foreign', cwd: '/private/tmp' }, SID)
      expect(h.storeClaudeSessionId).not.toHaveBeenCalled()
      // The event survived as a diagnostic.
      expect(h.appendRawEvent).toHaveBeenCalledWith(SID, 'SessionStart', {
        session_id: 'foreign',
        cwd: '/private/tmp'
      })
    })

    it('a nested different-cwd Stop cannot alert the parent', () => {
      const h = startedHarness()
      h.service.onHookEvent('Stop', { cwd: '/private/tmp' }, SID)
      expect(h.alert).not.toHaveBeenCalled()
    })

    it('a non-JSON (truncated) payload is diagnostic-only', () => {
      const h = startedHarness()
      h.service.onHookEvent('Stop', '{"trunca', SID)
      expect(h.alert).not.toHaveBeenCalled()
      expect(h.appendRawEvent).toHaveBeenCalledWith(SID, 'Stop', '{"trunca')
    })

    it('an event with no cwd field is trusted (back-compat) and drives state', () => {
      const h = startedHarness()
      h.service.onHookEvent('Stop', {}, SID)
      expect(h.alert).toHaveBeenCalledWith(SID, 'done')
    })
  })

  describe('hook health', () => {
    it('is unhealthy before spawn and after spawn until a cwd-valid event arrives', () => {
      const h = harness()
      expect(h.service.isHookHealthy(SID)).toBe(false)
      h.service.onSpawn(SID, CWD)
      expect(h.service.isHookHealthy(SID)).toBe(false)
    })

    it('turns healthy on the first cwd-valid event', () => {
      const h = startedHarness()
      expect(h.service.isHookHealthy(SID)).toBe(true)
    })

    it('a nested different-cwd event does not make the session healthy', () => {
      const h = harness()
      h.service.onSpawn(SID, CWD)
      h.service.onHookEvent('Stop', { cwd: '/private/tmp' }, SID)
      expect(h.service.isHookHealthy(SID)).toBe(false)
    })

    it('a repeated spawn for a live session (renderer remount) does not reset tracking', () => {
      const h = startedHarness()
      h.service.onSpawn(SID, CWD)
      expect(h.service.isHookHealthy(SID)).toBe(true)
    })

    it('health resets when the PTY exits and the session respawns', () => {
      const h = startedHarness()
      h.service.onPtyExit(SID, 0)
      expect(h.service.isHookHealthy(SID)).toBe(false)
      h.service.onSpawn(SID, CWD)
      expect(h.service.isHookHealthy(SID)).toBe(false)
    })
  })

  describe('state driving', () => {
    it('SessionStart stores the claude session UUID without raising any attention', () => {
      const h = harness()
      h.service.onSpawn(SID, CWD)
      h.service.onHookEvent('SessionStart', { session_id: 'uuid-1', cwd: CWD }, SID)
      expect(h.storeClaudeSessionId).toHaveBeenCalledWith(SID, 'uuid-1')
      expect(h.alert).not.toHaveBeenCalled()
      expect(h.markWorking).not.toHaveBeenCalled()
    })

    it('a mid-life SessionStart (post-/clear rollover) re-captures the new UUID', () => {
      const h = startedHarness()
      h.service.onHookEvent('SessionStart', { session_id: 'uuid-2', cwd: CWD }, SID)
      expect(h.storeClaudeSessionId).toHaveBeenLastCalledWith(SID, 'uuid-2')
    })

    it('SessionStart without a session_id stores nothing', () => {
      const h = harness()
      h.service.onSpawn(SID, CWD)
      h.service.onHookEvent('SessionStart', { cwd: CWD }, SID)
      expect(h.storeClaudeSessionId).not.toHaveBeenCalled()
    })

    it('NotificationPermission alerts waiting with the message and a conservative risk', () => {
      const h = startedHarness()
      h.service.onHookEvent(
        'NotificationPermission',
        { cwd: CWD, message: 'Claude needs your permission to use Bash' },
        SID
      )
      expect(h.alert).toHaveBeenCalledWith(
        SID,
        'waiting',
        'Claude needs your permission to use Bash',
        'unknown'
      )
    })

    it('classifies the permission risk from the most recent cwd-valid PreToolUse', () => {
      const h = startedHarness()
      h.service.onHookEvent(
        'PreToolUse',
        { cwd: CWD, tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/x' } },
        SID
      )
      h.service.onHookEvent('NotificationPermission', { cwd: CWD, message: 'perm?' }, SID)
      expect(h.alert).toHaveBeenCalledWith(SID, 'waiting', 'perm?', 'dangerous')
    })

    it('a nested different-cwd PreToolUse cannot influence the risk classification', () => {
      const h = startedHarness()
      h.service.onHookEvent(
        'PreToolUse',
        { cwd: '/private/tmp', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } },
        SID
      )
      h.service.onHookEvent(
        'PreToolUse',
        { cwd: CWD, tool_name: 'Read', tool_input: { file_path: '/x' } },
        SID
      )
      h.service.onHookEvent('NotificationPermission', { cwd: CWD }, SID)
      expect(h.alert).toHaveBeenCalledWith(SID, 'waiting', undefined, 'ordinary')
    })

    it('Stop alerts done', () => {
      const h = startedHarness()
      h.service.onHookEvent('Stop', { cwd: CWD }, SID)
      expect(h.alert).toHaveBeenCalledWith(SID, 'done')
    })

    it('Stop while waiting for permission is a no-op (permission trumps input)', () => {
      const h = startedHarness()
      h.service.onHookEvent('NotificationPermission', { cwd: CWD, message: 'perm?' }, SID)
      h.alert.mockClear()
      h.service.onHookEvent('Stop', { cwd: CWD }, SID)
      expect(h.alert).not.toHaveBeenCalled()
    })

    it('NotificationIdle alerts done but never downgrades a pending permission', () => {
      const h = startedHarness()
      h.service.onHookEvent('NotificationIdle', { cwd: CWD, message: 'idle' }, SID)
      expect(h.alert).toHaveBeenCalledWith(SID, 'done', 'idle')
      h.alert.mockClear()
      h.service.onHookEvent('NotificationPermission', { cwd: CWD }, SID)
      h.alert.mockClear()
      h.service.onHookEvent('NotificationIdle', { cwd: CWD, message: 'idle' }, SID)
      expect(h.alert).not.toHaveBeenCalled()
    })

    it('UserPromptSubmit marks the session working and drops the stale PreToolUse', () => {
      const h = startedHarness()
      h.service.onHookEvent(
        'PreToolUse',
        { cwd: CWD, tool_name: 'Bash', tool_input: { command: 'sudo rm -rf /' } },
        SID
      )
      h.service.onHookEvent('UserPromptSubmit', { cwd: CWD }, SID)
      expect(h.markWorking).toHaveBeenCalledWith(SID)
      // A permission in the new turn without a fresh PreToolUse must not reuse last turn's.
      h.service.onHookEvent('NotificationPermission', { cwd: CWD }, SID)
      expect(h.alert).toHaveBeenCalledWith(SID, 'waiting', undefined, 'unknown')
    })

    it('SessionEnd changes nothing (fires on /clear and /compact, not just real exits)', () => {
      const h = startedHarness()
      h.service.onHookEvent('SessionEnd', { cwd: CWD }, SID)
      expect(h.alert).not.toHaveBeenCalled()
      expect(h.markWorking).not.toHaveBeenCalled()
      // The session is still live and reacts normally afterwards.
      h.service.onHookEvent('Stop', { cwd: CWD }, SID)
      expect(h.alert).toHaveBeenCalledWith(SID, 'done')
    })

    it('the local Enter wakes a waiting-permission session so the next Stop lands', () => {
      const h = startedHarness()
      h.service.onHookEvent('NotificationPermission', { cwd: CWD, message: 'perm?' }, SID)
      h.alert.mockClear()
      // Without this, Stop would stay a no-op forever after an approved permission.
      h.service.onUserInput(SID)
      h.service.onHookEvent('Stop', { cwd: CWD }, SID)
      expect(h.alert).toHaveBeenCalledWith(SID, 'done')
    })

    it('onUserInput for an untracked session is a safe no-op', () => {
      const h = harness()
      expect(() => h.service.onUserInput('nope:x')).not.toThrow()
    })
  })

  describe('pty exit', () => {
    it('is authoritative: hook events after exit are diagnostic-only', () => {
      const h = startedHarness()
      h.service.onPtyExit(SID, 0)
      h.alert.mockClear()
      h.storeClaudeSessionId.mockClear()
      h.service.onHookEvent('Stop', { cwd: CWD }, SID)
      h.service.onHookEvent('SessionStart', { session_id: 'late', cwd: CWD }, SID)
      expect(h.alert).not.toHaveBeenCalled()
      expect(h.storeClaudeSessionId).not.toHaveBeenCalled()
    })

    it('logs finished for exit 0 and crashed for a nonzero exit', () => {
      const h = startedHarness()
      h.service.onPtyExit(SID, 0)
      expect(h.log.mock.calls.some(([m]) => m.includes('-> finished'))).toBe(true)

      const h2 = startedHarness()
      h2.service.onPtyExit(SID, 137)
      expect(h2.log.mock.calls.some(([m]) => m.includes('-> crashed'))).toBe(true)
    })

    it('exit for an untracked session is a safe no-op', () => {
      const h = harness()
      expect(() => h.service.onPtyExit('nope:x', 1)).not.toThrow()
    })
  })
})
