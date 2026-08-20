import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { OtoRun } from '@common/domain'

vi.mock('../ipc')
import * as api from '../ipc'
import { useOneOnOneStore } from '../store'
import { OneOnOneView } from './OneOnOneView'

const mocked = vi.mocked(api)

const run = (id: string, person: string, createdAt: number): OtoRun => ({
  id,
  type: 'prep',
  person,
  vttPath: null,
  status: 'done',
  notionUrl: null,
  slackDraftCreated: false,
  slackChannelLink: null,
  resultMarkdown: null,
  error: null,
  createdAt,
  finishedAt: createdAt + 1000
})

const RUNS = [
  run('1', 'Tereza N.', 400),
  run('2', 'Marek K.', 300),
  run('3', 'Tereza N.', 200),
  run('4', 'marek k', 100)
]

const offeredPeople = (): string[] =>
  [...document.querySelectorAll('#oto-people option')].map((o) => o.getAttribute('value') ?? '')

const headings = (): string[] =>
  [...document.querySelectorAll('.ix-oto-person__name')].map((el) => el.textContent ?? '')

/** What the section makes of a history it has been keeping for a while. */
describe('OneOnOneView', () => {
  beforeEach(() => {
    mocked.list.mockResolvedValue(RUNS)
    useOneOnOneStore.setState({ status: 'ready', error: null, runs: RUNS, showForm: false })
  })

  afterEach(() => {
    useOneOnOneStore.setState({ status: 'idle', runs: [], showForm: false })
  })

  const mount = async (): Promise<void> => {
    await act(async () => {
      render(<OneOnOneView />)
    })
  }

  test('the person field offers everyone the history knows, most recently used first', async () => {
    useOneOnOneStore.setState({ showForm: true })
    await mount()

    expect(screen.getByPlaceholderText('e.g. Marek K.').getAttribute('list')).toBe('oto-people')
    // "marek k" drifted from "Marek K.", so it is one person under the newest spelling.
    expect(offeredPeople()).toEqual(['Tereza N.', 'Marek K.'])
  })

  test('a person new to the history is still typeable, because the field is free text', async () => {
    useOneOnOneStore.setState({ showForm: true })
    await mount()

    expect((screen.getByPlaceholderText('e.g. Marek K.') as HTMLInputElement).readOnly).toBe(false)
  })

  test('the history is gathered per person, whoever was run last at the top', async () => {
    await mount()

    expect(headings()).toEqual(['Tereza N.', 'Marek K.'])
  })

  test('every run is still shown, under the person it belongs to', async () => {
    await mount()

    const groups = document.querySelectorAll('.ix-oto-person__runs')
    expect(groups[0].querySelectorAll('.ix-oto-run')).toHaveLength(2)
    expect(groups[1].querySelectorAll('.ix-oto-run')).toHaveLength(2)
  })

  test('an empty history offers nobody and groups nothing', async () => {
    mocked.list.mockResolvedValue([])
    useOneOnOneStore.setState({ runs: [], showForm: true })
    await mount()

    expect(offeredPeople()).toEqual([])
    expect(headings()).toEqual([])
  })
})
