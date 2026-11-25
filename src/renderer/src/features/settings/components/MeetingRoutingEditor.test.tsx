import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useProjectsStore } from '@renderer/features/projects'
import { useSettingsStore } from '../store'
import { MeetingRoutingEditor } from './MeetingRoutingEditor'

beforeEach(() => {
  useSettingsStore.setState({ meetingRouting: { rules: [], defaultTarget: { kind: 'unassigned' } } })
  useProjectsStore.setState({ projects: [{ id: 'p1', name: 'Build', repoPaths: ['/work/build'], archived: false,
    sortOrder: 0, jiraJql: null, jiraBoardUrl: null, adoRepositories: [] }] })
})

describe('MeetingRoutingEditor', () => {
  test('saves ordered literal patterns with issue and project alternatives', async () => {
    const save = vi.spyOn(useSettingsStore.getState(), 'saveMeetingRouting').mockResolvedValue()
    render(<MeetingRoutingEditor />)
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    fireEvent.change(screen.getByLabelText('Pattern 1'), { target: { value: 'review' } })
    fireEvent.change(screen.getByLabelText('Target type 1'), { target: { value: 'issue' } })
    fireEvent.change(screen.getByLabelText('Issue key 1'), { target: { value: 'APP-12' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    fireEvent.change(screen.getByLabelText('Pattern 2'), { target: { value: 'planning' } })
    fireEvent.change(screen.getByLabelText('Target type 2'), { target: { value: 'project' } })
    fireEvent.change(screen.getByLabelText('Project 2'), { target: { value: 'p1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save routing' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({
      rules: [
        { pattern: 'review', target: { kind: 'issue', issueKey: 'APP-12' } },
        { pattern: 'planning', target: { kind: 'project', projectId: 'p1' } }
      ], defaultTarget: { kind: 'unassigned' }
    }))
  })
})
