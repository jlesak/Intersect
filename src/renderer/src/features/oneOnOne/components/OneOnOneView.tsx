import { useEffect, useMemo, useState, type DragEvent, type FormEvent } from 'react'
import type { OtoRunType } from '@common/domain'
import { IconPlus } from '@renderer/shared/ui/icons'
import * as api from '../ipc'
import { groupRunsByPerson, peopleFromRuns } from '../people'
import { useOneOnOneStore } from '../store'
import { RunCard } from './RunCard'

/** The id the person field and its list of known people agree on. */
const PEOPLE_LIST_ID = 'oto-people'

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * The new-run form: workflow type, person, and (for Process only) the VTT recording via
 * drag-and-drop or the native picker. All state is component-local; submitting hands the input
 * to the store, and a validation error from main lands inline.
 *
 * The person field offers everyone the history already knows, so a name used before is picked
 * instead of typed again slightly differently. A new person still has to be typeable, so free
 * text stays accepted.
 */
function NewRunForm({ people }: { people: string[] }) {
  const [type, setType] = useState<OtoRunType>('process')
  const [person, setPerson] = useState('')
  const [vttPath, setVttPath] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [starting, setStarting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  async function pickFile(): Promise<void> {
    try {
      const picked = await api.pickVttFile()
      if (picked) setVttPath(picked)
    } catch (e) {
      setFormError(message(e))
    }
  }

  function handleDrop(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (!file) return
    const path = api.getPathForFile(file)
    if (path) setVttPath(path)
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    setFormError(null)
    setStarting(true)
    try {
      await useOneOnOneStore.getState().start({
        type,
        person,
        vttPath: type === 'process' ? vttPath : null
      })
    } catch (err) {
      setFormError(message(err))
    } finally {
      setStarting(false)
    }
  }

  return (
    <form className="ix-oto-form" onSubmit={(e) => void submit(e)}>
      <div className="ix-oto-form__row">
        <div className="ix-oto-form__field">
          <label htmlFor="oto-type">Workflow type</label>
          <select
            id="oto-type"
            className="ix-select"
            value={type}
            onChange={(e) => setType(e.target.value as OtoRunType)}
          >
            <option value="process">Process 1:1 recording</option>
            <option value="prep">Prepare for 1:1</option>
          </select>
        </div>
        <div className="ix-oto-form__field">
          <label htmlFor="oto-person">Person</label>
          <input
            id="oto-person"
            className="ix-input"
            list={PEOPLE_LIST_ID}
            placeholder="e.g. Marek K."
            value={person}
            onChange={(e) => setPerson(e.target.value)}
          />
          <datalist id={PEOPLE_LIST_ID}>
            {people.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
      </div>

      {type === 'process' && (
        <div className="ix-oto-form__field">
          <label>Recording (VTT)</label>
          <div
            className={`ix-oto-form__file${dragOver ? ' ix-oto-form__file--over' : ''}${vttPath ? ' ix-oto-form__file--picked' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => void pickFile()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') void pickFile()
            }}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M8 2v8M5 7l3 3 3-3M3 13h10" />
            </svg>
            {vttPath ?? 'Drop a VTT file or click to choose…'}
          </div>
        </div>
      )}

      {formError && <div className="ix-oto-form__error">{formError}</div>}

      <div className="ix-oto-form__actions">
        <button
          type="button"
          className="ix-btn ix-btn--ghost"
          onClick={() => useOneOnOneStore.getState().setShowForm(false)}
        >
          Cancel
        </button>
        <button type="submit" className="ix-btn ix-btn--primary" disabled={starting}>
          {starting && <span className="ix-spinner" aria-hidden />}
          Start
        </button>
      </div>
    </form>
  )
}

/**
 * The 1:1 section's main region: head (title + New button), the collapsed-by-default new-run
 * form, and the persistent run history gathered per person.
 */
export function OneOnOneView() {
  const status = useOneOnOneStore((s) => s.status)
  const error = useOneOnOneStore((s) => s.error)
  const runs = useOneOnOneStore((s) => s.runs)
  const showForm = useOneOnOneStore((s) => s.showForm)

  // Both build fresh objects, so they derive from the stable slice here rather than inside a
  // selector, which the store factory's double-call guard would reject.
  const people = useMemo(() => peopleFromRuns(runs), [runs])
  const groups = useMemo(() => groupRunsByPerson(runs), [runs])

  useEffect(() => {
    void useOneOnOneStore.getState().load()
  }, [])

  return (
    <div className="ix-main">
      <div className="ix-oto">
        <div className="ix-oto__head">
          <span className="ix-oto__title">1:1</span>
          {!showForm && (
            <button
              type="button"
              className="ix-btn ix-btn--primary"
              onClick={() => useOneOnOneStore.getState().setShowForm(true)}
            >
              <IconPlus width={13} height={13} strokeWidth={1.8} />
              New
            </button>
          )}
        </div>

        {showForm && <NewRunForm people={people} />}

        {status === 'error' && (
          <div className="ix-oto__error">Could not load the run history{error ? `: ${error}` : ''}</div>
        )}

        {status === 'ready' && runs.length === 0 ? (
          <div className="ix-empty">
            <span className="ix-eyebrow">Run history</span>
            <div className="ix-empty__title">No runs yet.</div>
            <p className="ix-empty__hint">
              Use New to process a 1:1 recording or to prepare for an upcoming 1:1.
            </p>
          </div>
        ) : (
          runs.length > 0 && (
            <>
              <div className="ix-eyebrow">Run history</div>
              <div className="ix-oto-runs">
                {groups.map((group) => (
                  <div key={group.key} className="ix-oto-person">
                    <div className="ix-oto-person__name">{group.person}</div>
                    <div className="ix-oto-person__runs">
                      {group.runs.map((run) => (
                        <RunCard key={run.id} run={run} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )
        )}
      </div>
    </div>
  )
}
