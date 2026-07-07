import { useState } from 'react'
import { useTimeTrackingStore } from '../store'
import { normalizeIssueKey, parseDuration } from '../time'

/**
 * The inline form a day's "+ Add entry" button opens. The issue key is optional (a meeting has
 * none); the time must parse, otherwise a gentle inline error keeps the form open.
 */
export function AddEntryForm({ day, onClose }: { day: string; onClose: () => void }) {
  const [description, setDescription] = useState('')
  const [issueKey, setIssueKey] = useState('')
  const [time, setTime] = useState('')
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    const trimmed = description.trim()
    if (!trimmed) {
      setError('Add a short description.')
      return
    }
    const durationMs = parseDuration(time)
    if (durationMs === null) {
      setError('Enter the time as e.g. 45m, 1h 30m or 1:30.')
      return
    }
    await useTimeTrackingStore.getState().addManual({
      day,
      description: trimmed,
      issueKey: normalizeIssueKey(issueKey),
      durationMs
    })
    onClose()
  }

  return (
    <div className="ix-tt-form">
      <div className="ix-tt-form__row">
        <input
          className="ix-input"
          placeholder="Description (e.g. 1:1 with Marek)"
          value={description}
          autoFocus
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="ix-tt-form__row">
        <input
          className="ix-input"
          placeholder="Issue key (optional)"
          style={{ maxWidth: 120 }}
          value={issueKey}
          onChange={(e) => setIssueKey(e.target.value)}
        />
        <input
          className="ix-input"
          placeholder="Time (e.g. 45m)"
          style={{ maxWidth: 90 }}
          value={time}
          onChange={(e) => setTime(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
          }}
        />
      </div>
      {error && <div className="ix-tt-form__error">{error}</div>}
      <div className="ix-tt-form__actions">
        <button type="button" className="ix-btn ix-btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="ix-btn ix-btn--primary" onClick={() => void save()}>
          Save
        </button>
      </div>
    </div>
  )
}
