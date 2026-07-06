import { beforeEach, describe, expect, it } from 'vitest'
import { useAttentionStore, workspaceStatus } from './store'

beforeEach(() => {
  useAttentionStore.setState({ status: {} })
})

describe('attention store', () => {
  it('marks a session with a status', () => {
    useAttentionStore.getState().mark('w1:a', 'working')
    expect(useAttentionStore.getState().status).toEqual({ 'w1:a': 'working' })
  })

  it('marking the same status again preserves object identity (no needless re-render)', () => {
    useAttentionStore.getState().mark('w1:a', 'done')
    const before = useAttentionStore.getState().status
    useAttentionStore.getState().mark('w1:a', 'done')
    expect(useAttentionStore.getState().status).toBe(before)
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
      useAttentionStore.getState().mark('w1:a', 'working')
      useAttentionStore.getState().acknowledge('w1:a')
      expect(useAttentionStore.getState().status).toEqual({ 'w1:a': 'working' })
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
    useAttentionStore.getState().mark('w1:a', 'waiting')
    useAttentionStore.getState().mark('w1:b', 'working')
    useAttentionStore.getState().mark('w2:a', 'done')
    useAttentionStore.getState().clearWorkspace('w1')
    expect(useAttentionStore.getState().status).toEqual({ 'w2:a': 'done' })
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
})
