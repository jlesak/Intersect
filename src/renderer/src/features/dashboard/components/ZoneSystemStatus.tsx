import type { ClaudeUsage, ClaudeUsageWindow } from '@common/domain'
import { formatRelativeTime } from '@renderer/features/myWork'
import {
  formatCapturedAt,
  formatFiveHourReset,
  formatWeeklyReset,
  usageMeterColor
} from '@renderer/features/usage'

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
 * Zone 4 - whether the things this app depends on are healthy: how much Claude budget is left in
 * each window, and how current the two synced sources are.
 */
export function ZoneSystemStatus({
  usage,
  jiraFetchedAt,
  prSyncedAt,
  now
}: {
  usage: ClaudeUsage | null
  jiraFetchedAt: number | null
  prSyncedAt: number | null
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

      <div className="ix-dash-sync">
        <span className="ix-dash-sync__label">Jira</span>
        <span className="ix-dash-sync__value">{freshness(jiraFetchedAt, now)}</span>
      </div>
      <div className="ix-dash-sync">
        <span className="ix-dash-sync__label">Pull requests</span>
        <span className="ix-dash-sync__value">{freshness(prSyncedAt, now)}</span>
      </div>
    </section>
  )
}
