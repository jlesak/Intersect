import type { AgentRuntimeDay } from '@common/domain'
import { ipc } from '@renderer/shared/ipc/client'

// Thin, mockable seam between the agent-runtime store and the preload bridge.
export const getWeek = (weekStart: string): Promise<AgentRuntimeDay[]> =>
  ipc().agentRuntime.getWeek(weekStart)
export const refresh = (): Promise<void> => ipc().agentRuntime.refresh()
