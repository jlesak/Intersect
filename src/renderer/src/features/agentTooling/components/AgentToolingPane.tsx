import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AdvancedEntry,
  AgentCatalogItem,
  AgentToolingScope,
  ConfigEdit,
  ConfigEditRequest,
  ConfigFileState,
  ConfigSource,
  EffectiveConfig,
  HookEntry,
  McpServerEntry,
  PermissionEntry,
  SkillCatalogItem
} from '@common/domain'
import { useProjectsStore, selectActiveProjects } from '@renderer/features/projects'
import { Dialog } from '@renderer/shared/ui/Dialog'
import { fuzzyFilter } from '../fuzzy'
import { useAgentToolingStore, type PendingPreview, type LastUndo } from '../store'
import * as api from '../ipc'

// Monaco is heavy; it must never load until an editor is actually opened, so both editor
// components are reached through lazy imports (the diff opens only with a pending preview, the
// raw editor only on the Advanced tab's raw mode).
const ConfigDiffEditor = lazy(() =>
  import('./ConfigDiffEditor').then((m) => ({ default: m.ConfigDiffEditor }))
)
const RawJsonEditor = lazy(() =>
  import('./RawJsonEditor').then((m) => ({ default: m.RawJsonEditor }))
)

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

/**
 * The file a structured edit writes to for a given scope: the scope's shared settings file
 * (`~/.claude/settings.json` for global, `<repo>/.claude/settings.json` for a project). Local
 * overrides and `.mcp.json` are reachable through the raw editor and the MCP target selector.
 */
function editTargetFor(scope: AgentToolingScope): ConfigSource {
  return scope.kind === 'global' ? 'global' : 'project'
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
 * The Agent Tooling settings pane: browse and edit the effective Claude Code configuration, plus a
 * read-only catalog of skills and agents. Reads the store and projects, wires the confirm dialog
 * and one-shot undo overlays, and delegates the read/edit surface to the presentational body.
 */
export function AgentToolingPane() {
  const status = useAgentToolingStore((s) => s.status)
  const error = useAgentToolingStore((s) => s.error)
  const scope = useAgentToolingStore((s) => s.scope)
  const config = useAgentToolingStore((s) => s.config)
  const skills = useAgentToolingStore((s) => s.skills)
  const agents = useAgentToolingStore((s) => s.agents)
  const pendingPreview = useAgentToolingStore((s) => s.pendingPreview)
  const saving = useAgentToolingStore((s) => s.saving)
  const lastUndo = useAgentToolingStore((s) => s.lastUndo)
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
    <>
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
        onEdit={(request) => void useAgentToolingStore.getState().preview(request)}
      />
      {pendingPreview && (
        <ConfirmSaveDialog
          pending={pendingPreview}
          saving={saving}
          onConfirm={() => void useAgentToolingStore.getState().commit()}
          onCancel={() => useAgentToolingStore.getState().cancelPreview()}
        />
      )}
      {lastUndo && (
        <UndoBanner
          last={lastUndo}
          saving={saving}
          onUndo={() => void useAgentToolingStore.getState().undo()}
          onDismiss={() => useAgentToolingStore.getState().dismissUndo()}
        />
      )}
    </>
  )
}

