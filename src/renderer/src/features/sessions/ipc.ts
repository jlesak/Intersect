import type { SessionSummary, SessionTranscript } from '@common/domain'
import { ipc } from '@renderer/shared/ipc/client'

// Thin, mockable seam between the sessions store and the preload bridge.
export const list = (): Promise<SessionSummary[]> => ipc().sessions.list()
export const refresh = (): Promise<SessionSummary[]> => ipc().sessions.refresh()
export const getTranscript = (id: string): Promise<SessionTranscript> =>
  ipc().sessions.getTranscript(id)
