import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import type {
  AdvancedEntry,
  AgentCatalogItem,
  CatalogSource,
  ConfigFileState,
  ConfigSource,
  EffectiveConfig,
  HookEntry,
  McpServerEntry,
  PermissionEntry,
  SkillCatalogItem
} from '@common/domain'
import { readFrontmatterField, splitFrontmatter } from './frontmatter'
import { defaultConfigFs, type ConfigFs } from './configFs'

/**
 * The scope a read resolves against, already translated from a Project id to its canonical
 * repository roots. Global scope layers the user's own settings; project scope gates every
 * project-level file access against these roots.
 */
export type ResolvedScope = { kind: 'global' } | { kind: 'project'; repoRoots: string[] }

export interface ClaudeConfigReaderDeps {
  /** The Claude home directory. Defaults to `INTERSECT_CLAUDE_HOME` then `~/.claude`. */
  claudeHome?: string
  fs?: ConfigFs
}

/** A settings document, once parsed - an object of unknown-typed top-level keys. */
type SettingsDoc = Record<string, unknown>

/** A settings layer resolved to its file, plus the root it must stay contained under (project only). */
interface LayerSpec {
  source: ConfigSource
  path: string
  /** Non-null for project layers: the canonical repo root the file's realpath must resolve inside. */
  containRoot: string | null
}

/** The outcome of loading one layer: its on-disk diagnostic plus the parsed document (or null). */
interface LayerLoad {
  state: ConfigFileState
  doc: SettingsDoc | null
}

const SETTINGS_FILE = 'settings.json'
const SETTINGS_LOCAL_FILE = 'settings.local.json'
const MCP_FILE = '.mcp.json'

/** Whether `target` is the root itself or lies beneath it, both already canonical. */
function isContained(target: string, root: string): boolean {
  return target === root || target.startsWith(root + sep)
}

/**
 * The read-only reader over the effective Claude Code configuration, skills, and agents. Pure and
 * dependency-averse: every disk touch goes through the injected {@link ConfigFs}, and no method
 * ever writes - reading a missing file never creates it. Malformed layers and markdown degrade to
 * per-item diagnostics rather than failing the whole result.
 */
