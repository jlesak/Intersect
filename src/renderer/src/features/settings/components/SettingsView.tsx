import { useEffect, useState, type ReactNode } from 'react'
import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  type AdoSettings,
  type NotificationSettings
} from '@common/domain'
import { useSettingsStore } from '../store'

const CATEGORIES = [
  { id: 'notif', label: 'Notifikace' },
  { id: 'ado', label: 'Azure DevOps' },
  { id: 'keys', label: 'Klávesové zkratky' },
  { id: 'appearance', label: 'Vzhled' }
] as const

type CategoryId = (typeof CATEGORIES)[number]['id']

/**
 * The Settings section's main region: a left sub-navigation over four categories, content on the
 * right. All four panes stay mounted (the inactive ones only hidden), and every field binds to
 * the store which persists on change - so switching categories can never lose anything.
 */
export function SettingsView() {
  const [category, setCategory] = useState<CategoryId>('notif')

  useEffect(() => {
    void useSettingsStore.getState().load()
  }, [])

  const pane = (id: CategoryId): string =>
    `ix-settings__pane${category === id ? ' ix-settings__pane--active' : ''}`

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
            >
              {c.label}
            </button>
          ))}
        </nav>

        <div className="ix-settings__body">
          <div className={pane('notif')}>
            <NotificationsPane />
          </div>
          <div className={pane('ado')}>
            <AdoPane />
          </div>
          <div className={pane('keys')}>
            <ShortcutsPane />
          </div>
          <div className={pane('appearance')}>
            <AppearancePane />
          </div>
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
  const adoTest = useSettingsStore((s) => s.adoTest)

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

/** The shortcuts the app actually binds today (see CommandPalette, Dialog, ContextMenu, renames). */
const SHORTCUTS: { action: string; keys: string[] }[] = [
  { action: 'Otevřít / zavřít Command Palette', keys: ['⌘', 'K'] },
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
          {SHORTCUTS.map((s) => (
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
            onChange={(e) =>
              void useSettingsStore.getState().setTerminalFontSize(Number(e.target.value))
            }
          />
          <span className="ix-set-slider__value">{fontSize}px</span>
        </div>
      </div>
    </>
  )
}
