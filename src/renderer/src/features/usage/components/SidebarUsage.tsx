import type { ClaudeUsageWindow } from '@common/domain'
import { formatCapturedAt, formatFiveHourReset, formatWeeklyReset, usageMeterColor } from '../format'
import { useUsageStore } from '../store'

/** One usage row: label, meter bar, used percent, and reset time. A null window shows a dash. */
function UsageRow({
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
    <div className="ix-usage__row">
      <div className="ix-usage__row-head">
        <span>{label}</span>
        <span className="ix-usage__pct">{window ? `${window.usedPercent}%` : '-'}</span>
      </div>
      <div className="ix-usage__meter">
        <div
          className="ix-usage__meter-fill"
          style={{ width: `${percent}%`, background: usageMeterColor(percent) }}
        />
      </div>
      {window && <div className="ix-usage__reset">resets {formatReset(window.resetsAt)}</div>}
    </div>
  )
}

/**
 * Always-visible sidebar panel mirroring Claude Code's own `/usage`: the 5h session window and the
 * weekly window, each with a meter, its used percent, and its reset time - fed from the statusline
 * snapshot the app-managed usage-statusline script captures on every Claude Code render. Shows a
 * quiet hint until the first snapshot arrives (no Claude Code session has run since install).
 */
export function SidebarUsage() {
  const usage = useUsageStore((s) => s.usage)

  return (
    <div className="ix-usage">
      <div className="ix-usage__head">
        <span className="ix-eyebrow">Claude usage</span>
        {usage && <span className="ix-usage__asof">as of {formatCapturedAt(usage.capturedAt)}</span>}
      </div>
      {usage ? (
        <>
          <UsageRow label="5h session" window={usage.fiveHour} formatReset={formatFiveHourReset} />
          <UsageRow label="Weekly" window={usage.sevenDay} formatReset={formatWeeklyReset} />
        </>
      ) : (
        <div className="ix-usage__empty">no data yet - run a Claude session</div>
      )}
    </div>
  )
}
