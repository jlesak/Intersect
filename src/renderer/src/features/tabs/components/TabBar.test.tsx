import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Tab, WorkItemRef } from '@common/domain'
import { makeSessionId } from '@common/ipc'
import { useAttentionStore } from '@renderer/features/attention'
import { useWorkItemsStore } from '@renderer/features/workItems'
import { useTabsStore } from '../store'
import { TabBar } from './TabBar'

const WORKSPACE_ID = 'ws1'

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    title: id,
    preset: 'shell',
    paneSlot: null,
    sortOrder: 0,
    resumeSessionId: null,
    sessionStatus: null,
    suspendReason: null,
    suspendedAt: null,
    ...over
  }
}

function workItem(tabId: string): WorkItemRef {
  return {
    tabId,
    source: 'jira',
    externalKey: 'FID2507-611',
    projectId: 'p1',
    snapshot: { key: 'FID2507-611', title: 'Repair the importer', type: 'Task' },
    state: 'linked',
    assignedAt: 1
  }
}

/** A hydrated workspace with three tabs, one of them carrying a work item and an attention state. */
function seedTabs(): void {
  useTabsStore.setState({
    status: 'ready',
    error: null,
    workspaceId: WORKSPACE_ID,
    byId: {
      t1: tab('t1', { title: 'shell', paneSlot: 0 }),
      t2: tab('t2', { title: 'claude', preset: 'claude', paneSlot: 1, sortOrder: 1 }),
      t3: tab('t3', { title: 'logs', sortOrder: 2 })
    },
    order: ['t1', 't2', 't3'],
    layout: 'columns',
    activeTabId: 't2',
    presetPickerOpen: false
  })
  useWorkItemsStore.setState({ workspaceId: WORKSPACE_ID, byTabId: { t2: workItem('t2') } })
  useAttentionStore.setState({
    status: { [makeSessionId(WORKSPACE_ID, 't2')]: { status: 'waiting', since: Date.now() } }
  })
}

/**
 * The tab bar, mounted client-side. Static markup cannot expose a re-render loop, so only a real
 * root exercises how the bar subscribes to the tab list.
 */
describe('TabBar', () => {
  afterEach(() => {
    useTabsStore.setState({
      status: 'idle',
      error: null,
      workspaceId: null,
      byId: {},
      order: [],
      layout: 'single',
      activeTabId: null,
      presetPickerOpen: false
    })
    useWorkItemsStore.setState({ workspaceId: null, byTabId: {} })
    useAttentionStore.setState({ status: {} })
  })

  test('mounts and settles without a render loop', async () => {
    seedTabs()
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    try {
      await act(async () => {
        render(<TabBar />)
      })

      expect(logged).toEqual([])
      const titles = [...document.querySelectorAll('.ix-tab__title')].map((e) => e.textContent)
      expect(titles).toEqual(['shell', 'claude', 'logs'])
      expect(document.querySelectorAll('.ix-tab--active')).toHaveLength(1)
      expect(document.querySelector('.ix-tab__workitem')?.textContent).toBe('FID2507-611')
    } finally {
      consoleError.mockRestore()
    }
  })

  test('reordering the tabs re-renders the subscribed bar', async () => {
    seedTabs()

    await act(async () => {
      render(<TabBar />)
    })
    await act(async () => {
      useTabsStore.setState({ order: ['t3', 't1', 't2'] })
    })

    const titles = [...document.querySelectorAll('.ix-tab__title')].map((e) => e.textContent)
    expect(titles).toEqual(['logs', 'shell', 'claude'])
  })
})
