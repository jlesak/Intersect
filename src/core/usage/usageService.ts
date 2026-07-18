import { readFileSync, watch, type FSWatcher } from 'node:fs'
import { dirname } from 'node:path'
import type { ClaudeUsage, ClaudeUsageWindow } from '@common/domain'
import { debounce } from '@common/debounce'

/** Injected filesystem seam, so tests can watch/read without touching the real disk. */
export interface UsageServiceFs {
  readFileSync(path: string, encoding: 'utf8'): string
  watch(dir: string, listener: () => void): FSWatcher
}

const defaultFs: UsageServiceFs = { readFileSync, watch }

export interface UsageServiceDeps {
  /** Absolute path to the snapshot file the usage-statusline script writes. */
  snapshotPath: string
  fs?: UsageServiceFs
  /** Coalesces the burst of fs.watch events an atomic rename produces. Defaults to 150ms. */
  debounceMs?: number
}

export interface UsageService {
  /** The last captured usage snapshot, or null if none has arrived (or it failed to parse). */
  get(): ClaudeUsage | null
  /** Fired whenever a fresh snapshot is read off disk. Returns an unsubscribe fn. */
  onChange(cb: (usage: ClaudeUsage | null) => void): () => void
  /** Stops watching the snapshot directory. */
  dispose(): void
}

/** A window's raw shape straight off Claude Code's own statusline JSON (snake_case, unvalidated). */
interface RawWindow {
  used_percentage?: unknown
  resets_at?: unknown
}

interface RawSnapshot {
  rateLimits?: { five_hour?: RawWindow; seven_day?: RawWindow } | null
  capturedAt?: unknown
}

function toWindow(w: RawWindow | undefined): ClaudeUsageWindow | null {
  if (!w || typeof w.used_percentage !== 'number' || typeof w.resets_at !== 'number') return null
  return { usedPercent: w.used_percentage, resetsAt: w.resets_at }
}

/** Maps the raw snapshot file content into the renderer-facing contract. Tolerant of any shape. */
function toClaudeUsage(raw: unknown): ClaudeUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const snapshot = raw as RawSnapshot
  if (typeof snapshot.capturedAt !== 'number') return null
  return {
    fiveHour: toWindow(snapshot.rateLimits?.five_hour),
    sevenDay: toWindow(snapshot.rateLimits?.seven_day),
    capturedAt: snapshot.capturedAt
  }
}

/**
 * Reads the Claude Code usage snapshot the app-managed statusline script writes, watching its
 * directory (not the file itself - an atomic rename replaces the inode, which a file-level watch
 * can miss) so the sidebar panel updates live as new statuslines land. Missing/malformed content
 * is tolerated everywhere - `get()` simply returns null rather than throwing, since the file may
 * not exist yet (no Claude session has run since install) or a write may be mid-flight.
 */
export function createUsageService(deps: UsageServiceDeps): UsageService {
  const fs = deps.fs ?? defaultFs
  const listeners = new Set<(usage: ClaudeUsage | null) => void>()

  /** Raw file content, or null if it could not be read. Null-safe equality lets us detect a
   *  read failure that persists across watch events (missing file) as "unchanged" too. */
  function readRaw(): string | null {
    try {
      return fs.readFileSync(deps.snapshotPath, 'utf8')
    } catch {
      return null
    }
  }

  function parseSnapshot(raw: string | null): ClaudeUsage | null {
    if (raw === null) return null
    try {
      return toClaudeUsage(JSON.parse(raw))
    } catch {
      return null
    }
  }

  let lastRaw = readRaw()
  let current = parseSnapshot(lastRaw)

  // The watched directory also hosts the SQLite DB and settings JSONs, so most fs.watch events
  // fire for writes that have nothing to do with the snapshot file. Comparing raw content before
  // notifying skips those: an unrelated write re-reads an identical file, and pushing that as a
  // fresh object identity would otherwise trigger a pointless re-render in the renderer.
  const refresh = debounce(() => {
    const raw = readRaw()
    if (raw === lastRaw) return
    lastRaw = raw
    current = parseSnapshot(raw)
    for (const cb of listeners) cb(current)
  }, deps.debounceMs ?? 150)

  const watcher = fs.watch(dirname(deps.snapshotPath), () => refresh())

  return {
    get: () => current,
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    dispose() {
      refresh.cancel()
      watcher.close()
    }
  }
}
