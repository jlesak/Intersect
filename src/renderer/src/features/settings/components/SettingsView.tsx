import { useEffect, useState, type ComponentType, type ReactNode } from 'react'
import {
  DEFAULT_PR_REVIEW_MODEL,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  type AdoSettings,
  type NotificationSettings
} from '@common/domain'
import { formatAccelerator, SHORTCUT_ACTIONS } from '@common/shortcuts'
import { ProjectsPane } from '@renderer/features/projects'
import { AgentToolingPane, selectHasRawDraft, useAgentToolingStore } from '@renderer/features/agentTooling'
import { ErrorBoundary } from '@renderer/shared/ui/ErrorBoundary'
import { useSettingsStore } from '../store'

const CATEGORIES = [
  { id: 'projects', label: 'Projekty' },
  { id: 'agentTooling', label: 'Agent Tooling' },
  { id: 'notif', label: 'Notifikace' },
  { id: 'ado', label: 'Azure DevOps' },
  { id: 'review', label: 'PR Review' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'keys', label: 'Klávesové zkratky' },
  { id: 'appearance', label: 'Vzhled' }
] as const

type CategoryId = (typeof CATEGORIES)[number]['id']

/**
 * The pane each category owns. Only the selected one is ever mounted, so a category the user
 * never opens costs nothing - which matters most for Agent Tooling, whose first render reads the
 * whole Claude Code configuration off disk.
 */
const PANES: Record<CategoryId, ComponentType> = {
  projects: ProjectsPane,
  agentTooling: AgentToolingPane,
  notif: NotificationsPane,
  ado: AdoPane,
  review: ReviewPane,
  sessions: SessionsPane,
  keys: ShortcutsPane,
  appearance: AppearancePane
}

/**
 * The Settings section's main region: a left sub-navigation over the categories, content on the
 * right. Leaving a category discards its pane, and every field a pane shows is store-backed, so
 * what is on screen survives that. The raw JSON editor holds a whole hand-edited document, which
 * it keeps in the Agent Tooling store for the same reason.
 */
export function SettingsView() {
  // That parked edit outlives this view as well, so Settings opens on the category holding it
  // rather than on the default one, which would leave the user's work out of sight.
  const [category, setCategory] = useState<CategoryId>(() =>
    selectHasRawDraft(useAgentToolingStore.getState()) ? 'agentTooling' : 'projects'
  )
  const rawEditParked = useAgentToolingStore(selectHasRawDraft)

  useEffect(() => {
    void useSettingsStore.getState().load()
  }, [])

  const Pane = PANES[category]

  return (
    <div className="ix-main">
      <div className="ix-settings">
        <nav className="ix-settings__nav">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`ix-settings__nav-btn${category === c.id ? ' ix-settings__nav-btn--active' : ''}`}
              onClick={() => setCategory(c.id)}
              title={
                c.id === 'agentTooling' && rawEditParked
                  ? 'Unsaved raw JSON edit waiting here'
                  : undefined
              }
            >
              {c.label}
              {c.id === 'agentTooling' && rawEditParked && (
                <span className="ix-settings__nav-dot" aria-hidden="true" />
              )}
            </button>
          ))}
        </nav>

        <div className="ix-settings__body">
          {/* Keyed by category so switching away from a pane that failed mounts the next one
              clean, leaving the user a way out instead of a dead settings region. That way out is
              the category nav beside this boundary, which the crash never reaches, so the recovery
              line names it rather than the sidebar further out. */}
          <ErrorBoundary
            key={category}
            scope="region"
            recovery="The rest of Settings is unaffected. Pick another category in the list on the left, or retry this one."
          >
            <div className="ix-settings__pane ix-settings__pane--active">
              <Pane />
            </div>
          </ErrorBoundary>
        </div>
      </div>
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
}) {
  return (
    <label className="ix-toggle">
      <input
        type="checkbox"
        checked={checked}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="ix-toggle__track" />
    </label>
  )
}

function SettingRow({
  label,
  hint,
  status,
  children
}: {
  label: string
  hint: string
  status?: 'working' | 'waiting' | 'done'
  children: ReactNode
}) {
  return (
    <div className="ix-set-row">
      <div>
        <div className={`ix-set-row__label${status ? ` ix-set-row__label--${status}` : ''}`}>
          {status ? `● ${label}` : label}
        </div>
        <div className="ix-set-row__hint">{hint}</div>
      </div>
      {children}
    </div>
  )
}

