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
 * The consent question, shown once on a fresh install.
 *
 * It exists because of what happens next: on macOS the app has to read Claude Code's OAuth token
 * out of the Keychain, and the OS answers that with a dialog naming a different app than the one
 * the user is looking at. Meeting that dialog cold is alarming and gets denied. So the panel says
 * plainly what will be read, what it is used for, and that the OS will ask - then the dialog is
 * the expected second step rather than the first surprise.
 */
function LiveConsentPrompt() {
  const refreshing = useUsageStore((s) => s.refreshing)

  return (
    <div className="ix-usage__consent">
      <p className="ix-usage__consent-text">
        Show usage from <strong>all</strong> your Claude sessions, not only the ones started here.
        Intersect reads Claude Code&apos;s sign-in token to ask Anthropic. macOS will ask you to
        allow the Keychain read.
      </p>
      <div className="ix-usage__consent-actions">
        <button
          type="button"
          className="ix-btn ix-btn--primary"
          disabled={refreshing}
          onClick={() => void useUsageStore.getState().setConsent(true)}
        >
          Allow
        </button>
        <button
          type="button"
          className="ix-btn"
          disabled={refreshing}
          onClick={() => void useUsageStore.getState().setConsent(false)}
        >
          Not now
        </button>
      </div>
    </div>
  )
}

/**
 * Always-visible sidebar panel mirroring Claude Code's own `/usage`: the 5h session window and the
 * weekly window, each with a meter, its used percent, and its reset time.
 *
 * Two sources feed it. The statusline snapshot moves only when a Claude session runs inside this
 * app, so it can sit days out of date. The live query to Anthropic covers every session on the
 * account, and is only ever attempted once the user has allowed it - see `LiveConsentPrompt`.
 */
export function SidebarUsage() {
  const usage = useUsageStore((s) => s.usage)
  const consent = useUsageStore((s) => s.consent)
  const live = useUsageStore((s) => s.live)
  const refreshing = useUsageStore((s) => s.refreshing)

  // A granted consent that still yields nothing is the one failure worth naming: the user did what
  // was asked and the button appears to do nothing, so the panel says where to look instead.
  const showUnavailable = consent === 'granted' && live === 'unavailable'

  return (
    <div className="ix-usage">
      <div className="ix-usage__head">
        <span className="ix-eyebrow">Claude usage</span>
        <div className="ix-usage__head-right">
          {usage && (
            <span className="ix-usage__asof">as of {formatCapturedAt(usage.capturedAt)}</span>
          )}
          {consent === 'granted' && (
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
          )}
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
      {consent === 'unasked' && <LiveConsentPrompt />}
      {showUnavailable && (
        <div className="ix-usage__note">
          live usage unavailable - sign in with <code>claude</code>, or allow the Keychain read
        </div>
      )}
      {consent === 'declined' && (
        <button
          type="button"
          className="ix-btn ix-btn--ghost ix-usage__enable"
          onClick={() => void useUsageStore.getState().setConsent(true)}
        >
          Use live usage from all sessions
        </button>
      )}
    </div>
  )
}
