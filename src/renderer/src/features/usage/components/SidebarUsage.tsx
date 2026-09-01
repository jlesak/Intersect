import type { ClaudeUsageWindow } from '@common/domain'
import { IconRefresh } from '@renderer/shared/ui/icons'
import {
  formatCapturedAt,
  formatFiveHourReset,
  formatUsagePercent,
  formatWeeklyReset,
  usageMeterColor
} from '../format'
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
        <span className="ix-usage__pct">{window ? formatUsagePercent(window.usedPercent) : '-'}</span>
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
 * weekly window, each with a meter, its used percent, and its reset time. Shows a quiet hint until
 * a source produces a snapshot.
 *
 * Two sources feed it. The statusline snapshot moves only when a Claude session runs inside this
 * app, so it can sit days out of date. The refresh button queries Anthropic directly, which covers
 * every session on the account.
 */
export function SidebarUsage() {
  const usage = useUsageStore((s) => s.usage)
  const refreshing = useUsageStore((s) => s.refreshing)

  return (
    <div className="ix-usage">
      <div className="ix-usage__head">
        <span className="ix-eyebrow">Claude usage</span>
        <div className="ix-usage__head-right">
          {usage && (
            <span className="ix-usage__asof">as of {formatCapturedAt(usage.capturedAt)}</span>
          )}
          <button
            type="button"
            className={`ix-usage__refresh${refreshing ? ' ix-usage__refresh--busy' : ''}`}
            title="Query the current usage from Anthropic"
            aria-label="Refresh Claude usage"
            disabled={refreshing}
            onClick={() => void useUsageStore.getState().refresh()}
          >
            <IconRefresh width={11} height={11} />
          </button>
        </div>
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
