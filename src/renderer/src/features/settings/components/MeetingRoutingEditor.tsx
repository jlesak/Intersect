import { useEffect, useState } from 'react'
import type { MeetingRouteTarget, MeetingRoutingSettings } from '@common/domain'
import { useProjectsStore } from '@renderer/features/projects'
import { useSettingsStore } from '../store'

type TargetKind = MeetingRouteTarget['kind']

function targetOf(kind: TargetKind, firstProjectId: string): MeetingRouteTarget {
  if (kind === 'issue') return { kind, issueKey: '' }
  if (kind === 'project') return { kind, projectId: firstProjectId }
  return { kind: 'unassigned' }
}

export function MeetingRoutingEditor() {
  const saved = useSettingsStore((s) => s.meetingRouting)
  const projects = useProjectsStore((s) => s.projects)
  const [draft, setDraft] = useState<MeetingRoutingSettings>(saved)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setDraft(saved), [saved])
  const firstProjectId = projects[0]?.id ?? ''

  function changeRule(index: number, patch: Partial<MeetingRoutingSettings['rules'][number]>) {
    setDraft((current) => ({ ...current, rules: current.rules.map((rule, i) =>
      i === index ? { ...rule, ...patch } : rule) }))
  }

  function targetInput(target: MeetingRouteTarget, index: number | null) {
    const label = index === null ? 'Default' : String(index + 1)
    const setTarget = (next: MeetingRouteTarget) => {
      if (index === null) setDraft((current) => ({ ...current, defaultTarget: next }))
      else changeRule(index, { target: next })
    }
    return <>
      <label htmlFor={`meeting-target-${label}`}>{index === null ? 'Default target' : `Target type ${label}`}</label>
      <select id={`meeting-target-${label}`} className="ix-input" value={target.kind}
        onChange={(event) => setTarget(targetOf(event.target.value as TargetKind, firstProjectId))}>
        {index === null && <option value="unassigned">Unassigned</option>}
        <option value="issue">Issue key</option>
        <option value="project">Project</option>
      </select>
      {target.kind === 'issue' && <>
        <label htmlFor={`meeting-issue-${label}`}>{`Issue key ${label}`}</label>
        <input id={`meeting-issue-${label}`} className="ix-input" value={target.issueKey}
          onChange={(event) => setTarget({ kind: 'issue', issueKey: event.target.value })} />
      </>}
      {target.kind === 'project' && <>
        <label htmlFor={`meeting-project-${label}`}>{`Project ${label}`}</label>
        <select id={`meeting-project-${label}`} className="ix-input" value={target.projectId}
          onChange={(event) => setTarget({ kind: 'project', projectId: event.target.value })}>
          {projects.length === 0 && <option value="">No projects</option>}
          {projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
        </select>
      </>}
    </>
  }

  async function save() {
    setSaving(true)
    setError(null)
    try { await useSettingsStore.getState().saveMeetingRouting(draft) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setSaving(false) }
  }

  return <div className="ix-meeting-rules">
    <h3>Meeting routing</h3>
    <p className="ix-set-row__hint">Rules match literal subject text, ignoring case. The first match wins.</p>
    {draft.rules.map((rule, index) => <div className="ix-meeting-rule" key={index}>
      <label htmlFor={`meeting-pattern-${index}`}>{`Pattern ${index + 1}`}</label>
      <input id={`meeting-pattern-${index}`} className="ix-input" value={rule.pattern}
        onChange={(event) => changeRule(index, { pattern: event.target.value })} />
      {targetInput(rule.target, index)}
      <div className="ix-meeting-rule__actions">
        <button type="button" className="ix-btn ix-btn--ghost" disabled={index === 0}
          onClick={() => setDraft((current) => {
            const rules = [...current.rules]; [rules[index - 1], rules[index]] = [rules[index], rules[index - 1]]
            return { ...current, rules }
          })}>Move up</button>
        <button type="button" className="ix-btn ix-btn--ghost" disabled={index === draft.rules.length - 1}
          onClick={() => setDraft((current) => {
            const rules = [...current.rules]; [rules[index], rules[index + 1]] = [rules[index + 1], rules[index]]
            return { ...current, rules }
          })}>Move down</button>
        <button type="button" className="ix-btn ix-btn--ghost"
          onClick={() => setDraft((current) => ({ ...current,
            rules: current.rules.filter((_, i) => i !== index) }))}>Remove</button>
      </div>
    </div>)}
    <button type="button" className="ix-btn ix-btn--ghost"
      onClick={() => setDraft((current) => ({ ...current, rules: [...current.rules,
        { pattern: '', target: { kind: 'issue', issueKey: '' } }] }))}>Add rule</button>
    <div className="ix-meeting-rule ix-meeting-rule--default">{targetInput(draft.defaultTarget, null)}</div>
    <button type="button" className="ix-btn ix-btn--primary" disabled={saving}
      onClick={() => void save()}>{saving ? 'Saving…' : 'Save routing'}</button>
    {error && <div role="alert">{error}</div>}
  </div>
}
