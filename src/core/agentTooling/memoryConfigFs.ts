import { sep } from 'node:path'
import type { ConfigFs, ConfigWriteFs, DirEntry } from './configFs'

/** One in-memory file: its bytes and permission-mode bits. */
interface MemFile {
  data: string
  mode: number
}

/**
 * A single in-memory filesystem that satisfies both the read and write seams over one shared
 * store, so the config writer's pipeline logic (revision guard, backup, temp + rename, undo) can
 * be driven deterministically without a real disk. It is intentionally naive: no symlinks (real
 * containment is proved by the realfs tests), and directories exist implicitly once a file or an
 * explicit `mkdir` places something under them. `fsync` is a no-op.
 */
export function createMemoryConfigFs(seed: Record<string, string> = {}) {
  const files = new Map<string, MemFile>()
  const dirs = new Set<string>()
  for (const [path, data] of Object.entries(seed)) files.set(path, { data, mode: 0o644 })

  const isImpliedDir = (path: string): boolean => {
    if (dirs.has(path)) return true
    const prefix = path + sep
    for (const key of files.keys()) if (key.startsWith(prefix)) return true
    for (const key of dirs) if (key.startsWith(prefix)) return true
    return false
  }

  const read: ConfigFs = {
    readFile(path) {
      return files.get(path)?.data ?? null
    },
    readDir(path): DirEntry[] | null {
      if (!isImpliedDir(path)) return null
      const prefix = path + sep
      const names = new Set<string>()
      const entries: DirEntry[] = []
      const consider = (key: string, isFile: boolean): void => {
        if (!key.startsWith(prefix)) return
        const rest = key.slice(prefix.length)
        const name = rest.split(sep)[0]
        if (names.has(name)) return
        names.add(name)
        const direct = rest.indexOf(sep) === -1
        entries.push({ name, isDirectory: !direct || !isFile, isFile: direct && isFile })
      }
      for (const key of files.keys()) consider(key, true)
      for (const key of dirs) consider(key, false)
      return entries
    },
    realpath(path) {
      if (files.has(path) || isImpliedDir(path)) return path
      return null
    }
  }

  const write: ConfigWriteFs = {
    statMode(path) {
      return files.get(path)?.mode ?? null
    },
    copyFile(src, dst) {
      const f = files.get(src)
      if (!f) throw new Error(`ENOENT: ${src}`)
      files.set(dst, { data: f.data, mode: f.mode })
    },
    writeFile(path, data, mode) {
      files.set(path, { data, mode })
    },
    chmod(path, mode) {
      const f = files.get(path)
      if (f) f.mode = mode
    },
    rename(src, dst) {
      const f = files.get(src)
      if (!f) throw new Error(`ENOENT: ${src}`)
      files.set(dst, f)
      files.delete(src)
    },
    mkdir(dir) {
      dirs.add(dir)
    },
    unlink(path) {
      files.delete(path)
    },
    fsyncFile() {
      // no-op
    },
    fsyncDir() {
      // no-op
    }
  }

  return {
    read,
    write,
    /** Direct access to the underlying store, so a test can inspect or mutate it out-of-band. */
    files,
    dirs,
    /** Convenience: whether a path currently holds a file. */
    has: (path: string): boolean => files.has(path)
  }
}
