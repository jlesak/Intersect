import { join, sep } from 'node:path'
import type { ConfigSource } from '@common/domain'
import type { ConfigFs } from './configFs'

/** The user-global settings file, and its machine-local override sibling. */
export const SETTINGS_FILE = 'settings.json'
export const SETTINGS_LOCAL_FILE = 'settings.local.json'
/** The project MCP registry, which lives at the repository root (not under `.claude/`). */
export const MCP_FILE = '.mcp.json'

/**
 * The scope a read or write resolves against, already translated from a Project id to its
 * canonical repository roots. Global scope layers the user's own settings; project scope gates
 * every project-level file access against these roots.
 */
export type ResolvedScope = { kind: 'global' } | { kind: 'project'; repoRoots: string[] }

/** A settings layer resolved to its file, plus the root it must stay contained under (project only). */
export interface LayerSpec {
  source: ConfigSource
  path: string
  /** Non-null for project layers: the canonical repo root the file's realpath must resolve inside. */
  containRoot: string | null
}

/** The write target for a mutation: its absolute path and the root it must stay contained under. */
export interface WriteTarget {
  source: ConfigSource
  path: string
  /** Non-null for project-scoped files; null for global-scoped files (no containment gate). */
  containRoot: string | null
}

/** Whether `target` is the root itself or lies beneath it, both already canonical. */
export function isContained(target: string, root: string): boolean {
  return target === root || target.startsWith(root + sep)
}

/**
 * The shared path resolver over the injected {@link ConfigFs}. Both the read-only reader and the
 * writer resolve layer files, the first project file that materializes, and a single write
 * target through this one module, so containment and file-location rules never drift between the
 * two sides.
 */
export function createConfigPaths(deps: { fs: ConfigFs; claudeHome: string }) {
  const { fs, claudeHome } = deps

  /**
   * For a project-level relative file, the first repo root that has it (contained or not, so an
   * escaping symlink still surfaces as blocked), falling back to the first root's missing path.
   */
  function pickProjectFile(repoRoots: string[], relPath: string): { path: string; containRoot: string } {
    for (const root of repoRoots) {
      const candidate = join(root, '.claude', relPath)
      if (fs.realpath(candidate) !== null) return { path: candidate, containRoot: root }
    }
    return { path: join(repoRoots[0], '.claude', relPath), containRoot: repoRoots[0] }
  }

  /** The ordered settings layers (low to high precedence) that apply to the scope. */
  function settingsLayers(scope: ResolvedScope): LayerSpec[] {
    if (scope.kind === 'global') {
      return [
        { source: 'global', path: join(claudeHome, SETTINGS_FILE), containRoot: null },
        { source: 'global-local', path: join(claudeHome, SETTINGS_LOCAL_FILE), containRoot: null }
      ]
    }
    const project = pickProjectFile(scope.repoRoots, SETTINGS_FILE)
    const projectLocal = pickProjectFile(scope.repoRoots, SETTINGS_LOCAL_FILE)
    return [
      { source: 'global', path: join(claudeHome, SETTINGS_FILE), containRoot: null },
      { source: 'project', path: project.path, containRoot: project.containRoot },
      { source: 'project-local', path: projectLocal.path, containRoot: projectLocal.containRoot }
    ]
  }

  /** The project `.mcp.json` layer spec, or null in global scope. */
  function mcpFileSpec(scope: ResolvedScope): LayerSpec | null {
    if (scope.kind === 'global') return null
    // .mcp.json lives at the repo root, not under .claude/.
    for (const root of scope.repoRoots) {
      const candidate = join(root, MCP_FILE)
      if (fs.realpath(candidate) !== null)
        return { source: 'mcp-file', path: candidate, containRoot: root }
    }
    return { source: 'mcp-file', path: join(scope.repoRoots[0], MCP_FILE), containRoot: scope.repoRoots[0] }
  }

  /**
   * The single file a mutation of `source` targets in this scope, with the containment root it
   * must stay under. Rejects a source that cannot exist in the scope (a project file in global
   * scope, or a global-local file in a project) so a mismatched request never resolves to a path.
   */
  function resolveWriteTarget(scope: ResolvedScope, source: ConfigSource): WriteTarget {
    if (scope.kind === 'global') {
      if (source === 'global')
        return { source, path: join(claudeHome, SETTINGS_FILE), containRoot: null }
      if (source === 'global-local')
        return { source, path: join(claudeHome, SETTINGS_LOCAL_FILE), containRoot: null }
      throw new Error(`Source '${source}' is not writable in global scope`)
    }
    if (source === 'global')
      return { source, path: join(claudeHome, SETTINGS_FILE), containRoot: null }
    if (source === 'project') {
      const f = pickProjectFile(scope.repoRoots, SETTINGS_FILE)
      return { source, path: f.path, containRoot: f.containRoot }
    }
    if (source === 'project-local') {
      const f = pickProjectFile(scope.repoRoots, SETTINGS_LOCAL_FILE)
      return { source, path: f.path, containRoot: f.containRoot }
    }
    if (source === 'mcp-file') {
      const spec = mcpFileSpec(scope)!
      return { source, path: spec.path, containRoot: spec.containRoot }
    }
    throw new Error(`Source '${source}' is not a writable target`)
  }

  return { pickProjectFile, settingsLayers, mcpFileSpec, resolveWriteTarget }
}

export type ConfigPaths = ReturnType<typeof createConfigPaths>
