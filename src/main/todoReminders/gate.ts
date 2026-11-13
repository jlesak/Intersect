import { resolve } from 'node:path'

export interface ReminderGateInput {
  packaged: boolean
  /** INTERSECT_E2E is set. */
  e2e: boolean
  /** The profile this run uses, after INTERSECT_USER_DATA_DIR and --user-data-dir. */
  userDataDir: string
  /** The profile the installed app uses when nothing overrides it. */
  defaultUserDataDir: string
}

/**
 * Whether this run may schedule real macOS reminders. Pending requests belong to the app's bundle
 * id, not to a profile, so only the installed app on its default profile may touch them: a dev run,
 * an e2e run or a second profile would remove or double the owner's reminders.
 */
export function useNativeReminders(input: ReminderGateInput): boolean {
  return input.packaged && !input.e2e &&
    resolve(input.userDataDir) === resolve(input.defaultUserDataDir)
}
