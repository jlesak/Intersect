import { describe, expect, test, vi } from 'vitest'
import type { JiraBoardResult, JiraIssue } from '@common/domain'
import { createJiraIndex } from './jiraIndex'

const issue = (key: string): JiraIssue => ({
  key,
  url: `https://jira.skoda.vwgroup.com/browse/${key}`,
  summary: `Issue ${key}`,
  column: 'todo',
  priority: null,
  updatedAt: 1
})

const okResult = (key: string): JiraBoardResult => ({ ok: true, issues: [issue(key)], fetchedAt: 1 })
const errResult: JiraBoardResult = { ok: false, kind: 'other', message: 'boom' }

describe('createJiraIndex', () => {
  test('list fetches once and then serves from cache', async () => {
    const fetch = vi.fn(async () => okResult('A-1'))
    const index = createJiraIndex({ fetch })
    const first = await index.list()
    const second = await index.list()
    expect(first.ok).toBe(true)
    expect(second).toBe(first)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('concurrent cold-start list calls share one fetch', async () => {
    let resolve!: (r: JiraBoardResult) => void
    const fetch = vi.fn(() => new Promise<JiraBoardResult>((res) => (resolve = res)))
    const index = createJiraIndex({ fetch })
    const a = index.list()
    const b = index.list()
    resolve(okResult('A-1'))
    expect(await a).toBe(await b)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('refresh refetches even when a board is cached', async () => {
    const fetch = vi
      .fn<() => Promise<JiraBoardResult>>()
      .mockResolvedValueOnce(okResult('A-1'))
      .mockResolvedValueOnce(okResult('A-2'))
    const index = createJiraIndex({ fetch })
    await index.list()
    const refreshed = await index.refresh()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(refreshed.ok && refreshed.issues[0].key).toBe('A-2')
    // The refreshed board replaces the cache for subsequent list calls.
    expect(await index.list()).toBe(refreshed)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test('refresh joins an in-flight fetch instead of starting a second one', async () => {
    let resolve!: (r: JiraBoardResult) => void
    const fetch = vi.fn(() => new Promise<JiraBoardResult>((res) => (resolve = res)))
    const index = createJiraIndex({ fetch })
    const listed = index.list()
    const refreshed = index.refresh()
    resolve(okResult('A-1'))
    expect(await listed).toBe(await refreshed)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('a failed fetch is returned but not cached, so the next list retries', async () => {
    const fetch = vi
      .fn<() => Promise<JiraBoardResult>>()
      .mockResolvedValueOnce(errResult)
      .mockResolvedValueOnce(okResult('A-1'))
    const index = createJiraIndex({ fetch })
    expect((await index.list()).ok).toBe(false)
    expect((await index.list()).ok).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test('a failed refresh does not clobber the cached board', async () => {
    const fetch = vi
      .fn<() => Promise<JiraBoardResult>>()
      .mockResolvedValueOnce(okResult('A-1'))
      .mockResolvedValueOnce(errResult)
    const index = createJiraIndex({ fetch })
    const cached = await index.list()
    expect((await index.refresh()).ok).toBe(false)
    expect(await index.list()).toBe(cached)
  })

  test('list serves the persisted snapshot instantly, without fetching', async () => {
    const fetch = vi.fn<() => Promise<JiraBoardResult>>().mockResolvedValue(okResult('LIVE-1'))
    const store = {
      get: vi.fn(() => ({ issues: [issue('DISK-1')], fetchedAt: 7 })),
      put: vi.fn()
    }
    const index = createJiraIndex({ fetch, store })
    const result = await index.list()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.issues.map((i) => i.key)).toEqual(['DISK-1'])
      expect(result.fetchedAt).toBe(7)
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  test('a successful fetch persists the fresh board', async () => {
    const fetch = vi.fn<() => Promise<JiraBoardResult>>().mockResolvedValue(okResult('A-1'))
    const store = { get: vi.fn(() => null), put: vi.fn() }
    const index = createJiraIndex({ fetch, store })
    await index.refresh()
    expect(store.put).toHaveBeenCalledWith({ issues: [issue('A-1')], fetchedAt: 1 })
  })

  test('a failed fetch is never persisted and a store failure never fails the fetch', async () => {
    const fetch = vi
      .fn<() => Promise<JiraBoardResult>>()
      .mockResolvedValueOnce(errResult)
      .mockResolvedValueOnce(okResult('A-1'))
    const store = {
      get: vi.fn(() => null),
      put: vi.fn(() => {
        throw new Error('disk full')
      })
    }
    const index = createJiraIndex({ fetch, store })
    expect((await index.refresh()).ok).toBe(false)
    expect(store.put).not.toHaveBeenCalled()
    expect((await index.refresh()).ok).toBe(true)
  })
})
