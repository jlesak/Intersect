import { readFileSync, readdirSync, realpathSync } from 'node:fs'

/** One directory entry with the type flags the catalog walks need. */
export interface DirEntry {
  name: string
  isDirectory: boolean
  isFile: boolean
}

/**
 * The read-only filesystem seams the Claude config reader depends on. Each returns null on any
 * failure (missing path, permission denied) instead of throwing, so a single unreadable file
 * degrades one row rather than the whole catalog. Injected so tests exercise provenance,
 * containment, and malformed-tolerance logic without touching real disk; the default binds to
 * `node:fs` sync primitives. None of these ever create a file or directory - the feature is
 * strictly read-only.
 */
export interface ConfigFs {
  /** The file's UTF-8 contents, or null when it cannot be read. */
  readFile(path: string): string | null
  /** The directory's entries, or null when it cannot be listed. */
  readDir(path: string): DirEntry[] | null
  /** The canonical (symlinks-resolved) absolute path, or null when the path does not exist. */
  realpath(path: string): string | null
}

/** The production wiring: plain `node:fs` sync reads, every failure folded to null. */
export const defaultConfigFs: ConfigFs = {
  readFile(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
  readDir(path) {
    try {
      return readdirSync(path, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile()
      }))
    } catch {
      return null
    }
  },
  realpath(path) {
    try {
      return realpathSync.native(path)
    } catch {
      return null
    }
  }
}
