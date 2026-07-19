import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  ConfigEdit,
  ConfigPreview,
  ConfigSaveResult,
  ConfigSource,
  ConfigUndoResult,
  RawTargetView
} from '@common/domain'
import { applyEdit, ConfigEditError, parseTopLevelObject } from './configEdit'
import { defaultConfigFs, defaultConfigWriteFs, type ConfigFs, type ConfigWriteFs } from './configFs'
import { createConfigPaths, isContained, type ResolvedScope } from './configPaths'

/** The stable revision reported for a file that does not exist, so a concurrent create is caught. */
const ABSENT_REVISION = 'absent'
/** The suffix of the same-directory temp file every write lands on before its atomic rename. */
const TEMP_SUFFIX = '.intersect-tmp'
/** A private-by-default permission mode for a config file Intersect creates from nothing. */
const DEFAULT_NEW_FILE_MODE = 0o600

export interface ConfigWriterDeps {
  /** The read seam; defaults to `node:fs` sync reads. */
  fs?: ConfigFs
  /** The write seam; defaults to `node:fs` sync writes with best-effort fsync. */
  writeFs?: ConfigWriteFs
  /** The Claude home directory. Defaults to `INTERSECT_CLAUDE_HOME` then `~/.claude` (like the reader). */
  claudeHome?: string
  /** Injected so backup filenames are deterministic in tests; defaults to the wall clock. */
  clock?: () => Date
}

/** The core-side preview shape, before the handler stamps the renderer's original scope onto it. */
export type PreviewCore = Omit<ConfigPreview, 'scope'>
/** The core-side raw view, before the handler stamps the renderer's original scope onto it. */
export type RawTargetCore = Omit<RawTargetView, 'scope'>
/** The core-side save result (its `path`/`ok`/reason fields need no scope). */
export type SaveResult = ConfigSaveResult

/** The one-shot restore handle a successful save leaves behind, consumed by a matching undo. */
interface UndoHandle {
  targetPath: string
  containRoot: string | null
  backupPath?: string
  /** The exact bytes present before the save; null when the save created the file from nothing. */
  priorBytes: string | null
  /** The mode to restore the file with. */
  mode: number
  /** The revision the file must still carry for the undo to be safe (what the save wrote). */
  savedRevision: string
}

/** sha256 of the file's bytes, or the absent sentinel so a create-since-preview is detectable. */
function revisionOf(bytes: string | null): string {
  if (bytes === null) return ABSENT_REVISION
  return createHash('sha256').update(bytes, 'utf8').digest('hex')
}

/** Pretty-print JSON text for display, falling back to the raw text when it will not parse. */
function tryPretty(bytes: string | null): string {
  if (bytes === null || bytes.trim() === '') return ''
  try {
    return JSON.stringify(JSON.parse(bytes), null, 2) + '\n'
  } catch {
    return bytes
  }
}

/** A two-decimal-then-three timestamp with millisecond resolution: `YYYYMMDD-HHMMSS-mmm`. */
function backupStamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `-${p(d.getMilliseconds(), 3)}`
  )
}

/**
 * The guarded writer over the Claude Code configuration files. Every mutation is previewed against
 * a revision token, confirmed, backed up, written to a same-directory temp file (mode preserved,
 * fsync where the platform allows), and atomically renamed into place; a one-shot undo restores
 * the exact prior bytes through the same guarded path. Any failure after the temp file is created
 * unlinks it and leaves the original file untouched. Pure over its injected seams, so tests drive
 * it against a temp directory or an in-memory double without ever touching the real `~/.claude`.
 */
