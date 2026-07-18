import { describe, expect, test } from 'vitest'
import { jiraWorkItem, prWorkItem, todoWorkItem, workItemTabTitle } from './workItems'

describe('work item builders', () => {
  test('jiraWorkItem keys the ref by the issue key and snapshots key/summary', () => {
    const ref = jiraWorkItem({ key: 'FID2507-611', summary: 'Fix the thing' }, 'p1')
    expect(ref).toEqual({
      source: 'jira',
      externalKey: 'FID2507-611',
      projectId: 'p1',
      snapshot: { key: 'FID2507-611', title: 'Fix the thing', type: 'issue' }
    })
  })

  test('todoWorkItem keys the ref by the task id and never carries a project', () => {
    const ref = todoWorkItem({ id: 't-42', text: 'Water the plants' })
    expect(ref).toEqual({
      source: 'todo',
      externalKey: 't-42',
      projectId: null,
      snapshot: { key: 'TODO', title: 'Water the plants', type: 'task' }
    })
  })

  test('prWorkItem reuses the PR override key and a !<id> chip key', () => {
    const ref = prWorkItem({ repositoryId: 'repo-guid', prId: 123, title: 'Add tests' }, null)
    expect(ref.externalKey).toBe('repo-guid:123')
    expect(ref.snapshot).toEqual({ key: '!123', title: 'Add tests', type: 'pull-request' })
  })

  test('workItemTabTitle defaults per source: key, truncated text, PR !<id>', () => {
    expect(workItemTabTitle(jiraWorkItem({ key: 'AB-1', summary: 's' }, null))).toBe('AB-1')
    expect(workItemTabTitle(todoWorkItem({ id: 't', text: 'Short task' }))).toBe('Short task')
    expect(
      workItemTabTitle(
        todoWorkItem({ id: 't', text: 'A very long todo task text that keeps going on' })
      )
    ).toBe('A very long todo task text th…')
    expect(workItemTabTitle(prWorkItem({ repositoryId: 'r', prId: 7, title: 't' }, null))).toBe(
      'PR !7'
    )
  })
})
