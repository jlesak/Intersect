import { Channel } from '../ipc'

/**
 * The renderer's route to the log file. Deliberately a plain constant rather than a `Channel`
 * member: `CORE_INVOKE_CHANNELS` is derived as every channel not otherwise classified, so adding
 * this to the enum would register a forwarder shipping log records into the core process and turn
 * a fire-and-forget send into a round trip. `NATIVE_NOTIFICATION_PUSH` and `CORE_SHUTDOWN_CHANNEL`
 * sit outside the enum for the same reason.
 */
export const RENDERER_LOG_CHANNEL = 'log:write'

/**
 * Channels whose traffic is never logged. These carry terminal keystrokes and terminal output at
 * keyboard and screen-refresh rates; recording them would flood the file and throttle the very
 * terminal being logged. Terminal lifecycle - spawn, kill, exit - stays logged, because it is
 * low-frequency and diagnostically valuable.
 */
export const UNLOGGED_CHANNELS: ReadonlySet<string> = new Set<string>([
  Channel.terminalInput,
  Channel.terminalResize,
  Channel.terminalPause,
  Channel.terminalResume,
  Channel.terminalData,
  Channel.prInboxReviewInput,
  Channel.prInboxReviewResize,
  Channel.prInboxReviewData
])
