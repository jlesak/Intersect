import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { OtoRun } from '@common/domain'
import { formatRelativeTime } from '@renderer/features/myWork'
import { reportError } from '@renderer/shared/ui/toast'
import * as api from '../ipc'

const TYPE_LABELS: Record<OtoRun['type'], string> = {
  process: 'Processing',
  prep: 'Preparation'
}

function openLink(url: string): void {
  api.openExternal(url).catch((e) => reportError('Could not open the link', e))
}

const CheckIcon = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M3 8.5l3.5 3.5L13 4.5" />
  </svg>
)

/**
 * One run in the 1:1 history: type badge, person, relative time, status line, and the per-type
 * result - external links for a done Process run, the briefing rendered as markdown for a done
 * Prepare run.
 */
export function RunCard({ run }: { run: OtoRun }) {
  return (
    <div className="ix-oto-run">
      <div className="ix-oto-run__top">
        <span className={`ix-oto-run__type ix-oto-run__type--${run.type}`}>
          {TYPE_LABELS[run.type]}
        </span>
        <span className="ix-oto-run__person">{run.person}</span>
        <span className="ix-oto-run__time">{formatRelativeTime(run.createdAt)}</span>
      </div>

      {run.status === 'running' && (
        <div className="ix-oto-run__status">
          <span className="ix-spinner" aria-hidden />
          Running in background (Claude Code session)…
        </div>
      )}
      {run.status === 'done' && (
        <div className="ix-oto-run__status ix-oto-run__status--done">
          <CheckIcon />
          Done
        </div>
      )}
      {run.status === 'failed' && (
        <div className="ix-oto-run__status ix-oto-run__status--failed">
          Failed: {run.error || 'unknown error'}
        </div>
      )}

      {run.status === 'done' && run.type === 'process' && (
        <div className="ix-oto-run__links">
          {run.notionUrl && (
            <button type="button" className="ix-oto-run__link" onClick={() => openLink(run.notionUrl!)}>
              📄 Notion note
            </button>
          )}
          {run.slackDraftCreated &&
            (run.slackChannelLink ? (
              <button
                type="button"
                className="ix-oto-run__link"
                onClick={() => openLink(run.slackChannelLink!)}
              >
                💬 Slack summary created
              </button>
            ) : (
              <span className="ix-oto-run__link ix-oto-run__link--static">
                💬 Slack summary created
              </span>
            ))}
        </div>
      )}

      {run.status === 'done' && run.type === 'prep' && run.resultMarkdown && (
        <div className="ix-oto-prep-body">
          <div className="ix-markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                // The briefing summarizes third-party content; a link in it must open through the
                // guarded system browser bridge, never navigate the app window.
                a: ({ href, children }) => (
                  <a
                    href={href}
                    onClick={(e) => {
                      e.preventDefault()
                      if (href) openLink(href)
                    }}
                  >
                    {children}
                  </a>
                )
              }}
            >
              {run.resultMarkdown}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  )
}
