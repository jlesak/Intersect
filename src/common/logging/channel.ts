/**
 * The renderer's route to the log file. Deliberately a plain constant rather than a `Channel`
 * member: `CORE_INVOKE_CHANNELS` is derived as every channel not otherwise classified, so adding
 * this to the enum would register a forwarder shipping log records into the core process and turn
 * a fire-and-forget send into a round trip. `NATIVE_NOTIFICATION_PUSH` and `CORE_SHUTDOWN_CHANNEL`
 * sit outside the enum for the same reason.
 */
export const RENDERER_LOG_CHANNEL = 'log:write'
