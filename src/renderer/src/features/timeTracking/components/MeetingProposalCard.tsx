import type { MeetingProposal } from '@common/domain'
import { useProjectsStore } from '@renderer/features/projects'
import { useMeetingsStore } from '../meetingsStore'
import { formatTotal } from '../time'

export function MeetingProposalCard({ proposal }: { proposal: MeetingProposal }) {
  const projectName = useProjectsStore((s) =>
    proposal.projectId ? s.projects.find((p) => p.id === proposal.projectId)?.name ?? 'Other' : null)
  const target = proposal.issueKey ?? projectName ?? 'Unassigned'
  return (
    <div className="ix-tt-proposal" data-proposal-id={proposal.externalId}>
      <div className="ix-tt-proposal__label">Suggested meeting · {formatTotal(proposal.durationMs)}</div>
      <div className="ix-tt-proposal__title">{proposal.description}</div>
      <div className="ix-tt-proposal__target">{target}</div>
      <div className="ix-tt-proposal__actions">
        <button type="button" className="ix-btn ix-btn--primary"
          onClick={() => void useMeetingsStore.getState().accept(proposal)}>Accept</button>
        <button type="button" className="ix-btn ix-btn--ghost"
          onClick={() => void useMeetingsStore.getState().decline(proposal)}>Decline</button>
      </div>
    </div>
  )
}
