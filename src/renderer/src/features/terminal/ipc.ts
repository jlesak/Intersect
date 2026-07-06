import type { Preset } from '@common/domain'
import type {
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalNotificationClickEvent,
  TerminalSessionStatusEvent
} from '@common/ipc'
import { ipc } from '@renderer/shared/ipc/client'

// Thin wrappers over the terminal IPC surface. The controller is the only consumer.
export const spawn = (
  sessionId: string,
  preset: Preset,
  cwd: string,
  cols: number,
  rows: number,
  resumeSessionId?: string | null
): Promise<{ ok: boolean }> => ipc().terminal.spawn(sessionId, preset, cwd, cols, rows, resumeSessionId)
export const write = (sessionId: string, data: string): void => ipc().terminal.write(sessionId, data)
export const resize = (sessionId: string, cols: number, rows: number): void =>
  ipc().terminal.resize(sessionId, cols, rows)
export const pause = (sessionId: string): void => ipc().terminal.pause(sessionId)
export const resume = (sessionId: string): void => ipc().terminal.resume(sessionId)
export const kill = (sessionId: string): void => ipc().terminal.kill(sessionId)
export const onData = (cb: (e: TerminalDataEvent) => void): (() => void) => ipc().terminal.onData(cb)
export const onExit = (cb: (e: TerminalExitEvent) => void): (() => void) => ipc().terminal.onExit(cb)
export const reportActiveSession = (sessionId: string | null): void =>
  ipc().terminal.reportActiveSession(sessionId)
export const onSessionStatus = (cb: (e: TerminalSessionStatusEvent) => void): (() => void) =>
  ipc().terminal.onSessionStatus(cb)
export const onNotificationClicked = (cb: (e: TerminalNotificationClickEvent) => void): (() => void) =>
  ipc().terminal.onNotificationClicked(cb)
