import type { Dirent } from 'node:fs'
import { access, readdir, readFile as fsReadFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionSummary, SessionTranscript } from '@common/domain'
import { parseSession, parseTranscript, type ParsedSession } from './sessionParse'

/**
 * Filesystem seams for the session index. Each is injectable so tests exercise the caching and
 * sorting logic without touching the real disk; the defaults read `~/.claude/projects`.
 */
export interface SessionIndexOptions {
  /**
   * Root of the Claude Code project transcripts. Defaults to `INTERSECT_CLAUDE_PROJECTS_DIR`
   * (for E2E fixtures) or `~/.claude/projects`.
   */
  projectsDir?: string
  /** List every session `.jsonl` file (absolute paths) across the project subdirectories. */
  readDir?: (dir: string) => Promise<string[]>
  /** Read a session file's full UTF-8 contents. */
  readFile?: (path: string) => Promise<string>
  /** Probe current transcript readability without loading the whole file. */
  canReadFile?: (path: string) => Promise<boolean>
}

/** The in-memory session index the IPC layer delegates to. */
export interface SessionIndex {
  /** Past sessions newest-activity-first; builds the cache on first call. */
  list(): Promise<SessionSummary[]>
  /** Fresh raw activity, kept internal to the core. Concurrent scans share one build. */
  scan(): Promise<ParsedSession[]>
  /** Re-scan from disk and return the fresh list. */
  refresh(): Promise<SessionSummary[]>
  /** The full transcript for one session id (builds the index first if needed). */
  getTranscript(id: string): Promise<SessionTranscript>
  /** Whether an indexed session still has a readable transcript. */
  isResumable(id: string): Promise<boolean>
}

/**
 * Default projects directory: the E2E fixture override wins, else the standard Claude Code location.
 */
function defaultProjectsDir(): string {
  return process.env.INTERSECT_CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects')
}

/**
 * Default file listing: glob `<projectsDir>/<subdir>/*.jsonl` one level deep, matching the
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` layout. A missing root yields an empty list
 * rather than an error, so an absent projects directory is not fatal.
 */
async function defaultReadDir(dir: string): Promise<string[]> {
  let subdirs: Dirent[]
  try {
    subdirs = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of subdirs) {
    if (!entry.isDirectory()) continue
    const sub = join(dir, entry.name)
    let names: string[]
    try {
      names = await readdir(sub)
    } catch {
      continue
    }
    for (const name of names) {
      if (name.endsWith('.jsonl')) files.push(join(sub, name))
    }
  }
  return files
}

function defaultReadFile(path: string): Promise<string> {
  return fsReadFile(path, 'utf8')
}

export function createSessionIndex(opts: SessionIndexOptions = {}): SessionIndex {
  const projectsDir = opts.projectsDir ?? defaultProjectsDir()
  const readDir = opts.readDir ?? defaultReadDir
  const readFile = opts.readFile ?? defaultReadFile
  const canReadFile = opts.canReadFile ?? (async (path: string) => {
    try {
      await access(path, constants.R_OK)
      return true
    } catch {
      return false
    }
  })

  // Null until the first build. `byId` maps a session id to its parsed summary (which carries the
  // filePath), so transcripts re-open the exact file the summary came from. `building` memoizes the
  // in-flight first build so a burst of cold-start calls (list + an immediate getTranscript) shares
  // one disk scan instead of each launching its own.
  let summaries: SessionSummary[] | null = null
  let byId = new Map<string, SessionSummary>()
  let building: Promise<ParsedSession[]> | null = null

  async function build(): Promise<ParsedSession[]> {
    const files = await readDir(projectsDir)
    const built: ParsedSession[] = []
    for (const filePath of files) {
      let content: string
      try {
        content = await readFile(filePath)
      } catch {
        // A file that disappears mid-scan is simply omitted from this build.
        continue
      }
      built.push(parseSession(filePath, content.split(/\r?\n/)))
    }
    built.sort((a, b) => b.summary.lastTimestamp - a.summary.lastTimestamp)
    summaries = built.map(s => s.summary)
    byId = new Map(summaries.map((s) => [s.id, s]))
    return built
  }

  function scan(): Promise<ParsedSession[]> {
    if (!building) building = build().finally(() => (building = null))
    return building
  }

  async function ensureBuilt(): Promise<SessionSummary[]> {
    if (building) {
      await building
      return summaries!
    }
    if (summaries) return summaries
    await scan()
    return summaries!
  }

  return {
    scan,
    async list() {
      return ensureBuilt()
    },

    async refresh() {
      await scan()
      return summaries!
    },

    async getTranscript(id) {
      await ensureBuilt()
      const summary = byId.get(id)
      if (!summary) throw new Error(`Unknown session: ${id}`)
      let content: string
      try {
        content = await readFile(summary.filePath)
      } catch {
        throw new Error(`Session file no longer available: ${id}`)
      }
      return parseTranscript(id, summary.title, summary.cwd, content.split(/\r?\n/))
    },

    async isResumable(id) {
      await ensureBuilt()
      const path = byId.get(id)?.filePath
      return path ? canReadFile(path) : false
    }
  }
}
