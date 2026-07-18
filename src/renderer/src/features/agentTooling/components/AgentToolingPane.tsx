import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AdvancedEntry,
  AgentCatalogItem,
  AgentToolingScope,
  ConfigFileState,
  ConfigSource,
  EffectiveConfig,
  HookEntry,
  McpServerEntry,
  PermissionEntry,
  SkillCatalogItem
} from '@common/domain'
import { useProjectsStore, selectActiveProjects } from '@renderer/features/projects'
import { fuzzyFilter } from '../fuzzy'
import { useAgentToolingStore } from '../store'

type Status = 'idle' | 'loading' | 'ready' | 'error'

/** The Agent Tooling sub-navigation, in the fixed information-architecture order. */
const AT_TABS = [
  'overview',
  'permissions',
  'hooks',
  'mcp',
  'skills',
  'agents',
  'advanced'
] as const
type AtTab = (typeof AT_TABS)[number]

const TAB_LABELS: Record<AtTab, string> = {
  overview: 'Overview',
  permissions: 'Permissions',
  hooks: 'Hooks',
  mcp: 'MCP',
  skills: 'Skills',
  agents: 'Agents',
  advanced: 'Advanced'
}

/** Short human labels for each provenance source, shown as a badge on every effective row. */
const SOURCE_LABELS: Record<ConfigSource, string> = {
  global: 'global',
  'global-local': 'global · local',
  project: 'project',
  'project-local': 'project · local',
  'mcp-file': '.mcp.json',
  default: 'default'
}

/** A provenance badge: the layer an effective value came from. */
export function SourceBadge({ source }: { source: ConfigSource }) {
  return (
    <span className={`ix-at-badge ix-at-badge--${source}`} title={`Source: ${SOURCE_LABELS[source]}`}>
      {SOURCE_LABELS[source]}
    </span>
  )
}

/** The read-only "external / plugin-managed" marker on catalog items. */
function ExternalBadge() {
  return (
    <span className="ix-at-badge ix-at-badge--external" title="Plugin-managed - external, read-only">
      external
    </span>
  )
}

function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="ix-empty ix-at-empty">
      <div className="ix-empty__title">{title}</div>
      {hint && <div className="ix-empty__hint">{hint}</div>}
    </div>
  )
}

/**
 * The Agent Tooling settings pane: a read-only browser of the effective Claude Code configuration,
 * skills, and agents. Reads the store and projects, then delegates to the presentational body.
 * Nothing here writes - editing is out of scope.
 */
export function AgentToolingPane() {
  const status = useAgentToolingStore((s) => s.status)
  const error = useAgentToolingStore((s) => s.error)
  const scope = useAgentToolingStore((s) => s.scope)
  const config = useAgentToolingStore((s) => s.config)
  const skills = useAgentToolingStore((s) => s.skills)
  const agents = useAgentToolingStore((s) => s.agents)
  const projects = useProjectsStore(selectActiveProjects)

  useEffect(() => {
    void useProjectsStore.getState().load()
    void useAgentToolingStore.getState().load()
  }, [])

  const onScopeChange = (value: string): void => {
    if (value === 'global') useAgentToolingStore.getState().setScope({ kind: 'global' })
    else
      useAgentToolingStore
        .getState()
        .setScope({ kind: 'project', projectId: value.slice('project:'.length) })
  }

  return (
    <AgentToolingPaneBody
      status={status}
      error={error}
      scope={scope}
      config={config}
      skills={skills}
      agents={agents}
      projects={projects}
      onScopeChange={onScopeChange}
      onReveal={(path) => void useAgentToolingStore.getState().reveal(path)}
    />
  )
}

/**
 * The presentational Agent Tooling body: a header with the adapter + scope selectors (independent
 * of the app shell context), its own Overview / Permissions / Hooks / MCP / Skills / Agents /
 * Advanced sub-navigation, and the read-only content with accessible loading / error / empty
 * states. Stateless save for the active sub-tab, so it renders statically in tests.
 */
