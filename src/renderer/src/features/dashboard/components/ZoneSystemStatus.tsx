import type { ClaudeUsage, ClaudeUsageWindow } from '@common/domain'
import { formatRelativeTime } from '@renderer/features/myWork'
import {
  formatCapturedAt,
  formatFiveHourReset,
  formatWeeklyReset,
  usageMeterColor
} from '@renderer/features/usage'
import { useDashboardNavStore } from '../store'
import type { SourceSetup } from '../zones'

/** One usage window at dashboard scale: label, meter, used percent, and when it resets. */
function Meter({
  label,
  window,
  formatReset
}: {
  label: string
  window: ClaudeUsageWindow | null
  formatReset: (resetsAtSeconds: number) => string
}) {
  const percent = window?.usedPercent ?? 0
  return (
    <div className="ix-dash-meter">
      <div className="ix-dash-meter__head">
        <span className="ix-dash-meter__label">{label}</span>
        <span className="ix-dash-meter__pct">{window ? `${window.usedPercent}%` : '-'}</span>
      </div>
      <div className="ix-dash-meter__track">
        <div
          className="ix-dash-meter__fill"
          style={{ width: `${percent}%`, background: usageMeterColor(percent) }}
        />
      </div>
      {window && (
        <div className="ix-dash-meter__reset">resets {formatReset(window.resetsAt)}</div>
      )}
    </div>
  )
}

/**
 * How long ago a source last answered. A source that never has says so plainly rather than showing
 * an age computed from nothing - unknown freshness right after a launch is misleading exactly when
 * the user most needs to know whether what they are reading is current.
 */
function freshness(at: number | null, now: number): string {
  return at === null ? 'never' : formatRelativeTime(at, now)
}

/**
 * One synced source's row: how current it is, or - when it was never connected - the fact that it
 * was not, as the way to go and connect it. "Never synced" and "no credentials were ever entered"
 * look identical here otherwise, and only one of them is something the user can act on.
 */
function SyncRow({
  label,
  at,
  setup,
  now
}: {
  label: string
  at: number | null
  setup: SourceSetup
  now: number
}) {
  return (
    <div className="ix-dash-sync">
      <span className="ix-dash-sync__label">{label}</span>
      {setup === 'missing' ? (
        <button
          type="button"
          className="ix-dash-sync__value ix-dash-sync__setup"
          onClick={() => useDashboardNavStore.getState().openSettings()}
        >
          not set up
        </button>
      ) : (
        <span className="ix-dash-sync__value">{freshness(at, now)}</span>
      )}
    </div>
  )
}

/**
 * Zone 4 - whether the things this app depends on are healthy: how much Claude budget is left in
 * each window, and how current the two synced sources are.
 */
export function ZoneSystemStatus({
  usage,
  jiraFetchedAt,
  prSyncedAt,
  prSetup,
  now
}: {
  usage: ClaudeUsage | null
  jiraFetchedAt: number | null
  prSyncedAt: number | null
  prSetup: SourceSetup
  now: number
}) {
  return (
    <section className="ix-dash-zone">
      <div className="ix-dash-zone__head">
        <span className="ix-eyebrow ix-dash-zone__title">System status</span>
        {usage && (
          <span className="ix-dash-zone__meta">as of {formatCapturedAt(usage.capturedAt)}</span>
        )}
      </div>

      {usage ? (
        <>
          <Meter label="5h session" window={usage.fiveHour} formatReset={formatFiveHourReset} />
          <Meter label="Weekly" window={usage.sevenDay} formatReset={formatWeeklyReset} />
        </>
      ) : (
        <div className="ix-dash-usage__empty">
          No Claude usage captured yet - it appears once a Claude session has run.
        </div>
      )}

      {/* Jira carries no setup state: its host and query are built in and its only setup step is an
          interactive login, which nothing on this surface can observe without performing it. */}
      <SyncRow label="Jira" at={jiraFetchedAt} setup="configured" now={now} />
      <SyncRow label="Pull requests" at={prSyncedAt} setup={prSetup} now={now} />
    </section>
  )
}