function NotificationsPane() {
  const notifications = useSettingsStore((s) => s.notifications)
  const toggle = (key: keyof NotificationSettings) => (value: boolean) =>
    void useSettingsStore.getState().setNotification(key, value)

  return (
    <>
      <div className="ix-settings__title">Notifikace</div>
      <SettingRow
        label="Systémové notifikace"
        hint="Hlavní vypínač - když je vypnuto, nic z níže se nezobrazí."
      >
        <Toggle checked={notifications.enabled} onChange={toggle('enabled')} label="Systémové notifikace" />
      </SettingRow>
      <SettingRow label="Working" status="working" hint="Claude Code session začala pracovat.">
        <Toggle checked={notifications.working} onChange={toggle('working')} label="Working" />
      </SettingRow>
      <SettingRow label="Waiting" status="waiting" hint="Session čeká na tvůj vstup.">
        <Toggle checked={notifications.waiting} onChange={toggle('waiting')} label="Waiting" />
      </SettingRow>
      <SettingRow label="Done" status="done" hint="Session dokončila úkol.">
        <Toggle checked={notifications.done} onChange={toggle('done')} label="Done" />
      </SettingRow>
      <SettingRow label="Zvuk" hint="Přehrát zvukový signál společně s notifikací.">
        <Toggle checked={notifications.sound} onChange={toggle('sound')} label="Zvuk" />
      </SettingRow>
    </>
  )
}

const ADO_FIELDS: { key: keyof AdoSettings; label: string; type: 'text' | 'password' }[] = [
  { key: 'orgUrl', label: 'Organizace (URL)', type: 'text' },
  { key: 'project', label: 'Projekt', type: 'text' },
  { key: 'repository', label: 'Repozitář', type: 'text' },
  { key: 'pat', label: 'Personal Access Token', type: 'password' }
]

function AdoPane() {
  const ado = useSettingsStore((s) => s.ado)
  const adoFallback = useSettingsStore((s) => s.adoFallback)
  const adoTest = useSettingsStore((s) => s.adoTest)

  // A blank field is served live by the fallback (`~/.claude.json` / env), so hint the effective
  // value as the placeholder rather than pre-filling it - typing here means "override the fallback".
  const placeholder = (key: keyof AdoSettings): string => {
    if (key === 'orgUrl') return adoFallback.orgUrl
    if (key === 'project') return adoFallback.project
    if (key === 'pat') return adoFallback.hasPat ? 'Používá se PAT z ~/.claude.json' : ''
    return ''
  }

  return (
    <>
      <div className="ix-settings__title">Azure DevOps</div>
      {ADO_FIELDS.map((field) => (
        <div className="ix-set-field" key={field.key}>
          <label htmlFor={`ix-set-ado-${field.key}`}>{field.label}</label>
          <input
            id={`ix-set-ado-${field.key}`}
            className="ix-input"
            type={field.type}
            spellCheck={false}
            placeholder={placeholder(field.key)}
            value={ado[field.key]}
            onChange={(e) => void useSettingsStore.getState().setAdoField(field.key, e.target.value)}
          />
        </div>
      ))}
      <div className="ix-settings__test">
        <button
          type="button"
          className="ix-btn ix-btn--primary"
          disabled={adoTest.status === 'testing'}
          onClick={() => void useSettingsStore.getState().testConnection()}
        >
          {adoTest.status === 'testing' ? 'Testuji…' : 'Testovat připojení'}
        </button>
        {adoTest.status === 'success' && (
          <span className="ix-settings__test-msg ix-settings__test-msg--ok">
            ✓ Připojeno jako {adoTest.displayName}
          </span>
        )}
        {adoTest.status === 'error' && (
          <span className="ix-settings__test-msg ix-settings__test-msg--err">✗ {adoTest.error}</span>
        )}
      </div>
    </>
  )
}