export function AgentToolingPaneBody({
  status,
  error,
  scope,
  config,
  skills,
  agents,
  projects,
  onScopeChange,
  onReveal
}: {
  status: Status
  error: string | null
  scope: AgentToolingScope
  config: EffectiveConfig | null
  skills: SkillCatalogItem[]
  agents: AgentCatalogItem[]
  projects: { id: string; name: string }[]
  onScopeChange: (value: string) => void
  onReveal: (path: string) => void
}) {
  const [tab, setTab] = useState<AtTab>('overview')
  const stripRef = useRef<HTMLDivElement>(null)

  const scopeValue = scope.kind === 'global' ? 'global' : `project:${scope.projectId}`

  const onStripKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const idx = AT_TABS.indexOf(tab)
    const next = AT_TABS[(idx + (e.key === 'ArrowRight' ? 1 : AT_TABS.length - 1)) % AT_TABS.length]
    setTab(next)
    stripRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus()
  }

  return (
    <>
      <div className="ix-settings__title">Agent Tooling</div>
      <div className="ix-at-hint ix-set-row__hint">
        Read-only view of the effective Claude Code configuration, skills, and agents. Editing is not
        part of this view.
      </div>

      <div className="ix-at-scopebar">
        <label className="ix-at-scopebar__field">
          <span>Adapter</span>
          <select className="ix-input ix-at-select" value="claude-code" disabled aria-label="Adapter">
            <option value="claude-code">Claude Code</option>
          </select>
        </label>
        <label className="ix-at-scopebar__field">
          <span>Scope</span>
          <select
            className="ix-input ix-at-select"
            value={scopeValue}
            aria-label="Scope"
            onChange={(e) => onScopeChange(e.target.value)}
          >
            <option value="global">Global (~/.claude)</option>
            {projects.map((p) => (
              <option key={p.id} value={`project:${p.id}`}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div
        className="ix-ctx__tabs ix-at-tabs"
        role="tablist"
        aria-label="Agent Tooling sections"
        ref={stripRef}
        onKeyDown={onStripKeyDown}
      >
        {AT_TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            data-tab={t}
            aria-selected={t === tab}
            tabIndex={t === tab ? 0 : -1}
            className={`ix-ctx__tab${t === tab ? ' ix-ctx__tab--active' : ''}`}
            onClick={() => setTab(t)}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      <div className="ix-at-body" role="tabpanel" aria-label={TAB_LABELS[tab]}>
        {status === 'loading' && <EmptyState title="Loading…" />}
        {status === 'error' && (
          <EmptyState title="Could not read the configuration" hint={error ?? undefined} />
        )}
        {status === 'ready' && config && (
          <>
            {tab === 'overview' && (
              <OverviewSection config={config} skillCount={skills.length} agentCount={agents.length} />
            )}
            {tab === 'permissions' && <PermissionsSection permissions={config.permissions} />}
            {tab === 'hooks' && <HooksSection hooks={config.hooks} />}
            {tab === 'mcp' && <McpSection servers={config.mcpServers} />}
            {tab === 'skills' && <SkillsSection skills={skills} onReveal={onReveal} />}
            {tab === 'agents' && <AgentsSection agents={agents} onReveal={onReveal} />}
            {tab === 'advanced' && <AdvancedSection advanced={config.advanced} />}
          </>
        )}
      </div>
    </>
  )
}

function OverviewSection({
  config,
  skillCount,
  agentCount
}: {
  config: EffectiveConfig
  skillCount: number
  agentCount: number
}) {
  const counts: { label: string; value: number }[] = [
    { label: 'Permissions', value: config.permissions.length },
    { label: 'Hooks', value: config.hooks.length },
    { label: 'MCP servers', value: config.mcpServers.length },
    { label: 'Skills', value: skillCount },
    { label: 'Agents', value: agentCount }
  ]
  return (
    <div className="ix-at-section">
      <div className="ix-at-counts">
        {counts.map((c) => (
          <div className="ix-at-count" key={c.label}>
            <div className="ix-at-count__value">{c.value}</div>
            <div className="ix-at-count__label">{c.label}</div>
          </div>
        ))}
      </div>

      <h3 className="ix-at-subhead">Configuration files</h3>
      <div className="ix-at-tablewrap">
        <table className="ix-at-table">
          <tbody>
            {config.files.map((file) => (
              <FileRow key={file.source} file={file} />
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="ix-at-subhead">Provenance legend</h3>
      <div className="ix-at-legend">
        {(Object.keys(SOURCE_LABELS) as ConfigSource[]).map((s) => (
          <SourceBadge key={s} source={s} />
        ))}
      </div>
    </div>
  )
}

function FileRow({ file }: { file: ConfigFileState }) {
  const state = file.error ? 'malformed' : file.exists ? 'present' : 'absent'
  const stateLabel = file.error ? 'error' : file.exists ? 'present' : 'not present'
  return (
    <tr>
      <td>
        <SourceBadge source={file.source} />
      </td>
      <td className="ix-at-table__path" title={file.path}>
        {file.path}
      </td>
      <td>
        <span className={`ix-at-filestate ix-at-filestate--${state}`}>{stateLabel}</span>
        {file.error && <span className="ix-at-error"> {file.error}</span>}
      </td>
    </tr>
  )
}

function PermissionsSection({ permissions }: { permissions: PermissionEntry[] }) {
  if (permissions.length === 0)
    return <EmptyState title="No permission rules" hint="No allow / deny / ask rules are configured for this scope." />
  return (
    <div className="ix-at-tablewrap">
      <table className="ix-at-table">
        <thead>
          <tr>
            <th>List</th>
            <th>Rule</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {permissions.map((p) => (
            <tr key={`${p.list}:${p.rule}`}>
              <td>
                <span className={`ix-at-perm ix-at-perm--${p.list}`}>{p.list}</span>
              </td>
              <td className="ix-at-mono">{p.rule}</td>
              <td>
                <SourceBadge source={p.source} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function HooksSection({ hooks }: { hooks: HookEntry[] }) {
  if (hooks.length === 0)
    return <EmptyState title="No hooks" hint="No lifecycle hooks are configured for this scope." />
  return (
    <div className="ix-at-tablewrap">
      <table className="ix-at-table">
        <thead>
          <tr>
            <th>Event</th>
            <th>Matcher</th>
            <th>Command</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {hooks.map((h, i) => (
            <tr key={`${h.event}:${h.matcher ?? ''}:${h.command}:${i}`}>
              <td>{h.event}</td>
              <td className="ix-at-mono">{h.matcher ?? '*'}</td>
              <td className="ix-at-mono ix-at-table__cmd">{h.command}</td>
              <td>
                <SourceBadge source={h.source} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function McpSection({ servers }: { servers: McpServerEntry[] }) {
  if (servers.length === 0)
    return <EmptyState title="No MCP servers" hint="No MCP servers are configured for this scope." />
  return (
    <div className="ix-at-tablewrap">
      <table className="ix-at-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Transport</th>
            <th>Detail</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {servers.map((s) => (
            <tr key={s.name}>
              <td>{s.name}</td>
              <td>{s.transport}</td>
              <td className="ix-at-mono ix-at-table__cmd">{s.detail}</td>
              <td>
                <SourceBadge source={s.source} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function AdvancedSection({ advanced }: { advanced: AdvancedEntry[] }) {
  if (advanced.length === 0)
    return <EmptyState title="No advanced settings" hint="No other top-level settings are configured for this scope." />
  return (
    <div className="ix-at-tablewrap">
      <table className="ix-at-table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {advanced.map((a) => (
            <tr key={a.key}>
              <td className="ix-at-mono">{a.key}</td>
              <td className="ix-at-mono ix-at-table__cmd">{a.value}</td>
              <td>
                <SourceBadge source={a.source} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The searchable skills catalog. */
function SkillsSection({
  skills,
  onReveal
}: {
  skills: SkillCatalogItem[]
  onReveal: (path: string) => void
}) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(
    () => fuzzyFilter(query, skills, (s) => [s.name, s.description, s.source.label]),
    [query, skills]
  )
  return (
    <CatalogList
      query={query}
      onQuery={setQuery}
      searchLabel="Search skills"
      count={skills.length}
      results={filtered}
      onReveal={onReveal}
      emptyAll="No skills discovered for this scope."
      renderItem={(s) => (
        <>
          <div className="ix-at-item__head">
            <span className="ix-at-item__name">{s.name}</span>
            <span className={`ix-at-badge ix-at-badge--src-${s.source.kind}`}>{s.source.label}</span>
            {s.external && <ExternalBadge />}
          </div>
          {s.description && <div className="ix-at-item__desc">{s.description}</div>}
        </>
      )}
      keyOf={(s) => `${s.source.kind}:${s.source.label}:${s.name}`}
      pathOf={(s) => s.path}
    />
  )
}

/** The searchable agents catalog. */
function AgentsSection({
  agents,
  onReveal
}: {
  agents: AgentCatalogItem[]
  onReveal: (path: string) => void
}) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(
    () => fuzzyFilter(query, agents, (a) => [a.name, a.description, a.source.label, a.tools]),
    [query, agents]
  )
  return (
    <CatalogList
      query={query}
      onQuery={setQuery}
      searchLabel="Search agents"
      count={agents.length}
      results={filtered}
      onReveal={onReveal}
      emptyAll="No agents discovered for this scope."
      renderItem={(a) => (
        <>
          <div className="ix-at-item__head">
            <span className="ix-at-item__name">{a.name}</span>
            <span className={`ix-at-badge ix-at-badge--src-${a.source.kind}`}>{a.source.label}</span>
            {a.model && <span className="ix-at-item__meta">model: {a.model}</span>}
            {a.external && <ExternalBadge />}
          </div>
          {a.description && <div className="ix-at-item__desc">{a.description}</div>}
          {a.tools && <div className="ix-at-item__tools">tools: {a.tools}</div>}
        </>
      )}
      keyOf={(a) => `${a.source.kind}:${a.source.label}:${a.name}`}
      pathOf={(a) => a.path}
    />
  )
}

/** Shared searchable catalog shell: a search box over a keyboard-free list with a reveal action. */
function CatalogList<T>({
  query,
  onQuery,
  searchLabel,
  count,
  results,
  emptyAll,
  renderItem,
  keyOf,
  pathOf,
  onReveal
}: {
  query: string
  onQuery: (value: string) => void
  searchLabel: string
  count: number
  results: T[]
  emptyAll: string
  renderItem: (item: T) => React.ReactNode
  keyOf: (item: T) => string
  pathOf: (item: T) => string
  onReveal: (path: string) => void
}) {
  if (count === 0) return <EmptyState title={emptyAll} />
  return (
    <div className="ix-at-catalog">
      <input
        className="ix-input ix-at-search"
        placeholder={`${searchLabel}…`}
        value={query}
        aria-label={searchLabel}
        role="searchbox"
        onChange={(e) => onQuery(e.target.value)}
      />
      {results.length === 0 ? (
        <div className="ix-at-catalog__empty">No matches</div>
      ) : (
        <ul className="ix-at-list" aria-label={searchLabel}>
          {results.map((item) => (
            <li key={keyOf(item)} className="ix-at-item">
              <div className="ix-at-item__body">{renderItem(item)}</div>
              <button
                type="button"
                className="ix-btn ix-btn--ghost ix-at-item__reveal"
                title={pathOf(item)}
                onClick={() => onReveal(pathOf(item))}
              >
                Open source file
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
