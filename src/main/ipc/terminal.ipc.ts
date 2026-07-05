import type { IpcMain, WebContents } from 'electron'
import type { Preset } from '@common/domain'
import { Channel, type TerminalDataEvent, type TerminalExitEvent } from '@common/ipc'
import type { SessionManager } from '../pty/sessionManager'

/** Main-side terminal surface: the request/response + fire-and-forget methods (no events). */
export interface TerminalHandlers {
  spawn(sessionId: string, preset: Preset, cwd: string, cols: number, rows: number): { ok: boolean }
  write(sessionId: string, data: string): void
  resize(sessionId: string, cols: number, rows: number): void
  pause(sessionId: string): void
  resume(sessionId: string): void
  kill(sessionId: string): void
}

export function createTerminalHandlers(sessions: SessionManager): TerminalHandlers {
  return {
    spawn: (id, preset, cwd, cols, rows) => sessions.spawn(id, preset, cwd, cols, rows),
    write: (id, data) => sessions.write(id, data),
    resize: (id, cols, rows) => sessions.resize(id, cols, rows),
    pause: (id) => sessions.pause(id),
    resume: (id) => sessions.resume(id),
    kill: (id) => sessions.kill(id)
  }
}

export function registerTerminalHandlers(ipcMain: IpcMain, h: TerminalHandlers): void {
  ipcMain.handle(
    Channel.terminalSpawn,
    (_e, id: string, preset: Preset, cwd: string, cols: number, rows: number) =>
      h.spawn(id, preset, cwd, cols, rows)
  )
  ipcMain.on(Channel.terminalInput, (_e, id: string, data: string) => h.write(id, data))
  ipcMain.on(Channel.terminalResize, (_e, id: string, cols: number, rows: number) =>
    h.resize(id, cols, rows)
  )
  ipcMain.on(Channel.terminalPause, (_e, id: string) => h.pause(id))
  ipcMain.on(Channel.terminalResume, (_e, id: string) => h.resume(id))
  ipcMain.on(Channel.terminalKill, (_e, id: string) => h.kill(id))
}

/** The `send` object the session manager uses to broadcast PTY output/exit to the window. */
export function createSender(getWebContents: () => WebContents | null): {
  data(event: TerminalDataEvent): void
  exit(event: TerminalExitEvent): void
} {
  return {
    data: (event) => getWebContents()?.send(Channel.terminalData, event),
    exit: (event) => getWebContents()?.send(Channel.terminalExit, event)
  }
}