export function createConfigWriter(deps: ConfigWriterDeps = {}) {
  const fs = deps.fs ?? defaultConfigFs
  const writeFs = deps.writeFs ?? defaultConfigWriteFs
  const claudeHome =
    deps.claudeHome ?? process.env.INTERSECT_CLAUDE_HOME ?? join(homedir(), '.claude')
  const clock = deps.clock ?? (() => new Date())
  const paths = createConfigPaths({ fs, claudeHome })
  const undoHandles = new Map<string, UndoHandle>()

  /**
   * The realpath of the nearest existing ancestor of `path` (the file itself when it exists),
   * or null when nothing along the chain resolves. Lets containment be enforced on a file that
   * does not exist yet by proving its would-be location sits inside the project root.
   */
  function nearestExistingReal(path: string): string | null {
    let p = path
    for (;;) {
      const real = fs.realpath(p)
      if (real !== null) return real
      const parent = dirname(p)
      if (parent === p) return null
      p = parent
    }
  }

  /** Whether writing `path` stays inside `containRoot` (always true for a null root - global scope). */
  function contained(path: string, containRoot: string | null): boolean {
    if (containRoot === null) return true
    const rootReal = fs.realpath(containRoot)
    if (rootReal === null) return false
    const real = nearestExistingReal(path)
    return real !== null && isContained(real, rootReal)
  }

  function provenanceOf(global: boolean, path: string): string {
    return `${global ? 'Global (~/.claude)' : 'Project'} · ${path}`
  }

  /** Read one target file for the raw editor, gated by containment (never creates anything). */
  function readTarget(scope: ResolvedScope, source: ConfigSource): RawTargetCore {
    const target = paths.resolveWriteTarget(scope, source)
    const global = target.containRoot === null
    if (!contained(target.path, target.containRoot)) {
      throw new Error(`Blocked: ${target.path} resolves outside the project root`)
    }
    const bytes = fs.readFile(target.path)
    return {
      source,
      path: target.path,
      exists: bytes !== null,
      global,
      content: bytes ?? '',
      revision: revisionOf(bytes)
    }
  }

  /** Compute the exact bytes an edit would write, or throw a {@link ConfigEditError} on a bad shape. */
  function proposeBytes(currentBytes: string | null, edit: ConfigEdit): string {
    const proposed = applyEdit(currentBytes ?? '', edit)
    // Validate the final document as a top-level object regardless of which path produced it (the
    // raw editor's text has not been shape-checked yet; structured edits are already objects).
    parseTopLevelObject(proposed)
    return proposed
  }

  function preview(scope: ResolvedScope, source: ConfigSource, edit: ConfigEdit): PreviewCore {
    const target = paths.resolveWriteTarget(scope, source)
    const global = target.containRoot === null
    const provenance = provenanceOf(global, target.path)

    if (!contained(target.path, target.containRoot)) {
      return {
        source,
        path: target.path,
        provenance,
        exists: false,
        global,
        currentContent: '',
        proposedContent: '',
        revision: ABSENT_REVISION,
        valid: false,
        errors: [`Blocked: ${target.path} resolves outside the project root`]
      }
    }

    const bytes = fs.readFile(target.path)
    const revision = revisionOf(bytes)
    const isRaw = edit.kind === 'raw'
    // Raw edits diff the actual bytes (the user is editing the file verbatim); structured edits
    // diff pretty-printed content so formatting noise never masks the one semantic change.
    const currentContent = isRaw ? bytes ?? '' : tryPretty(bytes)

    try {
      const proposedContent = proposeBytes(bytes, edit)
      return {
        source,
        path: target.path,
        provenance,
        exists: bytes !== null,
        global,
        currentContent,
        proposedContent,
        revision,
        valid: true,
        errors: []
      }
    } catch (err) {
      const message =
        err instanceof ConfigEditError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      return {
        source,
        path: target.path,
        provenance,
        exists: bytes !== null,
        global,
        currentContent,
        proposedContent: '',
        revision,
        valid: false,
        errors: [message]
      }
    }
  }

  function save(
    scope: ResolvedScope,
    source: ConfigSource,
    edit: ConfigEdit,
    revision: string
  ): SaveResult {
    const target = paths.resolveWriteTarget(scope, source)
    if (!contained(target.path, target.containRoot)) {
      return {
        ok: false,
        path: target.path,
        reason: 'blocked',
        error: `Blocked: ${target.path} resolves outside the project root`
      }
    }

    // Re-read now and enforce the external-change guard before anything is written.
    const currentBytes = fs.readFile(target.path)
    if (revisionOf(currentBytes) !== revision) {
      return {
        ok: false,
        path: target.path,
        reason: 'changed-externally',
        error: 'The file changed on disk since you previewed it. Reload and try again.'
      }
    }

    let proposedBytes: string
    try {
      proposedBytes = proposeBytes(currentBytes, edit)
    } catch (err) {
      return {
        ok: false,
        path: target.path,
        reason: 'invalid',
        error: err instanceof Error ? err.message : String(err)
      }
    }

    const existingMode = writeFs.statMode(target.path)
    const mode = existingMode !== null ? existingMode & 0o777 : DEFAULT_NEW_FILE_MODE
    const dir = dirname(target.path)
    const tmp = `${target.path}${TEMP_SUFFIX}`

    // Create a missing project `.claude/` only now, on a confirmed save (never on preview/read).
    if (currentBytes === null) {
      try {
        writeFs.mkdir(dir)
      } catch (err) {
        return { ok: false, path: target.path, reason: 'io', error: message(err) }
      }
    }

    // Back up the existing bytes before touching the file, with a collision-safe millisecond stamp.
    let backupPath: string | undefined
    if (currentBytes !== null) {
      try {
        backupPath = uniqueBackupPath(target.path)
        writeFs.copyFile(target.path, backupPath)
      } catch (err) {
        return { ok: false, path: target.path, reason: 'io', error: message(err) }
      }
    }

    // Temp + fsync + atomic rename. Any failure past temp creation unlinks the temp and leaves
    // the original file exactly as it was.
    try {
      writeFs.writeFile(tmp, proposedBytes, mode)
      writeFs.chmod(tmp, mode)
      writeFs.fsyncFile(tmp)
      writeFs.rename(tmp, target.path)
      writeFs.fsyncDir(dir)
    } catch (err) {
      writeFs.unlink(tmp)
      return { ok: false, path: target.path, reason: 'io', error: message(err) }
    }

    const newRevision = revisionOf(proposedBytes)
    undoHandles.set(target.path, {
      targetPath: target.path,
      containRoot: target.containRoot,
      backupPath,
      priorBytes: currentBytes,
      mode,
      savedRevision: newRevision
    })

    return { ok: true, path: target.path, backupPath, newRevision }
  }

  function undo(targetPath: string): ConfigUndoResult {
    const handle = undoHandles.get(targetPath)
    if (!handle) {
      return { ok: false, reason: 'no-handle', error: 'There is nothing to undo for this file.' }
    }
    if (!contained(handle.targetPath, handle.containRoot)) {
      return {
        ok: false,
        reason: 'blocked',
        error: `Blocked: ${handle.targetPath} resolves outside the project root`
      }
    }

    const currentBytes = fs.readFile(handle.targetPath)
    if (revisionOf(currentBytes) !== handle.savedRevision) {
      return {
        ok: false,
        reason: 'changed-since-save',
        error: 'The file changed since the save, so undo would overwrite newer content. Reload first.'
      }
    }

    const dir = dirname(handle.targetPath)
    // Restoring "no file" means removing the file the save created; otherwise write the exact
    // prior bytes back through the same guarded temp + rename path.
    if (handle.priorBytes === null) {
      try {
        writeFs.unlink(handle.targetPath)
      } catch (err) {
        return { ok: false, reason: 'io', error: message(err) }
      }
      undoHandles.delete(targetPath)
      return { ok: true, restoredRevision: ABSENT_REVISION }
    }

    const tmp = `${handle.targetPath}${TEMP_SUFFIX}`
    try {
      writeFs.writeFile(tmp, handle.priorBytes, handle.mode)
      writeFs.chmod(tmp, handle.mode)
      writeFs.fsyncFile(tmp)
      writeFs.rename(tmp, handle.targetPath)
      writeFs.fsyncDir(dir)
    } catch (err) {
      writeFs.unlink(tmp)
      return { ok: false, reason: 'io', error: message(err) }
    }

    undoHandles.delete(targetPath)
    return { ok: true, restoredRevision: revisionOf(handle.priorBytes) }
  }

  /** A backup path that does not already exist, disambiguated with a counter on a same-ms collision. */
  function uniqueBackupPath(path: string): string {
    const base = `${path}.bak.${backupStamp(clock())}`
    if (fs.realpath(base) === null) return base
    for (let i = 1; ; i++) {
      const candidate = `${base}-${i}`
      if (fs.realpath(candidate) === null) return candidate
    }
  }

  return { readTarget, preview, save, undo }
}

/** The guarded-writer surface the Agent Tooling handlers depend on. */
export type ConfigWriter = ReturnType<typeof createConfigWriter>

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
