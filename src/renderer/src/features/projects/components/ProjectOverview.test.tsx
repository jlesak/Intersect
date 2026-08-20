import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Project } from '@common/domain'
import { usePrInboxStore } from '@renderer/features/prInbox'
import { useProjectsStore } from '../store'
import { ProjectOverview } from './ProjectOverview'

const project: Project = {
  id: 'p1',
  name: 'SPOT',
  sortOrder: 0,
  archived: false,
  repoPaths: ['/repos/spot'],
  jiraJql: 'project = FID2507',
  jiraBoardUrl: null,
  adoRepositories: ['spot-backend']
}

/**
 * The store-reading Overview panel of a project context, mounted client-side. Static markup cannot
 * expose a re-render loop, so only a real root exercises how the panel subscribes to the
 * PR-inbox list.
 */
describe('ProjectOverview', () => {
  afterEach(() => {
    useProjectsStore.setState({ status: 'idle', error: null, projects: [], overrides: [] })
    usePrInboxStore.setState({ status: 'idle', error: null, prsByKey: {}, order: [] })
  })

  test('mounts and settles without a render loop', async () => {
    useProjectsStore.setState({ status: 'ready', error: null, projects: [project], overrides: [] })
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    try {
      await act(async () => {
        render(<ProjectOverview projectId="p1" />)
      })

      expect(logged).toEqual([])
      const hints = [...document.querySelectorAll('.ix-ctx__hint')].map((e) => e.textContent)
      expect(hints[0]).toBe('0 workspaces · 0 pull requests · 0 Jira issues')
    } finally {
      consoleError.mockRestore()
    }
  })
})
