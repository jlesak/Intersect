import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { JiraIssueSnapshot } from '@common/domain'

// The board reaches the My Work store, which reaches the PR inbox barrel and through it monaco -
// and monaco cannot initialise under jsdom.
vi.mock('monaco-editor', () => ({ editor: {} }))

import { JiraBoard } from './JiraBoard'

function issue(
  over: Partial<JiraIssueSnapshot> & Pick<JiraIssueSnapshot, 'key'>
): JiraIssueSnapshot {
  return {
    url: `https://jira.test/browse/${over.key}`,
    summary: '',
    column: 'todo',
    priority: null,
    updatedAt: 0,
    description: null,
    rawStatus: 'To Do',
    rawPriority: null,
    assignee: null,
    epicKey: null,
    epicSummary: null,
    estimateSeconds: null,
    components: [],
    fetchedAt: 0,
    absent: false,
    ...over
  }
}

const ISSUES: JiraIssueSnapshot[] = [
  issue({
    key: 'FID2507-11',
    summary: 'Rework the spreadsheet exporter',
    column: 'todo',
    components: ['Excel'],
    epicKey: 'FID2507-90',
    epicSummary: 'Reporting'
  }),
  issue({
    key: 'FID2507-12',
    summary: 'Implement the login flow',
    column: 'progress',
    components: ['Backend'],
    epicKey: 'FID2507-91',
    epicSummary: 'Platform'
  })
]

const cardKeys = (): string[] =>
  screen.queryAllByText(/^FID2507-\d+$/).map((node) => node.textContent ?? '')

const column = (name: string): HTMLElement =>
  document.querySelector<HTMLElement>(`.ix-mw-col--${name}`)!

const type = (value: string): void => {
  fireEvent.change(screen.getByTestId('jira-filter'), { target: { value } })
}

/** Open a chip control, clear it, and tick one option - the gesture for "only this one". */
const pickOnly = (testId: string, option = 'Backend'): void => {
  fireEvent.click(screen.getByTestId(testId))
  fireEvent.click(screen.getByText('None'))
  fireEvent.click(screen.getByLabelText(option))
}

describe('JiraBoard filtering', () => {
  test('typing letters scattered through a summary leaves only that issue on the board', () => {
    render(<JiraBoard issues={ISSUES} />)
    expect(cardKeys()).toEqual(['FID2507-11', 'FID2507-12'])

    type('sprdsht')

    expect(cardKeys()).toEqual(['FID2507-11'])
  })

  test('a column the filter emptied collapses but still says which column it is', () => {
    render(<JiraBoard issues={ISSUES} />)
    expect(column('progress').className).not.toContain('ix-mw-col--collapsed')

    type('sprdsht')

    expect(column('progress').className).toContain('ix-mw-col--collapsed')
    expect(within(column('progress')).getByText('Progress')).toBeTruthy()
    // The column that kept a card is untouched, so collapsing is about emptiness, not about the
    // filter merely being switched on.
    expect(column('todo').className).not.toContain('ix-mw-col--collapsed')
  })

  test('a column nothing ever put a card in is collapsed from the start', () => {
    render(<JiraBoard issues={ISSUES} />)
    expect(column('waiting').className).toContain('ix-mw-col--collapsed')
    expect(within(column('waiting')).getByText('Waiting')).toBeTruthy()
  })

  test('a filter that matches nothing says so instead of leaving five blank strips', () => {
    render(<JiraBoard issues={ISSUES} />)

    type('zzzz')

    expect(cardKeys()).toEqual([])
    expect(screen.getByText(/No issues match/)).toBeTruthy()
  })

  test('picking a component leaves only the issues carrying it', () => {
    render(<JiraBoard issues={ISSUES} />)
    pickOnly('jira-filter-component')

    expect(cardKeys()).toEqual(['FID2507-12'])
  })

  test('picking an epic leaves only the issues under it', () => {
    render(<JiraBoard issues={ISSUES} />)
    pickOnly('jira-filter-epic', 'Reporting')

    expect(cardKeys()).toEqual(['FID2507-11'])
  })

  test('unticking one value keeps everything else, so the control narrows rather than resets', () => {
    render(<JiraBoard issues={ISSUES} />)
    fireEvent.click(screen.getByTestId('jira-filter-component'))
    fireEvent.click(screen.getByLabelText('Backend'))

    expect(cardKeys()).toEqual(['FID2507-11'])
  })

  test('a board whose issues carry no epic offers no epic control to press', () => {
    render(<JiraBoard issues={[issue({ key: 'FID2507-13', summary: 'Tidy the changelog' })]} />)

    expect(screen.queryByTestId('jira-filter-epic')).toBeNull()
    expect(screen.queryByTestId('jira-filter-component')).toBeNull()
    // The free-text box is not derived from the data, so it is always there to type in.
    expect(screen.getByTestId('jira-filter')).toBeTruthy()
  })

  test('the bar says how much of the board is left once it is narrowed', () => {
    render(<JiraBoard issues={ISSUES} />)
    expect(screen.queryByTestId('jira-filter-count')).toBeNull()

    type('sprdsht')

    expect(screen.getByTestId('jira-filter-count').textContent).toBe('1 of 2')
  })
})
