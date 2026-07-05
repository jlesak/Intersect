import type { DatabaseSync } from 'node:sqlite'
import { createAppStateRepo, type AppStateRepo } from '../db/appStateRepo'
import { createTabRepo, type TabRepo } from '../db/tabRepo'
import { createWorkspaceRepo, type WorkspaceRepo } from '../db/workspaceRepo'
import { makeTestDb, makeTestDeps } from '../db/testkit'
import type { SessionManager } from '../pty/sessionManager'

export interface FakeSessions {
  sessions: SessionManager
  calls: {
    spawn: string[]
    kill: string[]
    killWorkspace: string[]
    killAll: number
  }
}

/** A SessionManager that records what it was asked to do, for handler tests. */
export function makeFakeSessions(): FakeSessions {
  const calls = { spawn: [] as string[], kill: [] as string[], killWorkspace: [] as string[], killAll: 0 }
  const sessions: SessionManager = {
    spawn: (id) => {
      calls.spawn.push(id)
      return { ok: true }
    },
    write: () => {},
    resize: () => {},
    pause: () => {},
    resume: () => {},
    kill: (id) => {
      calls.kill.push(id)
    },
    killWorkspace: (id) => {
      calls.killWorkspace.push(id)
    },
    killAll: () => {
      calls.killAll += 1
    }
  }
  return { sessions, calls }
}

export interface HandlerContext extends FakeSessions {
  db: DatabaseSync
  workspaces: WorkspaceRepo
  tabs: TabRepo
  appState: AppStateRepo
}

/** Real repos over an in-memory DB + a recording session manager. */
export function makeHandlerContext(): HandlerContext {
  const db = makeTestDb()
  const deps = makeTestDeps()
  return {
    db,
    workspaces: createWorkspaceRepo(db, deps),
    tabs: createTabRepo(db, deps),
    appState: createAppStateRepo(db),
    ...makeFakeSessions()
  }
}
