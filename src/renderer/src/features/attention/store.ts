import { create } from 'zustand'
import type { SessionStatus } from '@common/ipc'

/**
 * Each Claude Code session's current status, keyed by the full `${workspaceId}:${tabId}` session
 * id so it survives switching workspaces (a background workspace can still show its status). No
 * entry means neutral (a shell tab, or a Claude tab that hasn't sent its first prompt yet). This is
 * renderer-only UI state; it is never persisted.
 */
interface AttentionState {
  status: Record<string, SessionStatus>
  mark(sessionId: string, status: SessionStatus): void
  /**
   * The user viewed this session: clear its status, UNLESS it is 'working' - viewing a session
   * does not stop Claude from working, so that status is left alone until the next real signal.
   */
  acknowledge(sessionId: string): void
  /** Drop a session's status unconditionally (its tab/PTY is gone). */
  remove(sessionId: string): void
  /** Drop every session of a workspace (when the workspace and its tabs are removed). */
  clearWorkspace(workspaceId: string): void
  /** Drop everything (a core restart invalidated every status; the new core re-pushes truth). */
  clearAll(): void
}

export const useAttentionStore = create<AttentionState>()((set) => ({
  status: {},

  mark(sessionId, status) {
    set((s) => (s.status[sessionId] === status ? s : { status: { ...s.status, [sessionId]: status } }))
  },

  acknowledge(sessionId) {
    set((s) => {
      if (s.status[sessionId] === undefined || s.status[sessionId] === 'working') return s
      const next = { ...s.status }
      delete next[sessionId]
      return { status: next }
    })
  },

  remove(sessionId) {
    set((s) => {
      if (!(sessionId in s.status)) return s
      const next = { ...s.status }
      delete next[sessionId]
      return { status: next }
    })
  },

  clearWorkspace(workspaceId) {
    set((s) => {
      const prefix = `${workspaceId}:`
      const ids = Object.keys(s.status).filter((id) => id.startsWith(prefix))
      if (ids.length === 0) return s
      const next = { ...s.status }
      for (const id of ids) delete next[id]
      return { status: next }
    })
  },

  clearAll() {
    set((s) => (Object.keys(s.status).length === 0 ? s : { status: {} }))
  }
}))

/** Priority when a workspace has multiple sessions in different states: the most urgent wins. */
const STATUS_PRIORITY: Record<SessionStatus, number> = { waiting: 3, done: 2, working: 1 }

/** The most urgent status among a workspace's sessions, or undefined if all are neutral. */
export function workspaceStatus(
  status: Record<string, SessionStatus>,
  workspaceId: string
): SessionStatus | undefined {
  const prefix = `${workspaceId}:`
  let best: SessionStatus | undefined
  for (const [id, s] of Object.entries(status)) {
    if (!id.startsWith(prefix)) continue
    if (!best || STATUS_PRIORITY[s] > STATUS_PRIORITY[best]) best = s
  }
  return best
}

/**
 * The most urgent status across a set of workspaces (a project's), or undefined if all are
 * neutral. Drives the rail pin's aggregated session-status dot; it defines no filtering.
 */
export function projectStatus(
  status: Record<string, SessionStatus>,
  workspaceIds: string[]
): SessionStatus | undefined {
  let best: SessionStatus | undefined
  for (const id of workspaceIds) {
    const s = workspaceStatus(status, id)
    if (s && (!best || STATUS_PRIORITY[s] > STATUS_PRIORITY[best])) best = s
  }
  return best
}