function ReviewPane() {
  const prompt = useSettingsStore((s) => s.review.prompt)
  const model = useSettingsStore((s) => s.review.model)

  return (
    <>
      <div className="ix-settings__title">PR Review</div>
      <div className="ix-set-field">
        <label htmlFor="ix-set-review-model">Model pro AI review</label>
        <div id="ix-set-review-model-hint" className="ix-set-row__hint">
          Předá se jako <code>claude --model</code>. Alias (<code>opus</code>, <code>sonnet</code>,{' '}
          <code>haiku</code>) nebo celé id modelu. Prázdné pole znamená{' '}
          <code>{DEFAULT_PR_REVIEW_MODEL}</code>.
        </div>
        <input
          id="ix-set-review-model"
          className="ix-input"
          type="text"
          spellCheck={false}
          aria-describedby="ix-set-review-model-hint"
          placeholder={DEFAULT_PR_REVIEW_MODEL}
          value={model}
          onChange={(e) => void useSettingsStore.getState().setReviewModel(e.target.value)}
        />
      </div>
      <div className="ix-set-field">
        <label htmlFor="ix-set-review-prompt">Prompt pro AI review</label>
        <div id="ix-set-review-prompt-hint" className="ix-set-row__hint ix-settings__prompt-hint">
          Tento text se pošle review session jako hlavní zadání. Můžeš ho kompletně nahradit
          v libovolném jazyce.
        </div>
        <textarea
          id="ix-set-review-prompt"
          className="ix-input ix-settings__prompt"
          aria-describedby="ix-set-review-prompt-hint"
          spellCheck={true}
          value={prompt}
          onChange={(e) => void useSettingsStore.getState().setReviewPrompt(e.target.value)}
        />
      </div>
      <button
        type="button"
        className="ix-btn"
        onClick={() => void useSettingsStore.getState().resetReviewDefaults()}
      >
        Obnovit výchozí prompt a model
      </button>
    </>
  )
}

function SessionsPane() {
  const autoResume = useSettingsStore((s) => s.autoResume)

  return (
    <>
      <div className="ix-settings__title">Sessions</div>
      <SettingRow
        label="Automaticky obnovit sessions po ukončení"
        hint="Po potvrzeném Cmd+Q se pozastavené Claude sessions při dalším startu obnoví v novém procesu. Když je vypnuto, start je jen zobrazí a obnovíš je ručně."
      >
        <Toggle
          checked={autoResume}
          onChange={(value) => void useSettingsStore.getState().setAutoResume(value)}
          label="Automaticky obnovit sessions po ukončení"
        />
      </SettingRow>
    </>
  )
}

/**
 * Shortcuts that belong to one surface rather than the whole app, so they have no menu item and no
 * entry in the shortcut map (see CommandPalette, Dialog, ContextMenu, renames). Everything
 * app-wide is read from the map instead, so this list can never contradict what the menu binds.
 */
const LOCAL_SHORTCUTS: { action: string; keys: string[] }[] = [
  { action: 'Pohyb ve výsledcích palety', keys: ['↑', '↓'] },
  { action: 'Spustit vybraný příkaz palety', keys: ['⏎'] },
  { action: 'Zavřít paletu / dialog / menu', keys: ['Esc'] },
  { action: 'Potvrdit přejmenování (tab, workspace)', keys: ['⏎'] },
  { action: 'Zrušit přejmenování', keys: ['Esc'] }
]

function ShortcutsPane() {
  return (
    <>
      <div className="ix-settings__title">Klávesové zkratky</div>
      <div className="ix-set-row__hint ix-settings__keys-note">
        Jen přehled, přebindování zatím není podporováno.
      </div>
      <table className="ix-kshort-table">
        <tbody>
          {/* Straight from the map the native menu is built from, so the two always agree. */}
          {SHORTCUT_ACTIONS.map((action) => (
            <tr key={action.id}>
              <td>{action.label}</td>
              <td>
                <span className="ix-kbd">{formatAccelerator(action.accelerator)}</span>
              </td>
            </tr>
          ))}
          {LOCAL_SHORTCUTS.map((s) => (
            <tr key={s.action}>
              <td>{s.action}</td>
              <td>
                {s.keys.map((k) => (
                  <span className="ix-kbd" key={k}>
                    {k}
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function AppearancePane() {
  const fontSize = useSettingsStore((s) => s.terminalFontSize)

  // Every drag step updates state (live terminals restyle at once) but the SQLite write is
  // debounced; flush it the moment the interaction settles so the size survives a relaunch.
  const commit = (): void => useSettingsStore.getState().commitTerminalFontSize()

  return (
    <>
      <div className="ix-settings__title">Vzhled</div>
      <div className="ix-set-field">
        <label htmlFor="ix-set-font-size">Velikost písma v terminálu</label>
        <div className="ix-set-slider">
          <input
            id="ix-set-font-size"
            type="range"
            min={TERMINAL_FONT_SIZE_MIN}
            max={TERMINAL_FONT_SIZE_MAX}
            step={0.5}
            value={fontSize}
            onChange={(e) => useSettingsStore.getState().setTerminalFontSize(Number(e.target.value))}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
          />
          <span className="ix-set-slider__value">{fontSize}px</span>
        </div>
      </div>
    </>
  )
}
