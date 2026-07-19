import {
  chmodSync,
  closeSync,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'

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

/**
 * The write primitives the config writer needs, kept on a separate seam so the read seam stays
 * pure and never grows a mutating method. Unlike {@link ConfigFs}, these are allowed to throw:
 * the writer's job is to sequence them so any failure aborts before the original file is touched
 * and cleans up its temp artifact. The default binds to `node:fs` sync primitives; an in-memory
 * double stands in for the fast writer unit tests.
 */
export interface ConfigWriteFs {
  /** The file's permission-mode bits, or null when the file does not exist. */
  statMode(path: string): number | null
  /** Copy `src` to `dst` verbatim (used to stamp a backup before overwriting). */
  copyFile(src: string, dst: string): void
  /** Write `data` to `path`, creating it with `mode` when absent. */
  writeFile(path: string, data: string, mode: number): void
  /** Force `path`'s permission bits to `mode` (a fresh temp file may ignore the write-time mode). */
  chmod(path: string, mode: number): void
  /** Atomically replace `dst` with `src` (same-directory rename). */
  rename(src: string, dst: string): void
  /** Recursively create `dir` (the confirmed-save creation of a missing project `.claude/`). */
  mkdir(dir: string): void
  /** Remove `path`, swallowing a missing-file error (temp cleanup on an aborted write). */
  unlink(path: string): void
  /** Flush `path`'s contents to stable storage (best-effort; ignored where unsupported). */
  fsyncFile(path: string): void
  /** Flush `dir`'s directory entry so a rename survives a crash (best-effort; often disallowed). */
  fsyncDir(dir: string): void
}

/** The production wiring: plain `node:fs` sync writes with best-effort fsync. */
export const defaultConfigWriteFs: ConfigWriteFs = {
  statMode(path) {
    try {
      return statSync(path).mode
    } catch {
      return null
    }
  },
  copyFile(src, dst) {
    copyFileSync(src, dst)
  },
  writeFile(path, data, mode) {
    writeFileSync(path, data, { mode })
  },
  chmod(path, mode) {
    // A pre-existing temp file keeps its old mode through writeFileSync, so force it explicitly.
    chmodSync(path, mode)
  },
  rename(src, dst) {
    renameSync(src, dst)
  },
  mkdir(dir) {
    mkdirSync(dir, { recursive: true })
  },
  unlink(path) {
    try {
      unlinkSync(path)
    } catch {
      // A missing temp file is the success case for cleanup; anything else is not worth escalating.
    }
  },
  fsyncFile(path) {
    // Open, flush, close. Failures are non-fatal: durability is best-effort, correctness is not.
    let fd: number | null = null
    try {
      fd = openSync(path, 'r+')
      fsyncSync(fd)
    } catch {
      // ignore
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          // ignore
        }
      }
    }
  },
  fsyncDir(dir) {
    // Directory fsync is what makes a rename crash-safe, but many platforms reject opening a
    // directory for fsync (EISDIR/EPERM). Best-effort: a failure here never fails the save.
    let fd: number | null = null
    try {
      fd = openSync(dir, 'r')
      fsyncSync(fd)
    } catch {
      // ignore
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          // ignore
        }
      }
    }
  }
}
