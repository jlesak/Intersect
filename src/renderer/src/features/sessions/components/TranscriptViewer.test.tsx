import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import type { SessionSummary } from '@common/domain'
import { useSessionsStore } from '../store'
import { TranscriptViewer } from './TranscriptViewer'

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

  test('another session resuming leaves this one actionable', async () => {
    useSessionsStore.setState({
      all: [summary],
      selectedId: 's1',
      resumingId: 'some-other-session',
      pendingResume: null
    })
    await act(async () => {
      render(<TranscriptViewer />)
    })

    expect(resumeButton().disabled).toBe(false)
    await act(async () => {
      fireEvent.click(resumeButton())
    })
    expect(useSessionsStore.getState().pendingResume?.id).toBe('s1')
  })
})