/**
 * The presentational Agent Tooling body: a header with the adapter + scope selectors (independent
 * of the app shell context), its own sub-navigation, and the read/edit content with accessible
 * loading / error / empty states. When `onEdit` is omitted the surface is strictly read-only, so
 * the body renders statically in tests; `initialTab` seeds the active sub-tab for the same reason.
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
  onReveal,
  onEdit,
  initialTab = 'overview'
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
  onEdit?: (request: ConfigEditRequest) => void
  initialTab?: AtTab
}) {
  const [tab, setTab] = useState<AtTab>(initialTab)
  const stripRef = useRef<HTMLDivElement>(null)

  const scopeValue = scope.kind === 'global' ? 'global' : `project:${scope.projectId}`
  const target = editTargetFor(scope)

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
        Browse and edit the effective Claude Code configuration. Every save is previewed, backed up,
        and can be undone once. Skills and agents are a read-only catalog.
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
            {tab === 'permissions' && (
              <PermissionsSection
                permissions={config.permissions}
                scope={scope}
                target={target}
                onEdit={onEdit}
              />
            )}
            {tab === 'hooks' && (
              <HooksSection hooks={config.hooks} scope={scope} target={target} onEdit={onEdit} />
            )}
            {tab === 'mcp' && (
              <McpSection servers={config.mcpServers} scope={scope} target={target} onEdit={onEdit} />
            )}
            {tab === 'skills' && <SkillsSection skills={skills} onReveal={onReveal} />}
            {tab === 'agents' && <AgentsSection agents={agents} onReveal={onReveal} />}
            {tab === 'advanced' && (
              <AdvancedSection
                advanced={config.advanced}
                scope={scope}
                target={target}
                onEdit={onEdit}
              />
            )}
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

/**
 * The one-line explanation shown above every editor: which file structured edits on this tab
 * land in, so the destination is never a surprise before the confirm dialog.
 */
function TargetNote({ target }: { target: ConfigSource }) {
  return (
    <div className="ix-at-targetnote">
      Edits write to the <strong>{SOURCE_LABELS[target]}</strong> settings file.
    </div>
  )
}

