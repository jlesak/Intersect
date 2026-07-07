import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { OtoRun } from '@common/domain'

vi.mock('./ipc')
import * as api from './ipc'
import { useOneOnOneStore } from './store'

const mocked = vi.mocked(api)

const run = (id: string, over: Partial<OtoRun> = {}): OtoRun => ({
  id,
  type: 'prep',
  person: `Person ${id}`,
  vttPath: null,
  status: 'running',
  notionUrl: null,
  slackDraftCreated: false,
  slackChannelLink: null,
  resultMarkdown: null,
  error: null,
  createdAt: 1000,
  finishedAt: null,
  ...over
})

const reset = (): void => {
  useOneOnOneStore.setState({ status: 'idle', error: null, runs: [], showForm: false }, false)
}

beforeEach(() => {
  reset()
  vi.clearAllMocks()
})

describe('load', () => {
  test('fetches the run history and is ready', async () => {
    mocked.list.mockResolvedValue([run('b'), run('a')])
    await useOneOnOneStore.getState().load()
    const s = useOneOnOneStore.getState()
    expect(s.status).toBe('ready')
    expect(s.runs.map((r) => r.id)).toEqual(['b', 'a'])
  })

  test('sets error status when the IPC call fails', async () => {
    mocked.list.mockRejectedValue(new Error('db gone'))
    await useOneOnOneStore.getState().load()
    expect(useOneOnOneStore.getState().status).toBe('error')
    expect(useOneOnOneStore.getState().error).toMatch(/db gone/)
  })
})

describe('showForm', () => {
  test('starts closed and toggles through setShowForm', () => {
    expect(useOneOnOneStore.getState().showForm).toBe(false)
    useOneOnOneStore.getState().setShowForm(true)
    expect(useOneOnOneStore.getState().showForm).toBe(true)
    useOneOnOneStore.getState().setShowForm(false)
    expect(useOneOnOneStore.getState().showForm).toBe(false)
  })
})

describe('start', () => {
  test('prepends the new running run and closes the form', async () => {
    useOneOnOneStore.setState({ status: 'ready', runs: [run('old')], showForm: true })
    mocked.start.mockResolvedValue(run('new'))
    await useOneOnOneStore.getState().start({ type: 'prep', person: 'Tereza N.' })
    expect(mocked.start).toHaveBeenCalledWith({ type: 'prep', person: 'Tereza N.' })
    const s = useOneOnOneStore.getState()
    expect(s.runs.map((r) => r.id)).toEqual(['new', 'old'])
    expect(s.showForm).toBe(false)
  })

  test('a validation failure is re-thrown and keeps the form open', async () => {
    useOneOnOneStore.setState({ status: 'ready', showForm: true })
    mocked.start.mockRejectedValue(new Error('Person must not be empty'))
    await expect(
      useOneOnOneStore.getState().start({ type: 'prep', person: '' })
    ).rejects.toThrow(/must not be empty/)
    expect(useOneOnOneStore.getState().showForm).toBe(true)
    expect(useOneOnOneStore.getState().runs).toEqual([])
  })
})

describe('subscribe', () => {
  test('a pushed run replaces the matching history entry in place', () => {
    useOneOnOneStore.setState({ status: 'ready', runs: [run('b'), run('a')] })
    let push!: (r: OtoRun) => void
    mocked.onRunChanged.mockImplementation((cb) => {
      push = cb
      return () => {}
    })
    useOneOnOneStore.getState().subscribe()

    push(run('a', { status: 'done', resultMarkdown: '## Previous 1:1' }))
    const s = useOneOnOneStore.getState()
    expect(s.runs.map((r) => r.id)).toEqual(['b', 'a'])
    expect(s.runs[1].status).toBe('done')
    expect(s.runs[1].resultMarkdown).toBe('## Previous 1:1')
  })

  test('a pushed run this window has not seen is prepended', () => {
    useOneOnOneStore.setState({ status: 'ready', runs: [run('a')] })
    let push!: (r: OtoRun) => void
    mocked.onRunChanged.mockImplementation((cb) => {
      push = cb
      return () => {}
    })
    useOneOnOneStore.getState().subscribe()

    push(run('fresh', { status: 'failed', error: 'boom' }))
    expect(useOneOnOneStore.getState().runs.map((r) => r.id)).toEqual(['fresh', 'a'])
  })

  test('returns the unsubscribe function from the ipc layer', () => {
    const off = vi.fn()
    mocked.onRunChanged.mockReturnValue(off)
    expect(useOneOnOneStore.getState().subscribe()).toBe(off)
  })
})
