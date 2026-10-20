import type { CoreFailedPayload } from '@common/coreBridge'
import { DatabaseSetAsideError, DatabaseStartupError } from './db/connection'

/**
 * The failure push for an error that stopped the core's bootstrap.
 *
 * A database failure is one the database itself raised: opening it, migrating it, or any query the
 * boot runs against it, which is how a file damaged past its header shows up. Every boot repeats it
 * against the same file, so it is the one failure setting the database aside can cure. Only errors
 * from the synchronous bootstrap reach here, so a SQLite error after the core is ready never does.
 *
 * A failed set-aside is reported apart and is never a database failure: offering the same set-aside
 * again would be offering what just failed, and the host stops on it instead of respawning.
 */
export function bootFailurePayload(err: unknown): CoreFailedPayload {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof DatabaseSetAsideError) return { message, setAsideFailed: true }
  if (err instanceof DatabaseStartupError || isSqliteError(err)) {
    return { message, databaseFailure: true }
  }
  return { message }
}

/** node:sqlite marks every error it raises with this code. */
function isSqliteError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ERR_SQLITE_ERROR'
}
