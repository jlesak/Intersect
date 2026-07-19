import { create } from 'zustand'
import type { AgentRuntimeDay } from '@common/domain'
import * as api from './agentRuntimeIpc'

/**
 * The agent-runtime supporting figures for the shown week, keyed by local day. This is read-only
 * context that sits alongside the worklog board - never a worklog itself - so the store is a thin
 * loader with no mutations. A response for a week the user has since navigated away from is
 * dropped, mirroring the time-tracking store.
 */
interface AgentRuntimeState {
  weekStart: string | null
  byDay: Record<string, AgentRuntimeDay>
  /** Load (or reload) the given week's per-day agent runtime; failures degrade to no figures. */
  loadWeek(weekStart: string): Promise<void>
  /** Trigger a full core-side recompute, then reload the shown week's figures. */
  refresh(): Promise<void>
}

function index(days: AgentRuntimeDay[]): Record<string, AgentRuntimeDay> {
  const byDay: Record<string, AgentRuntimeDay> = {}
  for (const day of days) byDay[day.localDate] = day
  return byDay
}

export const useAgentRuntimeStore = create<AgentRuntimeState>()((set, get) => ({
  weekStart: null,
  byDay: {},

  async loadWeek(weekStart) {
    set({ weekStart })
    try {
      const days = await api.getWeek(weekStart)
      if (get().weekStart !== weekStart) return
      set({ byDay: index(days) })
    } catch {
      // Supporting context only: a failure shows no runtime figures rather than an error surface.
      if (get().weekStart !== weekStart) return
      set({ byDay: {} })
    }
  },

  async refresh() {
    const weekStart = get().weekStart
    try {
      await api.refresh()
    } catch {
      // A failed recompute keeps the last-shown figures rather than surfacing an error.
    }
    if (weekStart) await get().loadWeek(weekStart)
  }
}))
