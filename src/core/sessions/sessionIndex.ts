import type { Dirent } from 'node:fs'
import { readdir, readFile as fsReadFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionSummary, SessionTranscript } from '@common/domain'
import { parseSummary, parseTranscript } from './sessionParse'

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
}

/** The in-memory session index the IPC layer delegates to. */
export interface SessionIndex {
  /** Past sessions newest-activity-first; builds the cache on first call. */
  list(): Promise<SessionSummary[]>
  /** Re-scan from disk and return the fresh list. */
  refresh(): Promise<SessionSummary[]>
  /** The full transcript for one session id (builds the index first if needed). */
  getTranscript(id: string): Promise<SessionTranscript>
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

  // Null until the first build. `byId` maps a session id to its parsed summary (which carries the
  // filePath), so transcripts re-open the exact file the summary came from. `building` memoizes the
  // in-flight first build so a burst of cold-start calls (list + an immediate getTranscript) shares
  // one disk scan instead of each launching its own.
  let summaries: SessionSummary[] | null = null
  let byId = new Map<string, SessionSummary>()
  let building: Promise<SessionSummary[]> | null = null

  async function build(): Promise<SessionSummary[]> {
    const files = await readDir(projectsDir)
    const built: SessionSummary[] = []
    for (const filePath of files) {
      let content: string
      try {
        content = await readFile(filePath)
      } catch {
        // A file that disappears mid-scan is simply omitted from this build.
        continue
      }
      built.push(parseSummary(filePath, content.split(/\r?\n/)))
    }
    built.sort((a, b) => b.lastTimestamp - a.lastTimestamp)
    summaries = built
    byId = new Map(built.map((s) => [s.id, s]))
    return built
  }

  async function ensureBuilt(): Promise<SessionSummary[]> {
    if (summaries) return summaries
    if (!building) building = build().finally(() => (building = null))
    return building
  }

  return {
    async list() {
      return ensureBuilt()
    },

    async refresh() {
      return build()
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
    }
  }
}
