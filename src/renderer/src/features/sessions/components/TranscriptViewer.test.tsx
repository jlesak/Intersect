import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import type { SessionSummary, SessionTranscript, TranscriptEntry } from '@common/domain'
import { useSessionsStore } from '../store'
import { groupTranscriptItems, TranscriptViewer } from './TranscriptViewer'

const summary: SessionSummary = {
  id: 's1',
  filePath: '/p/s1.jsonl',
  cwd: '/repos/spot',
  folderName: 'spot',
  title: 'Fix the sync',
  gitBranch: 'main',
  firstTimestamp: 1_000_000,
  lastTimestamp: 2_000_000,
  durationMs: 1_000_000,
  activeDurationMs: 500_000,
  messageCount: 4,
  userPrompts: ['make the sync idempotent']
}

const resumeButton = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('.ix-transcript__header .ix-btn--primary')!

const entry = (over: Partial<TranscriptEntry>): TranscriptEntry => ({
  role: 'assistant',
  text: '',
  timestamp: 0,
  tools: [],
  ...over
})

const transcript: SessionTranscript = {
  id: 's1',
  title: 'Fix the sync',
  cwd: '/repos/spot',
  entries: [
    entry({ role: 'user', text: 'Find the red needle' }),
    entry({ tools: ['Read src/sync.ts', 'Grep "needle"'] }),
    entry({ tools: ['Bash: git status'] }),
    entry({ text: 'The red needle is in the retry branch.' })
  ]
}

describe('TranscriptViewer resume action', () => {
  afterEach(() => {
    useSessionsStore.setState({
      all: [],
      selectedId: null,
      transcript: null,
      transcriptStatus: 'idle',
      pendingResume: null,
      resumingId: null
    })
  })

  test('asks to resume the selected session', async () => {
    useSessionsStore.setState({ all: [summary], selectedId: 's1', resumingId: null, pendingResume: null })
    await act(async () => {
      render(<TranscriptViewer />)
    })

    expect(resumeButton().textContent).toBe('Resume')
    await act(async () => {
      fireEvent.click(resumeButton())
    })
    expect(useSessionsStore.getState().pendingResume?.id).toBe('s1')
  })

  test('a resume already under way cannot be asked for a second time', async () => {
    useSessionsStore.setState({ all: [summary], selectedId: 's1', resumingId: null, pendingResume: null })
    await act(async () => {
      render(<TranscriptViewer />)
    })
    await act(async () => {
      fireEvent.click(resumeButton())
    })
    // The app layer took the request and reports it as in flight.
    await act(async () => {
      useSessionsStore.getState().clearResume()
      useSessionsStore.getState().markResuming('s1')
    })

    expect(resumeButton().textContent).toContain('Resuming')
    await act(async () => {
      fireEvent.click(resumeButton())
    })
    expect(useSessionsStore.getState().pendingResume).toBeNull()

    // Once it finishes the action is live again.
    await act(async () => {
      useSessionsStore.getState().markResuming(null)
    })
    await act(async () => {
      fireEvent.click(resumeButton())
    })
    expect(useSessionsStore.getState().pendingResume?.id).toBe('s1')
  })

  test('another session resuming blocks this one, since the app layer runs them one at a time', async () => {
    useSessionsStore.setState({
      all: [summary],
      selectedId: 's1',
      resumingId: 'some-other-session',
      pendingResume: null
    })
    await act(async () => {
      render(<TranscriptViewer />)
    })

    // Blocked, but not mislabelled: it is the other session that is resuming, not this one.
    expect(resumeButton().textContent).toBe('Resume')
    await act(async () => {
      fireEvent.click(resumeButton())
    })
    expect(useSessionsStore.getState().pendingResume).toBeNull()
  })

  test('groups uninterrupted tool-only records into one collapsed block', () => {
    const items = groupTranscriptItems(transcript.entries)

    expect(items).toHaveLength(3)
    expect(items[1]).toMatchObject({
      kind: 'tools',
      tools: ['Read src/sync.ts', 'Grep "needle"', 'Bash: git status']
    })
  })

  test('keeps a tool batch collapsed until it is explicitly expanded', async () => {
    useSessionsStore.setState({
      all: [summary],
      selectedId: 's1',
      transcript,
      transcriptStatus: 'ready'
    })
    await act(async () => {
      render(<TranscriptViewer />)
    })

    const toggle = document.querySelector<HTMLButtonElement>('.ix-transcript__tool-toggle')!
    expect(toggle.textContent).toContain('3 tool calls')
    expect(document.querySelector('.ix-transcript__tool-list')).toBeNull()

    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(document.querySelector('.ix-transcript__tool-list')?.textContent).toContain('Bash: git status')
  })

  test('finds messages within the open session and navigates their matches', async () => {
    useSessionsStore.setState({
      all: [summary],
      selectedId: 's1',
      transcript,
      transcriptStatus: 'ready'
    })
    await act(async () => {
      render(<TranscriptViewer />)
    })

    const search = document.querySelector<HTMLInputElement>('.ix-transcript__search-input')!
    await act(async () => {
      fireEvent.change(search, { target: { value: 'needle' } })
    })

    expect(document.querySelector('.ix-transcript__match-count')?.textContent).toBe('1 / 2')
    expect(document.querySelectorAll('.ix-transcript__entry--match')).toHaveLength(2)
    await act(async () => {
      fireEvent.click(document.querySelector('[aria-label="Next matching message"]')!)
    })
    expect(document.querySelector('.ix-transcript__match-count')?.textContent).toBe('2 / 2')
  })
})