export function createClaudeConfigReader(deps: ClaudeConfigReaderDeps = {}) {
  const fs = deps.fs ?? defaultConfigFs
  const claudeHome =
    deps.claudeHome ?? process.env.INTERSECT_CLAUDE_HOME ?? join(homedir(), '.claude')

  /**
   * Load one settings layer. A project layer whose file resolves outside its root fails closed:
   * it is reported blocked and never read. A missing file is not an error (and never created).
   */
  function loadLayer(spec: LayerSpec): LayerLoad {
    const real = fs.realpath(spec.path)
    if (real === null) {
      return { state: { source: spec.source, path: spec.path, exists: false, error: null }, doc: null }
    }
    if (spec.containRoot !== null) {
      const rootReal = fs.realpath(spec.containRoot)
      if (rootReal === null || !isContained(real, rootReal)) {
        return {
          state: {
            source: spec.source,
            path: spec.path,
            exists: false,
            error: 'Blocked: path resolves outside the project root'
          },
          doc: null
        }
      }
    }
    const content = fs.readFile(spec.path)
    if (content === null) {
      return {
        state: { source: spec.source, path: spec.path, exists: true, error: 'Could not read file' },
        doc: null
      }
    }
    if (content.trim() === '') {
      return { state: { source: spec.source, path: spec.path, exists: true, error: null }, doc: {} }
    }
    try {
      const parsed = JSON.parse(content) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          state: { source: spec.source, path: spec.path, exists: true, error: 'Not a JSON object' },
          doc: null
        }
      }
      return {
        state: { source: spec.source, path: spec.path, exists: true, error: null },
        doc: parsed as SettingsDoc
      }
    } catch (err) {
      return {
        state: {
          source: spec.source,
          path: spec.path,
          exists: true,
          error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`
        },
        doc: null
      }
    }
  }

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

  function getEffectiveConfig(scope: ResolvedScope): Omit<EffectiveConfig, 'scope' | 'adapter'> {
    const layers = settingsLayers(scope)
    const loads = layers.map((spec) => ({ spec, load: loadLayer(spec) }))
    const mcpSpec = mcpFileSpec(scope)
    const mcpLoad = mcpSpec ? loadLayer(mcpSpec) : null

    const files: ConfigFileState[] = loads.map((l) => l.load.state)
    if (mcpLoad) files.push(mcpLoad.state)

    return {
      files,
      permissions: resolvePermissions(loads),
      hooks: resolveHooks(loads),
      mcpServers: resolveMcp(loads, mcpLoad),
      advanced: resolveAdvanced(loads)
    }
  }

  function listSkills(scope: ResolvedScope): SkillCatalogItem[] {
    const items: SkillCatalogItem[] = []
    const seen = new Set<string>()

    const pushSkill = (dirPath: string, name: string, source: CatalogSource, external: boolean): void => {
      const skillMd = join(dirPath, name, 'SKILL.md')
      const key = `${source.kind}:${source.label}:${name}`
      if (seen.has(key)) return
      const raw = fs.readFile(skillMd)
      const description = raw === null ? '' : readFrontmatterField(splitFrontmatter(raw).frontmatter, 'description')
      seen.add(key)
      items.push({ name, source, path: skillMd, description, external })
    }

    // User skills.
    walkSkillDirs(join(claudeHome, 'skills'), null, (name, dir) =>
      pushSkill(dir, name, { kind: 'user', label: 'User' }, false)
    )

    // Project skills (project scope only), each containment-checked against its repo root.
    if (scope.kind === 'project') {
      for (const root of scope.repoRoots) {
        walkSkillDirs(join(root, '.claude', 'skills'), root, (name, dir) =>
          pushSkill(dir, name, { kind: 'project', label: 'Project' }, false)
        )
      }
    }

    // Plugin skills.
    for (const plugin of pluginInstalls()) {
      walkSkillDirs(join(plugin.installPath, 'skills'), null, (name, dir) =>
        pushSkill(dir, name, { kind: 'plugin', label: plugin.pluginId }, true)
      )
    }

    return sortCatalog(items)
  }

  function listAgents(scope: ResolvedScope): AgentCatalogItem[] {
    const items: AgentCatalogItem[] = []
    const seen = new Set<string>()

    const pushAgent = (filePath: string, name: string, source: CatalogSource, external: boolean): void => {
      const key = `${source.kind}:${source.label}:${name}`
      if (seen.has(key)) return
      const raw = fs.readFile(filePath)
      const fm = raw === null ? '' : splitFrontmatter(raw).frontmatter
      seen.add(key)
      items.push({
        name,
        source,
        path: filePath,
        description: readFrontmatterField(fm, 'description'),
        model: readFrontmatterField(fm, 'model'),
        tools: readFrontmatterField(fm, 'tools'),
        external
      })
    }

    walkAgentFiles(join(claudeHome, 'agents'), null, (name, file) =>
      pushAgent(file, name, { kind: 'user', label: 'User' }, false)
    )

    if (scope.kind === 'project') {
      for (const root of scope.repoRoots) {
        walkAgentFiles(join(root, '.claude', 'agents'), root, (name, file) =>
          pushAgent(file, name, { kind: 'project', label: 'Project' }, false)
        )
      }
    }

    for (const plugin of pluginInstalls()) {
      walkAgentFiles(join(plugin.installPath, 'agents'), null, (name, file) =>
        pushAgent(file, name, { kind: 'plugin', label: plugin.pluginId }, true)
      )
    }

    return sortCatalog(items)
  }

  /**
   * Enumerate `<dir>/<name>/` directories that hold a `SKILL.md`. When `containRoot` is set, the
   * SKILL.md must realpath-resolve inside it, so a symlinked skill escaping the project is skipped.
   */
  function walkSkillDirs(
    dir: string,
    containRoot: string | null,
    onSkill: (name: string, dir: string) => void
  ): void {
    const entries = fs.readDir(dir)
    if (entries === null) return
    for (const entry of entries) {
      if (!entry.isDirectory) continue
      const skillMd = join(dir, entry.name, 'SKILL.md')
      const real = fs.realpath(skillMd)
      if (real === null) continue
      if (containRoot !== null) {
        const rootReal = fs.realpath(containRoot)
        if (rootReal === null || !isContained(real, rootReal)) continue
      }
      onSkill(entry.name, dir)
    }
  }

  /** Enumerate flat `<dir>/<name>.md` agent files, with the same containment guard as skills. */
  function walkAgentFiles(
    dir: string,
    containRoot: string | null,
    onAgent: (name: string, file: string) => void
  ): void {
    const entries = fs.readDir(dir)
    if (entries === null) return
    for (const entry of entries) {
      if (!entry.isFile || !entry.name.endsWith('.md')) continue
      const file = join(dir, entry.name)
      const real = fs.realpath(file)
      if (real === null) continue
      if (containRoot !== null) {
        const rootReal = fs.realpath(containRoot)
        if (rootReal === null || !isContained(real, rootReal)) continue
      }
      onAgent(entry.name.slice(0, -3), file)
    }
  }

  /**
   * The installed plugins, from `~/.claude/plugins/installed_plugins.json`. A malformed or missing
   * index yields no plugins (user/project items are unaffected) rather than throwing.
   */
  function pluginInstalls(): { pluginId: string; installPath: string }[] {
    const raw = fs.readFile(join(claudeHome, 'plugins', 'installed_plugins.json'))
    if (raw === null) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return []
    }
    if (parsed === null || typeof parsed !== 'object') return []
    const plugins = (parsed as { plugins?: unknown }).plugins
    if (plugins === null || typeof plugins !== 'object') return []
    const result: { pluginId: string; installPath: string }[] = []
    for (const [pluginId, installs] of Object.entries(plugins as Record<string, unknown>)) {
      if (!Array.isArray(installs)) continue
      for (const install of installs) {
        const installPath = (install as { installPath?: unknown })?.installPath
        if (typeof installPath !== 'string' || installPath === '') continue
        if (fs.realpath(installPath) === null) continue
        result.push({ pluginId, installPath })
      }
    }
    return result
  }

  return { getEffectiveConfig, listSkills, listAgents }
}

/** The read-only Claude config reader surface the Agent Tooling slice depends on. */
export type ClaudeConfigReader = ReturnType<typeof createClaudeConfigReader>

// --- Pure resolution of the effective values from the loaded layers -------------------------

type LoadedLayer = { spec: LayerSpec; load: LayerLoad }

/** Permission rules across layers, deduped so the highest-precedence layer owns the provenance. */
function resolvePermissions(loads: LoadedLayer[]): PermissionEntry[] {
  const lists: PermissionEntry['list'][] = ['allow', 'deny', 'ask']
  const bySource = new Map<string, ConfigSource>()
  for (const { spec, load } of loads) {
    const perms = load.doc?.permissions
    if (perms === null || typeof perms !== 'object') continue
    for (const list of lists) {
      const rules = (perms as Record<string, unknown>)[list]
      if (!Array.isArray(rules)) continue
      for (const rule of rules) {
        if (typeof rule !== 'string') continue
        bySource.set(`${list} ${rule}`, spec.source)
      }
    }
  }
  const entries: PermissionEntry[] = []
  for (const [key, source] of bySource) {
    const sep = key.indexOf(' ')
    entries.push({
      list: key.slice(0, sep) as PermissionEntry['list'],
      rule: key.slice(sep + 1),
      source
    })
  }
  const order: Record<PermissionEntry['list'], number> = { allow: 0, deny: 1, ask: 2 }
  return entries.sort((a, b) => order[a.list] - order[b.list] || a.rule.localeCompare(b.rule))
}

/** Hook commands across layers, deduped by (event, matcher, type, command), highest wins. */
function resolveHooks(loads: LoadedLayer[]): HookEntry[] {
  const bySource = new Map<string, HookEntry>()
  for (const { spec, load } of loads) {
    const hooks = load.doc?.hooks
    if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) continue
    for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
      if (!Array.isArray(groups)) continue
      for (const group of groups) {
        const matcher = (group as { matcher?: unknown })?.matcher
        const inner = (group as { hooks?: unknown })?.hooks
        if (!Array.isArray(inner)) continue
        for (const h of inner) {
          const type = (h as { type?: unknown })?.type
          const command = (h as { command?: unknown })?.command
          const entry: HookEntry = {
            event,
            matcher: typeof matcher === 'string' && matcher !== '' ? matcher : null,
            type: typeof type === 'string' ? type : 'command',
            command: typeof command === 'string' ? command : '',
            source: spec.source
          }
          bySource.set(`${entry.event} ${entry.matcher ?? ''} ${entry.type} ${entry.command}`, entry)
        }
      }
    }
  }
  return [...bySource.values()].sort(
    (a, b) =>
      a.event.localeCompare(b.event) ||
      (a.matcher ?? '').localeCompare(b.matcher ?? '') ||
      a.command.localeCompare(b.command)
  )
}

/** Extract the server map from a settings-style doc (its `mcpServers` object). */
function serversFromSettings(doc: SettingsDoc | null): Record<string, unknown> {
  const servers = doc?.mcpServers
  return servers !== null && typeof servers === 'object' && !Array.isArray(servers)
    ? (servers as Record<string, unknown>)
    : {}
}

/** Extract the server map from a `.mcp.json` doc (its `mcpServers`, or the doc itself as a map). */
function serversFromMcpFile(doc: SettingsDoc | null): Record<string, unknown> {
  if (doc === null) return {}
  const nested = doc.mcpServers
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested as Record<string, unknown>
  }
  return doc
}

/** MCP servers merged by name across settings layers and the project `.mcp.json`, last wins. */
function resolveMcp(loads: LoadedLayer[], mcpLoad: LayerLoad | null): McpServerEntry[] {
  const byName = new Map<string, McpServerEntry>()
  const apply = (servers: Record<string, unknown>, source: ConfigSource): void => {
    for (const [name, raw] of Object.entries(servers)) {
      if (raw === null || typeof raw !== 'object') continue
      const server = raw as Record<string, unknown>
      const url = typeof server.url === 'string' ? server.url : null
      const command = typeof server.command === 'string' ? server.command : null
      const args = Array.isArray(server.args) ? server.args.filter((a) => typeof a === 'string') : []
      const transport =
        typeof server.type === 'string' && server.type !== '' ? server.type : url ? 'http' : 'stdio'
      const detail = url ?? [command, ...args].filter(Boolean).join(' ')
      byName.set(name, { name, transport, detail, source })
    }
  }
  // global < global-local < project < mcp-file < project-local, filtered to the present layers.
  const order: ConfigSource[] = ['global', 'global-local', 'project', 'mcp-file', 'project-local']
  const settingsBySource = new Map<ConfigSource, SettingsDoc | null>()
  for (const { spec, load } of loads) settingsBySource.set(spec.source, load.doc)
  for (const source of order) {
    if (source === 'mcp-file') {
      if (mcpLoad) apply(serversFromMcpFile(mcpLoad.doc), 'mcp-file')
      continue
    }
    if (settingsBySource.has(source)) apply(serversFromSettings(settingsBySource.get(source)!), source)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Every top-level settings key except permissions/hooks/mcpServers, highest-precedence layer wins. */
function resolveAdvanced(loads: LoadedLayer[]): AdvancedEntry[] {
  const excluded = new Set(['permissions', 'hooks', 'mcpServers'])
  const byKey = new Map<string, AdvancedEntry>()
  for (const { spec, load } of loads) {
    if (load.doc === null) continue
    for (const [key, value] of Object.entries(load.doc)) {
      if (excluded.has(key)) continue
      byKey.set(key, { key, value: JSON.stringify(value), source: spec.source })
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key))
}

/** Stable catalog order: user first, then project, then plugins (by label), then item name. */
function sortCatalog<T extends { name: string; source: CatalogSource }>(items: T[]): T[] {
  const rank: Record<CatalogSource['kind'], number> = { user: 0, project: 1, plugin: 2 }
  return items.sort(
    (a, b) =>
      rank[a.source.kind] - rank[b.source.kind] ||
      a.source.label.localeCompare(b.source.label) ||
      a.name.localeCompare(b.name)
  )
}
