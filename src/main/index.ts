import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import { Channel } from '@common/ipc'
import { openDatabase } from './db/connection'
import { defaultRepoDeps } from './db/deps'
import { createAppStateRepo } from './db/appStateRepo'
import { createTabRepo } from './db/tabRepo'
import { createWorkspaceRepo } from './db/workspaceRepo'
import { createDraftCommentRepo } from './db/draftCommentRepo'
import { createPrCacheRepo } from './db/prCacheRepo'
import { createReviewSessionRepo } from './db/reviewSessionRepo'
import { createSessionManager } from './pty/sessionManager'
import { ensureSpawnHelperExecutable, nodePtySpawn } from './pty/nodePtySpawn'
import { buildSpawn } from './pty/shell'
import { createWorkspaceHandlers, registerWorkspaceHandlers } from './ipc/workspaces.ipc'
import { createTabHandlers, registerTabHandlers } from './ipc/tabs.ipc'
import { createSender, createTerminalHandlers, registerTerminalHandlers } from './ipc/terminal.ipc'
import { createPrInboxHandlers, registerPrInboxHandlers } from './ipc/prInbox.ipc'
import { createAdoClient } from './prInbox/adoClient'
import { createAdoService } from './prInbox/adoService'
import { resolveAdoServerConfig, resolveMyIdentity } from './prInbox/adoConfig'
import { createReviewManager } from './prInbox/reviewManager'
import { createWorktreeManager } from './prInbox/worktreeManager'

// Deterministic userData dir -> ~/Library/Application Support/Jarvis/ (or an E2E override).
app.setName('Jarvis')

let mainWindow: BrowserWindow | null = null
let db: DatabaseSync | null = null

/** Best-effort resolution of the `claude` binary for the review session. */
function resolveClaudePath(): string {
  const explicit = process.env.JARVIS_CLAUDE_PATH
  if (explicit) return explicit
  const local = join(homedir(), '.local', 'bin', 'claude')
  return existsSync(local) ? local : 'claude'
}

/** Fire-and-forget send to the renderer, guarded against a destroyed window. */
function sendToRenderer(channel: string, ...args: unknown[]): void {
  const wc = mainWindow?.webContents
  if (wc && !wc.isDestroyed()) wc.send(channel, ...args)
}

/** The configured ADO default project, or a sensible fallback if ADO isn't configured yet. */
function safeDefaultProject(): string {
  try {
    return resolveAdoServerConfig().env.AZURE_DEVOPS_DEFAULT_PROJECT || 'SPOT'
  } catch {
    return 'SPOT'
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#0e0f13',
    title: 'Jarvis',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void mainWindow.loadURL(devUrl)
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

function wireIpc(database: DatabaseSync): void {
  const deps = defaultRepoDeps
  const workspaces = createWorkspaceRepo(database, deps)
  const tabs = createTabRepo(database, deps)
  const appState = createAppStateRepo(database)

  const sessions = createSessionManager({
    spawn: nodePtySpawn,
    send: createSender(() => mainWindow?.webContents ?? null),
    buildSpec: (preset) => buildSpawn(preset, { testMode: process.env.JARVIS_E2E === '1' })
  })

  const pickFolder = async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose a workspace folder'
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  }

  registerWorkspaceHandlers(
    ipcMain,
    createWorkspaceHandlers({ db: database, workspaces, tabs, appState, sessions, pickFolder })
  )
  registerTabHandlers(ipcMain, createTabHandlers({ db: database, workspaces, tabs, sessions }))
  registerTerminalHandlers(ipcMain, createTerminalHandlers(sessions))

  // --- PR Review Inbox slice ---
  const prCache = createPrCacheRepo(database, deps)
  const drafts = createDraftCommentRepo(database, deps)
  const reviewSessions = createReviewSessionRepo(database, deps)

  const adoClient = createAdoClient(() => resolveAdoServerConfig())
  const defaultProject = safeDefaultProject()
  const ado = createAdoService({
    client: adoClient,
    resolveIdentity: () => resolveMyIdentity(),
    projectId: defaultProject
  })

  const review = createReviewManager({
    reviewSessions,
    drafts,
    prCache,
    worktrees: createWorktreeManager(),
    workspaceFolders: () => workspaces.list().map((w) => w.folderPath),
    spawn: nodePtySpawn,
    sendData: (data) => sendToRenderer(Channel.prInboxReviewData, data),
    sendExit: (exitCode) => sendToRenderer(Channel.prInboxReviewExit, exitCode),
    onDraft: (draft) => sendToRenderer(Channel.prInboxDraftAdded, draft),
    claudePath: resolveClaudePath(),
    draftServerPath: join(__dirname, 'draftServer.js')
  })

  registerPrInboxHandlers(ipcMain, createPrInboxHandlers({ prCache, drafts, ado, review }))
  void review.pruneOnBoot().catch(() => {})

  // Kill every PTY when the app quits so no shell process is orphaned. review.shutdown() is
  // synchronous and does NOT touch the DB, so closing the DB immediately after is safe (its async
  // PTY-exit handler is neutered by the disposed flag); a leftover worktree is reclaimed on next boot.
  app.on('before-quit', () => {
    sessions.killAll()
    review.shutdown()
    void adoClient.close()
    db?.close()
    db = null
  })
}

app.whenReady().then(() => {
  ensureSpawnHelperExecutable()
  const userDataDir = process.env.JARVIS_USER_DATA_DIR || app.getPath('userData')
  db = openDatabase(userDataDir)
  wireIpc(db)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Single-window app: quitting on window close avoids a dock re-activate showing dead shells.
app.on('window-all-closed', () => {
  app.quit()
})
