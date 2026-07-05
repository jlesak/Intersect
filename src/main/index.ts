import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from './db/connection'
import { defaultRepoDeps } from './db/deps'
import { createAppStateRepo } from './db/appStateRepo'
import { createTabRepo } from './db/tabRepo'
import { createWorkspaceRepo } from './db/workspaceRepo'
import { createSessionManager } from './pty/sessionManager'
import { ensureSpawnHelperExecutable, nodePtySpawn } from './pty/nodePtySpawn'
import { buildSpawn } from './pty/shell'
import { createWorkspaceHandlers, registerWorkspaceHandlers } from './ipc/workspaces.ipc'
import { createTabHandlers, registerTabHandlers } from './ipc/tabs.ipc'
import { createSender, createTerminalHandlers, registerTerminalHandlers } from './ipc/terminal.ipc'

// Deterministic userData dir -> ~/Library/Application Support/Jarvis/ (or an E2E override).
app.setName('Jarvis')

let mainWindow: BrowserWindow | null = null
let db: DatabaseSync | null = null

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

  // Kill every PTY when the app quits so no shell process is orphaned.
  app.on('before-quit', () => {
    sessions.killAll()
    db?.close()
    db = null
  })
}

function applyProductionCsp(): void {
  // Strict CSP for the packaged (loadFile) app; skipped in dev so Vite HMR works. The renderer
  // only ever loads local content and runs with contextIsolation + sandbox + no nodeIntegration.
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'"
        ]
      }
    })
  })
}

app.whenReady().then(() => {
  ensureSpawnHelperExecutable()
  const userDataDir = process.env.JARVIS_USER_DATA_DIR || app.getPath('userData')
  db = openDatabase(userDataDir)
  wireIpc(db)
  if (!process.env.ELECTRON_RENDERER_URL) applyProductionCsp()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Single-window app: quitting on window close avoids a dock re-activate showing dead shells.
app.on('window-all-closed', () => {
  app.quit()
})
