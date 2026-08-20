import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { OtoRun } from '@common/domain'

vi.mock('../ipc')
import * as api from '../ipc'
import { useOneOnOneStore } from '../store'
import { RunCard } from './RunCard'

const mocked = vi.mocked(api)

const failed = (over: Partial<OtoRun> = {}): OtoRun => ({
  id: 'r1',
  type: 'process',
  person: 'Marek K.',
  vttPath: '/recordings/marek-1-1.vtt',
  status: 'failed',
  notionUrl: null,
  slackDraftCreated: false,
  slackChannelLink: null,
  resultMarkdown: null,
  error: 'Stubbed workflow failure',
  createdAt: 1000,
  finishedAt: 2000,
  ...over
})

const retryButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement

/** What a failed run can still do about itself. */
describe('RunCard retry', () => {
  beforeEach(() => {
    mocked.start.mockReset()
    useOneOnOneStore.setState({ status: 'ready', error: null, runs: [], showForm: false })
  })

  afterEach(() => {
    useOneOnOneStore.setState({ status: 'idle', runs: [], showForm: false })
  })

  const mount = async (run: OtoRun): Promise<void> => {
    await act(async () => {
      render(<RunCard run={run} />)
    })
  }

  test('a failed run starts again with its own type, person and recording', async () => {
    const run = failed()
    mocked.start.mockResolvedValue({ ...run, id: 'r2', status: 'running', error: null })
    await mount(run)

    await act(async () => {
      fireEvent.click(retryButton())
    })

    expect(mocked.start).toHaveBeenCalledWith({
      type: 'process',
      person: 'Marek K.',
      vttPath: '/recordings/marek-1-1.vtt'
    })
  })

  test('the retry is a new run, and the failed one stays in the history', async () => {
    const run = failed()
    useOneOnOneStore.setState({ runs: [run] })
    mocked.start.mockResolvedValue({ ...run, id: 'r2', status: 'running', error: null })
    await mount(run)

    await act(async () => {
      fireEvent.click(retryButton())
    })

    expect(useOneOnOneStore.getState().runs.map((r) => r.id)).toEqual(['r2', 'r1'])
    expect(useOneOnOneStore.getState().runs[1].status).toBe('failed')
  })

  test('a second press while the first is in flight starts nothing more', async () => {
    const run = failed()
    let release = (): void => {}
    mocked.start.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ ...run, id: 'r2', status: 'running', error: null })
      })
    )
    await mount(run)

    fireEvent.click(retryButton())
    expect(retryButton().disabled).toBe(true)
    fireEvent.click(retryButton())

    await act(async () => {
      release()
    })

    expect(mocked.start).toHaveBeenCalledTimes(1)
  })

  test('a refused retry answers on the card that asked, and the button comes back', async () => {
    const run = failed()
    mocked.start.mockRejectedValue(new Error('The VTT file does not exist: /recordings/gone.vtt'))
    await mount(run)

    await act(async () => {
      fireEvent.click(retryButton())
    })

    expect(document.querySelector('.ix-oto-run__retry-error')?.textContent).toBe(
      'The VTT file does not exist: /recordings/gone.vtt'
    )
    expect(retryButton().disabled).toBe(false)
  })

  test('a run that is running or done offers no retry, because there is nothing to redo', async () => {
    await mount(failed({ status: 'done', error: null }))

    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })
})
