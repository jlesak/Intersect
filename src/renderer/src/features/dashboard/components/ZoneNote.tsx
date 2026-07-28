/** The single thing a user can press to resolve the state a zone is reporting. */
export interface NoteAction {
  label: string
  onClick(): void
}

/**
 * A zone's one-line state, together with the one action that resolves it where such an action
 * exists.
 *
 * Every zone shrinks to a line like this instead of disappearing, and the line has to distinguish
 * between things that look alike but are not: all clear, still reading, a read that failed, a source
 * that was never set up. They share one component so that a failure can never come out worded like
 * an all-clear on one zone while another zone words it honestly, and so that a state the user can
 * do something about always presents that something in the same place.
 */
export function ZoneNote({
  className,
  note,
  action
}: {
  className: string
  note: string
  action?: NoteAction
}) {
  return (
    <div className={`ix-dash-note ${className}`}>
      <span className="ix-dash-note__text">{note}</span>
      {action && (
        <button
          type="button"
          className="ix-btn ix-btn--ghost ix-dash-note__action"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
