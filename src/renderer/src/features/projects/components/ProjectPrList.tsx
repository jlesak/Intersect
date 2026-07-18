import { useEffect, useMemo, useState } from 'react'
import type { PullRequest } from '@common/domain'
import { indexOverrides, prOverrideKey, resolvePrProject } from '@common/projectAssign'
import { useMyWorkStore } from '@renderer/features/myWork'
import { selectPrList, usePrInboxStore } from '@renderer/features/prInbox'
import { ContextMenu, type MenuEntry } from '@renderer/shared/ui/ContextMenu'
import { IconRefresh } from '@renderer/shared/ui/icons'
import { selectActiveProjects, useProjectsStore } from '../store'

/**
 * The Pull Requests entry point of a project context: the PR Inbox cache narrowed to the PRs of
 * this project's Azure DevOps repository bindings (manual pins always win). Rows open the full
 * detail in the PR Review section - review work stays in one place.
 */
export function ProjectPrList({ projectId }: { projectId: string | null }) {
  const status = usePrInboxStore((s) => s.status)
  const prs = usePrInboxStore(selectPrList)
  const projects = useProjectsStore((s) => s.projects)
  const overrides = useProjectsStore((s) => s.overrides)
  const [menu, setMenu] = useState<{ x: number; y: number; pr: PullRequest } | null>(null)

  useEffect(() => {
    if (usePrInboxStore.getState().status === 'idle') void usePrInboxStore.getState().hydrate()
  }, [])

  const filtered = useMemo(() => {
    const index = indexOverrides(overrides)
    return prs.filter((pr) => {
      const key = prOverrideKey(pr.repositoryId, pr.prId)
      const override = index.get(`pr ${key}`)
      const effective = override
        ? override.projectId
        : resolvePrProject(pr.repositoryName, projects)
      return effective === projectId
    })
  }, [prs, projects, overrides, projectId])

  const assignEntries = (pr: PullRequest): MenuEntry[] => {
    const key = prOverrideKey(pr.repositoryId, pr.prId)
    const active = selectActiveProjects(useProjectsStore.getState())
    const hasOverride = overrides.some((o) => o.kind === 'pr' && o.key === key)
    return [
      ...active
        .filter((p) => p.id !== projectId)
        .map((p) => ({
          label: `Assign to ${p.name}`,
          onClick: () => void useProjectsStore.getState().setOverride('pr', key, p.id)
        })),
      ...(projectId !== null
        ? [
            {
              label: 'Assign to Other',
              onClick: () => void useProjectsStore.getState().setOverride('pr', key, null)
            }
          ]
        : []),
      ...(hasOverride
        ? [
            {
              label: 'Assign automatically (by repository)',
              onClick: () => void useProjectsStore.getState().clearOverride('pr', key)
            }
          ]
        : [])
    ]
  }

  if (filtered.length === 0) {
    return (
      <div className="ix-empty">
        <span className="ix-eyebrow">Pull Requests</span>
        <div className="ix-empty__title">
          {status === 'loading' ? 'Loading…' : 'No pull requests here'}
        </div>
        <p className="ix-empty__hint">
          {projectId === null
            ? 'Every cached PR matched a project.'
            : 'No cached PR belongs to this project’s bound repositories.'}
        </p>
        <button
          type="button"
          className="ix-btn"
          onClick={() => void usePrInboxStore.getState().sync()}
        >
          <IconRefresh /> Sync
        </button>
      </div>
    )
  }

  return (
    <div className="ix-ctx__panel">
      <div className="ix-ctx__list" role="list">
        {filtered.map((pr) => (
          <div
            key={`${pr.repositoryId}:${pr.prId}`}
            role="listitem"
            tabIndex={0}
            className="ix-ctx__row"
            onClick={() => useMyWorkStore.getState().openPr(pr.repositoryId, pr.prId)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') useMyWorkStore.getState().openPr(pr.repositoryId, pr.prId)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, pr })
            }}
          >
            <span className="ix-ctx__row-title">{pr.title}</span>
            <span className="ix-ctx__row-meta">
              !{pr.prId} · {pr.repositoryName} · {pr.authorName}
              {pr.role === 'author' ? ' · mine' : ''}
            </span>
          </div>
        ))}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          entries={assignEntries(menu.pr)}
        />
      )}
    </div>
  )
}
