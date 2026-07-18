import { Channel, type ChannelName } from './ipc'

/**
 * How each renderer-facing channel crosses the process boundary now that services live in
 * the headless core: Electron main is a thin bridge that either answers a channel itself
 * (the explicit Electron-only allowlist below) or forwards it verbatim over the core port.
 *
 * The classification is the contract: every channel belongs to exactly one direction, and
 * the bridge registers forwarders mechanically from these sets - there is no per-slice
 * registration glue left in main.
 */

/**
 * Request/response channels that only Electron main can serve: native dialogs, shell
 * hand-offs, and app lifecycle. These are never forwarded to the core process, and the
 * core's own handlers for them throw.
 */
export const ELECTRON_ONLY_CHANNELS: ReadonlySet<ChannelName> = new Set<ChannelName>([
  Channel.workspacesPickFolder,
  Channel.oneOnOnePickVtt,
  Channel.systemOpenExternal,
  Channel.systemRevealPath,
  Channel.systemRestartApp,
  Channel.systemRetryCore,
  Channel.systemQuitApp
])

/**
 * Fire-and-forget renderer -> core channels (the PTY fast path). Forwarded as port
 * notifications: no correlation id, no response, no pending entry - so a keystroke or a
 * resize never allocates and never waits.
 */
export const CORE_NOTIFY_CHANNELS: ReadonlySet<ChannelName> = new Set<ChannelName>([
  Channel.terminalInput,
  Channel.terminalResize,
  Channel.terminalPause,
  Channel.terminalResume,
  Channel.terminalKill,
  Channel.terminalReportActive,
  Channel.prInboxReviewInput,
  Channel.prInboxReviewResize
])

/**
 * Main -> renderer broadcast channels. `sourced: 'core'` entries originate in the core
 * process and are forwarded verbatim; `sourced: 'main'` entries originate in Electron main
 * itself (native notification clicks, core lifecycle) and never cross the core port.
 */
export const RENDERER_PUSH_CHANNELS: ReadonlyMap<ChannelName, 'core' | 'main'> = new Map<
  ChannelName,
  'core' | 'main'
>([
  [Channel.terminalData, 'core'],
  [Channel.terminalExit, 'core'],
  [Channel.terminalSessionStatus, 'core'],
  [Channel.prInboxReviewData, 'core'],
  [Channel.prInboxReviewExit, 'core'],
  [Channel.prInboxDraftAdded, 'core'],
  [Channel.oneOnOneRunChanged, 'core'],
  [Channel.myWorkChanged, 'core'],
  [Channel.usageChanged, 'core'],
  [Channel.terminalNotificationClicked, 'main'],
  [Channel.systemCoreStatus, 'main']
])

/**
 * Request/response channels forwarded to the core: every channel that is neither
 * fire-and-forget, nor a broadcast, nor Electron-only. Derived, so a new slice channel is
 * core-routed by default and going native requires an explicit allowlist entry.
 */
export const CORE_INVOKE_CHANNELS: ReadonlySet<ChannelName> = new Set<ChannelName>(
  Object.values(Channel).filter(
    (channel) =>
      !ELECTRON_ONLY_CHANNELS.has(channel) &&
      !CORE_NOTIFY_CHANNELS.has(channel) &&
      !RENDERER_PUSH_CHANNELS.has(channel)
  )
)

// --- Core -> main pushes that are commands for native, main-only side effects ---

/** Raise a native notification for a session that wants the user (already fully resolved). */
export const NATIVE_NOTIFICATION_PUSH = 'native:notification'
export interface NativeNotificationRequest {
  sessionId: string
  title: string
  subtitle?: string
  body: string
  silent: boolean
}

/** Set the macOS Dock badge to the canonical count of sessions awaiting interaction. */
export const NATIVE_DOCK_BADGE_PUSH = 'native:dockBadge'
export interface NativeDockBadgeRequest {
  count: number
}

// --- Main -> core notifications outside the renderer contract ---

/** The main window gained/lost focus; the core's attention gate suppresses alerts when focused. */
export const WINDOW_FOCUS_CHANGED = 'window:focusChanged'
export interface WindowFocusChangedEvent {
  focused: boolean
}

// --- Core lifecycle (handshake between main and the core entry, not renderer-visible) ---

/** First message main posts to the forked core, carrying the port and the boot inputs. */
export interface CoreInitMessage {
  kind: 'init'
  userDataDir: string
  /** Electron main's binary path; hook/statusline commands run it with ELECTRON_RUN_AS_NODE. */
  execPath: string
}

/** Core finished bootstrapping and is serving requests. */
export const CORE_READY_PUSH = 'core:ready'
/** Core bootstrap failed; the process stays up so the message can be read, main decides. */
export const CORE_FAILED_PUSH = 'core:failed'
export interface CoreFailedPayload {
  message: string
}

/** Coordinated shutdown request (main -> core): dispose services, close the DB, then exit. */
export const CORE_SHUTDOWN_CHANNEL = 'core:shutdown'

/**
 * One slice's wire contract: its renderer channels bound to the handler methods that serve
 * them. Slices each export a builder returning this shape; the core composes the slice maps
 * into the one dispatch table - no monolithic request switch.
 */
export type WireRoutes = Record<string, (...args: never[]) => unknown>
