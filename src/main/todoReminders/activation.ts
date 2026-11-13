import { taskIdFromReminderId } from '@common/todoReminder'

/**
 * The task a cold launch was asked to open, read from the `ready` event's `launchInfo`. For a
 * launch from Notification Center, Electron fills it from the UNNotificationResponse
 * (`identifier`, `actionIdentifier`, `date`, `userInfo`); any other launch names no task.
 */
export function reminderTaskIdFromLaunchInfo(launchInfo: unknown): string | null {
  if (typeof launchInfo !== 'object' || launchInfo === null) return null
  return taskIdFromReminderId((launchInfo as { identifier?: unknown }).identifier)
}

/** The BrowserWindow surface the activation needs. */
export interface ActivationWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  isVisible(): boolean
  show(): void
  focus(): void
}

export interface ReminderActivationDeps {
  getWindow(): ActivationWindow | null
  /** Creates the main window; it reports back through windowCreated. */
  createWindow(): void
  focusApp(): void
  /** Tells the loaded renderer which task to open. */
  send(taskId: string): void
}

export interface ReminderActivation {
  /** Remember a task to open once a window has loaded. Never creates a window. */
  enqueue(taskId: string): void
  /** A click on a reminder while the app runs: raise or create the window, then open the task. */
  activate(taskId: string): void
  windowCreated(): void
  windowLoaded(): void
  windowClosed(): void
}

/**
 * Every reminder click goes through here. A cold launch only enqueues, so the app's own startup
 * stays the one path that creates the first window. A warm click raises the live window, or creates
 * one when there is none. Either way the task id is sent once, after the window's renderer has
 * loaded, because a renderer that is still loading has no listener for it yet.
 */
export function createReminderActivation(deps: ReminderActivationDeps): ReminderActivation {
  let queued: string | null = null
  let loaded = false

  const liveWindow = (): ActivationWindow | null => {
    const win = deps.getWindow()
    return win && !win.isDestroyed() ? win : null
  }

  const flush = (): void => {
    if (queued === null || !loaded || !liveWindow()) return
    const taskId = queued
    queued = null
    deps.send(taskId)
  }

  const enqueue = (taskId: string): void => {
    queued = taskId
    flush()
  }

  return {
    enqueue,
    activate(taskId) {
      const win = liveWindow()
      if (win) {
        if (win.isMinimized()) win.restore()
        if (!win.isVisible()) win.show()
        win.focus()
        deps.focusApp()
      } else {
        deps.createWindow()
      }
      enqueue(taskId)
    },
    windowCreated() {
      loaded = false
    },
    windowLoaded() {
      loaded = true
      flush()
    },
    windowClosed() {
      loaded = false
    }
  }
}
