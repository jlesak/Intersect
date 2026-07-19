import type {
  AgentRuntimeDay,
  AgentRuntimeEvidence,
  NewAgentRuntimeEvidence,
  Project,
  SessionSummary,
  Workspace
} from '@common/domain'
import { makeSessionId, parseSessionId } from '@common/ipc'
import { dayKeyOf, weekdayKeys } from '@common/week'
import type { AgentRuntimeRepo } from '../db/agentRuntimeRepo'
import type { HookEventRepo } from '../db/hookEventRepo'
import type { StoredWorkItemRef } from '../db/workItemRefRepo'
import type { ProjectPathDeps } from '../projects/resolveProject'
import { resolveProjectForPath } from '../projects/resolveProject'
import { activeMinutesByDate, IDLE_CAP_MS } from './activeMinutes'

/** A tab, as far as the recompute cares: which session id it maps to and what transcript it resumes. */
interface TabLike {
  id: string
  resumeSessionId: string | null
}

/**
 * The impure edges the recompute needs, injected so the derivation is fully testable without a
 * database, a real disk, or a notifier. `hookEvents` are the primary activity pings; `sessions`
 * supplies the historical JSONL transcripts for the lower-confidence fallback; the project/ref
 * repos supply attribution; `repo` persists the reconciled evidence.
 */
export interface AgentRuntimeDeps {
  hookEvents: Pick<HookEventRepo, 'listBySession' | 'listSessions'>
  workItemRefs: { get(tabId: string): StoredWorkItemRef | undefined }
  workspaces: { getById(id: string): Workspace | undefined; list(): Workspace[] }
  tabs: { listByWorkspace(workspaceId: string): TabLike[] }
  projects: { list(): Project[] }
  sessions: { list(): Promise<SessionSummary[]> }
  pathDeps: ProjectPathDeps
  repo: AgentRuntimeRepo
  now: () => number
}

export interface AgentRuntimeService {
  /**
   * Recompute one hook session's evidence from its activity pings and reconcile it in place.
   * Idempotent: a repeated SessionEnd, later-arriving events, or a manual refresh all converge
   * on the same rows. A session with no measurable activity ends up with no rows.
   */
  recomputeSession(sessionId: string): void
  /**
   * Recompute every hook session, then add the JSONL transcript fallback for any historical
   * session hooks never covered. Async because the transcript index reads the disk.
   */
  recomputeAll(): Promise<void>
  /** Per-day agent-hours rollup for the Monday-Friday week (minutes SUMMED across sessions). */
  getWeek(weekStart: string): AgentRuntimeDay[]
  /** Per-day rollup for one project across the Monday-Friday week. */
  getForProject(projectId: string, weekStart: string): AgentRuntimeDay[]
  /** The raw evidence rows for one session (hook `workspaceId:tabId` or `jsonl:<uuid>`). */
  getForSession(sessionId: string): AgentRuntimeEvidence[]
  /** Manual full recompute; the same converging operation as boot and session-end. */
  refresh(): Promise<void>
}

/** Roll evidence rows up into per-day agent-hours: minutes summed, distinct sessions counted. */
function aggregate(rows: AgentRuntimeEvidence[]): AgentRuntimeDay[] {
  const byDay = new Map<string, { minutes: number; agents: Set<string>; low: boolean }>()
  for (const row of rows) {
    const day = byDay.get(row.localDate) ?? { minutes: 0, agents: new Set(), low: false }
    day.minutes += row.minutes
    day.agents.add(row.sessionId)
    if (row.confidence === 'low') day.low = true
    byDay.set(row.localDate, day)
  }
  return [...byDay.entries()]
    .map(([localDate, d]) => ({
      localDate,
      minutes: d.minutes,
      agents: d.agents.size,
      hasLowConfidence: d.low
    }))
    .sort((a, b) => a.localDate.localeCompare(b.localDate))
}

export function createAgentRuntimeService(deps: AgentRuntimeDeps): AgentRuntimeService {
  /**
   * The project and primary work item for one hook session. An explicit primary ref wins - it
   * carries both the work item and its own project; without one, the session inherits its
   * workspace's project. Unknown context resolves to null and creates nothing.
   */
  function attribute(sessionId: string): {
    projectId: string | null
    workItemSource: string | null
    workItemKey: string | null
  } {
    const parsed = parseSessionId(sessionId)
    if (!parsed) return { projectId: null, workItemSource: null, workItemKey: null }
    const ref = deps.workItemRefs.get(parsed.tabId)
    if (ref) {
      return { projectId: ref.projectId, workItemSource: ref.source, workItemKey: ref.externalKey }
    }
    const workspace = deps.workspaces.getById(parsed.workspaceId)
    return {
      projectId: workspace?.projectId ?? null,
      workItemSource: null,
      workItemKey: null
    }
  }

  function recomputeSession(sessionId: string): void {
    const pings = deps.hookEvents.listBySession(sessionId).map((e) => e.receivedAt)
    const minutesByDate = activeMinutesByDate(pings, IDLE_CAP_MS)
    const { projectId, workItemSource, workItemKey } = attribute(sessionId)
    const computedAt = deps.now()
    const rows: NewAgentRuntimeEvidence[] = [...minutesByDate].map(([localDate, minutes]) => ({
      sessionId,
      localDate,
      minutes,
      source: 'hook',
      confidence: 'high',
      projectId,
      workItemSource,
      workItemKey,
      computedAt
    }))
    deps.repo.replaceForSession(sessionId, rows)
  }

  /**
   * The JSONL transcript fallback: emit one coarse, low-confidence row per historical transcript
   * that hooks never covered, so hooks stay authoritative and nothing is double counted. A
   * transcript is covered when some tab resumes it AND that tab's instance session already has
   * hook activity. The single span is bucketed on its last-activity day and capped like one gap.
   */
  async function recomputeJsonlFallback(): Promise<void> {
    const hookSessions = new Set(deps.hookEvents.listSessions())
    const covered = new Set<string>()
    for (const workspace of deps.workspaces.list()) {
      for (const tab of deps.tabs.listByWorkspace(workspace.id)) {
        if (tab.resumeSessionId && hookSessions.has(makeSessionId(workspace.id, tab.id))) {
          covered.add(tab.resumeSessionId)
        }
      }
    }

    const projects = deps.projects.list()
    const computedAt = deps.now()
    for (const summary of await deps.sessions.list()) {
      if (covered.has(summary.id)) continue
      const minutes = Math.round(Math.min(summary.durationMs, IDLE_CAP_MS) / 60000)
      if (minutes < 1) continue
      const sessionId = `jsonl:${summary.id}`
      deps.repo.replaceForSession(sessionId, [
        {
          sessionId,
          localDate: dayKeyOf(summary.lastTimestamp),
          minutes,
          source: 'jsonl',
          confidence: 'low',
          projectId: resolveProjectForPath(summary.cwd, projects, deps.pathDeps),
          workItemSource: null,
          workItemKey: null,
          computedAt
        }
      ])
    }
  }

  async function recomputeAll(): Promise<void> {
    for (const sessionId of deps.hookEvents.listSessions()) recomputeSession(sessionId)
    await recomputeJsonlFallback()
  }

  return {
    recomputeSession,
    recomputeAll,
    refresh: recomputeAll,

    getWeek(weekStart) {
      return aggregate(deps.repo.listByDays(weekdayKeys(weekStart)))
    },

    getForProject(projectId, weekStart) {
      return aggregate(deps.repo.listForProject(projectId, weekdayKeys(weekStart)))
    },

    getForSession(sessionId) {
      return deps.repo.listForSession(sessionId)
    }
  }
}
