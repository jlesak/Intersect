import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { oldestWaitingSession, projectStatus, useAttentionStore, workspaceStatus } from './store'

beforeEach(() => {
  useAttentionStore.setState({ status: {} }, false)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('attention store', () => {
  it('marks a session with a status stamped with the moment it entered it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    useAttentionStore.getState().mark('w1:a', 'working')
    expect(useAttentionStore.getState().status).toEqual({
      'w1:a': { status: 'working', since: 1_000 }
    })
  })

  // The core repeats a status for as long as the condition holds - a repeated 'waiting' must not
  // reset the clock, or a session neglected for minutes would keep looking freshly waiting.
  it('re-marking the status a session is already in keeps when it started waiting', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    useAttentionStore.getState().mark('w1:a', 'waiting')
    const before = useAttentionStore.getState().status
    vi.setSystemTime(5_000)
    useAttentionStore.getState().mark('w1:a', 'waiting')
    expect(useAttentionStore.getState().status).toEqual({
      'w1:a': { status: 'waiting', since: 1_000 }
    })
    // Identity too, so a repeated push wakes no subscriber.
    expect(useAttentionStore.getState().status).toBe(before)
  })

  it('restarts the clock when the status actually changes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    useAttentionStore.getState().mark('w1:a', 'working')
    vi.setSystemTime(5_000)
    useAttentionStore.getState().mark('w1:a', 'waiting')
    expect(useAttentionStore.getState().status).toEqual({
      'w1:a': { status: 'waiting', since: 5_000 }
    })
  })

  describe('acknowledge', () => {
    it('clears a waiting or done status', () => {
      useAttentionStore.getState().mark('w1:a', 'waiting')
      useAttentionStore.getState().acknowledge('w1:a')
      expect(useAttentionStore.getState().status).toEqual({})

      useAttentionStore.getState().mark('w1:a', 'done')
      useAttentionStore.getState().acknowledge('w1:a')
      expect(useAttentionStore.getState().status).toEqual({})
    })

    it('leaves a working status alone - viewing a session does not stop Claude working', () => {
      vi.useFakeTimers()
      vi.setSystemTime(1_000)
      useAttentionStore.getState().mark('w1:a', 'working')
      useAttentionStore.getState().acknowledge('w1:a')
      expect(useAttentionStore.getState().status).toEqual({
        'w1:a': { status: 'working', since: 1_000 }
      })
    })

    it('is a no-op that preserves object identity for an unmarked session', () => {
      const before = useAttentionStore.getState().status
      useAttentionStore.getState().acknowledge('nope')
      expect(useAttentionStore.getState().status).toBe(before)
    })
  })

  it('remove drops a status unconditionally, including working', () => {
    useAttentionStore.getState().mark('w1:a', 'working')
    useAttentionStore.getState().remove('w1:a')
    expect(useAttentionStore.getState().status).toEqual({})
  })

  it('clearWorkspace drops every session of that workspace only', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    useAttentionStore.getState().mark('w1:a', 'waiting')
    useAttentionStore.getState().mark('w1:b', 'working')
    useAttentionStore.getState().mark('w2:a', 'done')
    useAttentionStore.getState().clearWorkspace('w1')
    expect(useAttentionStore.getState().status).toEqual({
      'w2:a': { status: 'done', since: 1_000 }
    })
  })

  it('clearAll drops every session across workspaces', () => {
    useAttentionStore.getState().mark('w1:a', 'waiting')
    useAttentionStore.getState().mark('w2:a', 'working')
    useAttentionStore.getState().clearAll()
    expect(useAttentionStore.getState().status).toEqual({})
  })

  describe('workspaceStatus', () => {
    it('returns the single status when only one session is set', () => {
      useAttentionStore.getState().mark('w1:a', 'working')
      expect(workspaceStatus(useAttentionStore.getState().status, 'w1')).toBe('working')
    })

    it('returns undefined for a workspace with no sessions set, and never matches a prefix', () => {
      useAttentionStore.getState().mark('w1:a', 'working')
      const status = useAttentionStore.getState().status
      expect(workspaceStatus(status, 'w2')).toBeUndefined()
      // A workspace id that is a prefix of another must not match on the colon boundary.
      expect(workspaceStatus(status, 'w')).toBeUndefined()
    })

    it('picks the most urgent status: waiting > done > working', () => {
      useAttentionStore.getState().mark('w1:a', 'working')
      useAttentionStore.getState().mark('w1:b', 'done')
      expect(workspaceStatus(useAttentionStore.getState().status, 'w1')).toBe('done')
      useAttentionStore.getState().mark('w1:c', 'waiting')
      expect(workspaceStatus(useAttentionStore.getState().status, 'w1')).toBe('waiting')
    })
  })

  describe('projectStatus', () => {
    it('aggregates the most urgent status across the given workspaces only', () => {
      useAttentionStore.getState().mark('w1:a', 'working')
      useAttentionStore.getState().mark('w2:a', 'waiting')
      useAttentionStore.getState().mark('w3:a', 'done')
      const status = useAttentionStore.getState().status
      expect(projectStatus(status, ['w1', 'w2'])).toBe('waiting')
      expect(projectStatus(status, ['w1'])).toBe('working')
      expect(projectStatus(status, ['w4'])).toBeUndefined()
      expect(projectStatus(status, [])).toBeUndefined()
    })
  })

  describe('oldestWaitingSession', () => {
    it('returns undefined when nothing is waiting', () => {
      expect(oldestWaitingSession({})).toBeUndefined()
      vi.useFakeTimers()
      vi.setSystemTime(1_000)
      useAttentionStore.getState().mark('w1:a', 'working')
      useAttentionStore.getState().mark('w1:b', 'done')
      expect(oldestWaitingSession(useAttentionStore.getState().status)).toBeUndefined()
    })

    it('returns the session that entered waiting first, ignoring working and done', () => {
      vi.useFakeTimers()
      vi.setSystemTime(1_000)
      useAttentionStore.getState().mark('w1:a', 'working')
      vi.setSystemTime(2_000)
      useAttentionStore.getState().mark('w1:b', 'waiting')
      vi.setSystemTime(3_000)
      useAttentionStore.getState().mark('w2:a', 'waiting')
      vi.setSystemTime(4_000)
      useAttentionStore.getState().mark('w2:b', 'done')
      expect(oldestWaitingSession(useAttentionStore.getState().status)).toBe('w1:b')
    })

    it('ignores insertion order - a session re-marked last can still be the oldest waiting', () => {
      vi.useFakeTimers()
      vi.setSystemTime(1_000)
      useAttentionStore.getState().mark('w1:a', 'waiting')
      vi.setSystemTime(2_000)
      useAttentionStore.getState().mark('w1:b', 'waiting')
      vi.setSystemTime(3_000)
      useAttentionStore.getState().mark('w1:b', 'waiting')
      expect(oldestWaitingSession(useAttentionStore.getState().status)).toBe('w1:a')
    })

    it('keeps a repeatedly-signalled session at the front of the queue', () => {
      vi.useFakeTimers()
      vi.setSystemTime(1_000)
      useAttentionStore.getState().mark('w1:a', 'waiting')
      vi.setSystemTime(2_000)
      useAttentionStore.getState().mark('w1:b', 'waiting')
      vi.setSystemTime(3_000)
      useAttentionStore.getState().mark('w1:a', 'waiting')
      expect(oldestWaitingSession(useAttentionStore.getState().status)).toBe('w1:a')
    })

    // Leaving 'waiting' and coming back is a new episode, so seniority is genuinely lost.
    it('a session that leaves waiting and returns starts a new wait', () => {
      vi.useFakeTimers()
      vi.setSystemTime(1_000)
      useAttentionStore.getState().mark('w1:a', 'waiting')
      vi.setSystemTime(2_000)
      useAttentionStore.getState().mark('w1:b', 'waiting')
      vi.setSystemTime(3_000)
      useAttentionStore.getState().mark('w1:a', 'working')
      vi.setSystemTime(4_000)
      useAttentionStore.getState().mark('w1:a', 'waiting')
      expect(oldestWaitingSession(useAttentionStore.getState().status)).toBe('w1:b')
    })

    it('breaks a tie on the lowest session id so the pick is deterministic', () => {
      const status = {
        'w2:a': { status: 'waiting', since: 1_000 },
        'w1:a': { status: 'waiting', since: 1_000 }
      } as const
      expect(oldestWaitingSession(status)).toBe('w1:a')
    })
  })
})