function PermissionsSection({
  permissions,
  scope,
  target,
  onEdit
}: {
  permissions: PermissionEntry[]
  scope: AgentToolingScope
  target: ConfigSource
  onEdit?: (request: ConfigEditRequest) => void
}) {
  const emit = (edit: ConfigEdit): void => onEdit?.({ scope, source: target, edit })
  return (
    <div className="ix-at-section">
      {onEdit && <TargetNote target={target} />}
      {onEdit && (
        <div className="ix-at-editrow">
          {(['allow', 'deny', 'ask'] as const).map((list) => (
            <PermissionAdd key={list} list={list} onAdd={(rule) => emit({ kind: 'permission', op: 'add', list, rule })} />
          ))}
        </div>
      )}
      {permissions.length === 0 ? (
        <EmptyState title="No permission rules" hint="No allow / deny / ask rules are configured for this scope." />
      ) : (
        <div className="ix-at-tablewrap">
          <table className="ix-at-table">
            <thead>
              <tr>
                <th>List</th>
                <th>Rule</th>
                <th>Source</th>
                {onEdit && <th aria-label="Actions" />}
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
                  {onEdit && (
                    <td className="ix-at-table__actions">
                      {p.source === target && (
                        <button
                          type="button"
                          className="ix-btn ix-btn--ghost ix-at-remove"
                          onClick={() => emit({ kind: 'permission', op: 'remove', list: p.list, rule: p.rule })}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function PermissionAdd({ list, onAdd }: { list: 'allow' | 'deny' | 'ask'; onAdd: (rule: string) => void }) {
  const [rule, setRule] = useState('')
  const add = (): void => {
    const trimmed = rule.trim()
    if (!trimmed) return
    onAdd(trimmed)
    setRule('')
  }
  return (
    <div className="ix-at-add">
      <span className={`ix-at-perm ix-at-perm--${list}`}>{list}</span>
      <input
        className="ix-input"
        placeholder="e.g. Bash(git status)"
        aria-label={`Add ${list} rule`}
        value={rule}
        onChange={(e) => setRule(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && add()}
      />
      <button type="button" className="ix-btn" onClick={add} disabled={rule.trim() === ''}>
        Add
      </button>
    </div>
  )
}

const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd'
]

function HooksSection({
  hooks,
  scope,
  target,
  onEdit
}: {
  hooks: HookEntry[]
  scope: AgentToolingScope
  target: ConfigSource
  onEdit?: (request: ConfigEditRequest) => void
}) {
  const emit = (edit: ConfigEdit): void => onEdit?.({ scope, source: target, edit })
  return (
    <div className="ix-at-section">
      {onEdit && <TargetNote target={target} />}
      {onEdit && <HookAdd onAdd={(e) => emit(e)} />}
      {hooks.length === 0 ? (
        <EmptyState title="No hooks" hint="No lifecycle hooks are configured for this scope." />
      ) : (
        <div className="ix-at-tablewrap">
          <table className="ix-at-table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Matcher</th>
                <th>Command</th>
                <th>Source</th>
                {onEdit && <th aria-label="Actions" />}
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
                  {onEdit && (
                    <td className="ix-at-table__actions">
                      {h.source === target && (
                        <button
                          type="button"
                          className="ix-btn ix-btn--ghost ix-at-remove"
                          onClick={() =>
                            emit({
                              kind: 'hook',
                              op: 'remove',
                              event: h.event,
                              matcher: h.matcher,
                              hookType: h.type,
                              command: h.command
                            })
                          }
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function HookAdd({ onAdd }: { onAdd: (edit: ConfigEdit) => void }) {
  const [event, setEvent] = useState(HOOK_EVENTS[0])
  const [matcher, setMatcher] = useState('')
  const [command, setCommand] = useState('')
  const add = (): void => {
    if (command.trim() === '') return
    onAdd({
      kind: 'hook',
      op: 'add',
      event,
      matcher: matcher.trim() === '' ? null : matcher.trim(),
      hookType: 'command',
      command: command.trim()
    })
    setMatcher('')
    setCommand('')
  }
  return (
    <div className="ix-at-add ix-at-add--wide">
      <select className="ix-input" aria-label="Hook event" value={event} onChange={(e) => setEvent(e.target.value)}>
        {HOOK_EVENTS.map((ev) => (
          <option key={ev} value={ev}>
            {ev}
          </option>
        ))}
      </select>
      <input
        className="ix-input"
        placeholder="matcher (optional)"
        aria-label="Hook matcher"
        value={matcher}
        onChange={(e) => setMatcher(e.target.value)}
      />
      <input
        className="ix-input"
        placeholder="command"
        aria-label="Hook command"
        value={command}
        onChange={(e) => setCommand(e.target.value)}
      />
      <button type="button" className="ix-btn" onClick={add} disabled={command.trim() === ''}>
        Add hook
      </button>
    </div>
  )
}

function McpSection({
  servers,
  scope,
  target,
  onEdit
}: {
  servers: McpServerEntry[]
  scope: AgentToolingScope
  target: ConfigSource
  onEdit?: (request: ConfigEditRequest) => void
}) {
  // In a project the same MCP server can live in the shared settings file or in the repo's
  // `.mcp.json`; the selector picks which file a structured MCP edit targets.
  const mcpTargets: ConfigSource[] = scope.kind === 'project' ? [target, 'mcp-file'] : [target]
  const [mcpTarget, setMcpTarget] = useState<ConfigSource>(target)
  const effectiveTarget = mcpTargets.includes(mcpTarget) ? mcpTarget : target
  const emit = (edit: ConfigEdit): void => onEdit?.({ scope, source: effectiveTarget, edit })
  return (
    <div className="ix-at-section">
      {onEdit && (
        <>
          <div className="ix-at-targetnote">
            Edits write to
            {mcpTargets.length > 1 ? (
              <select
                className="ix-input ix-at-inlineselect"
                aria-label="MCP target file"
                value={effectiveTarget}
                onChange={(e) => setMcpTarget(e.target.value as ConfigSource)}
              >
                {mcpTargets.map((t) => (
                  <option key={t} value={t}>
                    {SOURCE_LABELS[t]}
                  </option>
                ))}
              </select>
            ) : (
              <strong> {SOURCE_LABELS[effectiveTarget]}</strong>
            )}
            .
          </div>
          <McpAdd onAdd={(name, server) => emit({ kind: 'mcp', op: 'set', name, server })} />
        </>
      )}
      {servers.length === 0 ? (
        <EmptyState title="No MCP servers" hint="No MCP servers are configured for this scope." />
      ) : (
        <div className="ix-at-tablewrap">
          <table className="ix-at-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Transport</th>
                <th>Detail</th>
                <th>Source</th>
                {onEdit && <th aria-label="Actions" />}
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
                  {onEdit && (
                    <td className="ix-at-table__actions">
                      {s.source === effectiveTarget && (
                        <button
                          type="button"
                          className="ix-btn ix-btn--ghost ix-at-remove"
                          onClick={() => emit({ kind: 'mcp', op: 'remove', name: s.name, server: '' })}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function McpAdd({ onAdd }: { onAdd: (name: string, server: string) => void }) {
  const [name, setName] = useState('')
  const [server, setServer] = useState('')
  const add = (): void => {
    if (name.trim() === '' || server.trim() === '') return
    onAdd(name.trim(), server.trim())
    setName('')
    setServer('')
  }
  return (
    <div className="ix-at-add ix-at-add--wide">
      <input
        className="ix-input"
        placeholder="server name"
        aria-label="MCP server name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="ix-input ix-at-mono"
        placeholder='{"command":"npx","args":["-y","@modelcontextprotocol/server-x"]}'
        aria-label="MCP server body (JSON)"
        value={server}
        onChange={(e) => setServer(e.target.value)}
      />
      <button type="button" className="ix-btn" onClick={add} disabled={name.trim() === '' || server.trim() === ''}>
        Add / set
      </button>
    </div>
  )
}

function AdvancedSection({
  advanced,
  scope,
  target,
  onEdit
}: {
  advanced: AdvancedEntry[]
  scope: AgentToolingScope
  target: ConfigSource
  onEdit?: (request: ConfigEditRequest) => void
}) {
  const [rawOpen, setRawOpen] = useState(false)
  const emit = (edit: ConfigEdit): void => onEdit?.({ scope, source: target, edit })
  return (
    <div className="ix-at-section">
      {onEdit && (
        <>
          <TargetNote target={target} />
          <AdvancedAdd onAdd={(key, value) => emit({ kind: 'advanced', op: 'set', key, value })} />
          <div className="ix-at-rawtoggle">
            <button type="button" className="ix-btn ix-btn--ghost" onClick={() => setRawOpen((v) => !v)}>
              {rawOpen ? 'Close raw JSON editor' : 'Edit raw JSON…'}
            </button>
          </div>
          {rawOpen && <RawEditPanel scope={scope} onEdit={onEdit} />}
        </>
      )}
      {advanced.length === 0 ? (
        <EmptyState title="No advanced settings" hint="No other top-level settings are configured for this scope." />
      ) : (
        <div className="ix-at-tablewrap">
          <table className="ix-at-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Value</th>
                <th>Source</th>
                {onEdit && <th aria-label="Actions" />}
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
                  {onEdit && (
                    <td className="ix-at-table__actions">
                      {a.source === target && (
                        <button
                          type="button"
                          className="ix-btn ix-btn--ghost ix-at-remove"
                          onClick={() => emit({ kind: 'advanced', op: 'remove', key: a.key, value: '' })}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function AdvancedAdd({ onAdd }: { onAdd: (key: string, value: string) => void }) {
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const add = (): void => {
    if (key.trim() === '' || value.trim() === '') return
    onAdd(key.trim(), value.trim())
    setKey('')
    setValue('')
  }
  return (
    <div className="ix-at-add ix-at-add--wide">
      <input
        className="ix-input"
        placeholder="key (e.g. model)"
        aria-label="Advanced key"
        value={key}
        onChange={(e) => setKey(e.target.value)}
      />
      <input
        className="ix-input ix-at-mono"
        placeholder='value as JSON (e.g. "opus" or true)'
        aria-label="Advanced value (JSON)"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="button" className="ix-btn" onClick={add} disabled={key.trim() === '' || value.trim() === ''}>
        Set
      </button>
    </div>
  )
}

/**
 * The guarded raw-JSON editor for one target file: it reads the current bytes on open, hands
 * user-edited text back only through the preview -> confirm -> save pipeline, and reloads on
 * demand. A per-scope selector chooses which layered file to edit.
 */
function RawEditPanel({
  scope,
  onEdit
}: {
  scope: AgentToolingScope
  onEdit: (request: ConfigEditRequest) => void
}) {
  const sources: ConfigSource[] =
    scope.kind === 'global'
      ? ['global', 'global-local']
      : ['project', 'project-local', 'mcp-file']
  const [source, setSource] = useState<ConfigSource>(sources[0])
  const [content, setContent] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setLoadError(null)
    api
      .readRaw(scope, source)
      .then((view) => {
        if (!cancelled) setContent(view.content)
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [scope, source])

  const reload = (): void => {
    setContent(null)
    api
      .readRaw(scope, source)
      .then((view) => setContent(view.content))
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
  }

  return (
    <div className="ix-at-rawpanel">
      <label className="ix-at-scopebar__field">
        <span>File</span>
        <select
          className="ix-input ix-at-select"
          aria-label="Raw editor target file"
          value={source}
          onChange={(e) => setSource(e.target.value as ConfigSource)}
        >
          {sources.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABELS[s]}
            </option>
          ))}
        </select>
      </label>
      {loadError && <div className="ix-at-error">{loadError}</div>}
      {content !== null && (
        <Suspense fallback={<div className="ix-at-editorloading">Loading editor…</div>}>
          <RawJsonEditor
            initialContent={content}
            busy={false}
            onReload={reload}
            onPreview={(text) => onEdit({ scope, source, edit: { kind: 'raw', content: text } })}
          />
        </Suspense>
      )}
    </div>
  )
}

/**
 * The save-confirmation dialog: it names the exact target path, scope and provenance, flags a
 * global-scope write with a stronger warning, lists any validation errors, and shows the read-only
 * JSON diff of current versus proposed bytes. Confirm is disabled until the preview is valid.
 */
function ConfirmSaveDialog({
  pending,
  saving,
  onConfirm,
  onCancel
}: {
  pending: PendingPreview
  saving: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const { preview } = pending
  const actionWord = preview.exists ? 'Save' : 'Create'
  return (
    <Dialog
      title={preview.global ? 'Confirm change to GLOBAL config' : 'Confirm configuration change'}
      onClose={onCancel}
      actions={
        <>
          <button type="button" className="ix-btn ix-btn--ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className={`ix-btn ${preview.global ? 'ix-btn--danger' : 'ix-btn--primary'}`}
            onClick={onConfirm}
            disabled={!preview.valid || saving}
          >
            {saving ? 'Saving…' : `${actionWord}${preview.global ? ' to global' : ''}`}
          </button>
        </>
      }
    >
      <div className="ix-at-confirm">
        <div className="ix-at-confirm__meta">
          <div>
            <span className="ix-at-confirm__label">Target</span>
            <span className="ix-at-mono">{preview.path}</span>
          </div>
          <div>
            <span className="ix-at-confirm__label">Where</span>
            <span>{preview.provenance}</span>
          </div>
          {!preview.exists && (
            <div className="ix-at-confirm__create">This file does not exist yet and will be created.</div>
          )}
        </div>
        {preview.global && (
          <div className="ix-at-confirm__warn">
            This writes to your global Claude Code configuration and affects every project.
          </div>
        )}
        {preview.errors.length > 0 && (
          <ul className="ix-at-confirm__errors">
            {preview.errors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        )}
        {preview.valid && (
          <Suspense fallback={<div className="ix-at-editorloading">Loading diff…</div>}>
            <ConfigDiffEditor current={preview.currentContent} proposed={preview.proposedContent} />
          </Suspense>
        )}
      </div>
    </Dialog>
  )
}

/** The one-shot Undo affordance shown after a successful save, until used or dismissed. */
function UndoBanner({
  last,
  saving,
  onUndo,
  onDismiss
}: {
  last: LastUndo
  saving: boolean
  onUndo: () => void
  onDismiss: () => void
}) {
  return (
    <div className="ix-at-undo" role="status">
      <div className="ix-at-undo__text">
        Saved.
        {last.backupPath && <span className="ix-at-undo__backup"> Backup: {last.backupPath}</span>}
      </div>
      <div className="ix-at-undo__actions">
        <button type="button" className="ix-btn ix-btn--ghost" onClick={onUndo} disabled={saving}>
          Undo
        </button>
        <button type="button" className="ix-btn ix-btn--ghost" onClick={onDismiss} disabled={saving}>
          Dismiss
        </button>
      </div>
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
