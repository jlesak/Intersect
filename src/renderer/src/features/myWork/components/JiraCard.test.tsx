import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { JiraIssue } from '@common/domain'

vi.mock('@renderer/features/workItems', () => ({ launchFromJiraIssue: vi.fn() }))

import { launchFromJiraIssue } from '@renderer/features/workItems'
import { useMyWorkStore } from '../store'
import { JiraCard } from './JiraCard'

const ISSUE: JiraIssue = {
  key: 'FID2507-11',
  url: 'https://jira.test/browse/FID2507-11',
  summary: 'Rework the spreadsheet exporter',
  column: 'todo',
  priority: 'high',
  updatedAt: Date.now() - 60_000
}

const launch = vi.mocked(launchFromJiraIssue)
const openIssue = vi.fn()
const copyIssueLink = vi.fn()

const card = (): HTMLElement => screen.getByRole('button', { name: /FID2507-11/ })
const press = (name: string): void => {
  fireEvent.click(screen.getByRole('button', { name }))
}

describe('JiraCard', () => {
  beforeEach(() => {
    launch.mockReset()
    openIssue.mockReset()
    copyIssueLink.mockReset()
    useMyWorkStore.setState({ openIssue, copyIssueLink })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('the card advertises the session launch as its primary action', () => {
    render(<JiraCard issue={ISSUE} />)

    expect(screen.getByRole('button', { name: 'Start session' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Jira' })).toBeTruthy()
  })

  test('a plain click on the card starts a session in the issue’s project', () => {
    render(<JiraCard issue={ISSUE} />)

    fireEvent.click(card())

    expect(launch).toHaveBeenCalledWith(ISSUE)
    expect(openIssue).not.toHaveBeenCalled()
  })

  test('Enter on the focused card does exactly what clicking it does', () => {
    render(<JiraCard issue={ISSUE} />)

    fireEvent.keyDown(card(), { key: 'Enter' })

    expect(launch).toHaveBeenCalledWith(ISSUE)
  })

  test('Space activates the card too, as it does any button', () => {
    render(<JiraCard issue={ISSUE} />)

    fireEvent.keyDown(card(), { key: ' ' })

    expect(launch).toHaveBeenCalledWith(ISSUE)
  })

  test('Cmd+Enter opens the issue in the browser instead of starting a session', () => {
    render(<JiraCard issue={ISSUE} />)

    fireEvent.keyDown(card(), { key: 'Enter', metaKey: true })

    expect(openIssue).toHaveBeenCalledWith(ISSUE)
    expect(launch).not.toHaveBeenCalled()
  })

  test('Ctrl+Enter opens the issue too, for a keyboard that has no Cmd', () => {
    render(<JiraCard issue={ISSUE} />)

    fireEvent.keyDown(card(), { key: 'Enter', ctrlKey: true })

    expect(openIssue).toHaveBeenCalledWith(ISSUE)
    expect(launch).not.toHaveBeenCalled()
  })

  test('Cmd+click opens the issue in the browser, matching the chord', () => {
    render(<JiraCard issue={ISSUE} />)

    fireEvent.click(card(), { metaKey: true })

    expect(openIssue).toHaveBeenCalledWith(ISSUE)
    expect(launch).not.toHaveBeenCalled()
  })

  test('the Start session button starts one session, never two', () => {
    render(<JiraCard issue={ISSUE} />)

    press('Start session')

    expect(launch).toHaveBeenCalledTimes(1)
  })

  test('the Jira button opens the browser without starting a session', () => {
    render(<JiraCard issue={ISSUE} />)

    press('Jira')

    expect(openIssue).toHaveBeenCalledWith(ISSUE)
    expect(launch).not.toHaveBeenCalled()
  })

  test('Enter pressed on a bar button is the button’s, never also the card’s', () => {
    render(<JiraCard issue={ISSUE} />)

    fireEvent.keyDown(screen.getByRole('button', { name: 'Start session' }), { key: 'Enter' })

    expect(launch).not.toHaveBeenCalled()
  })

  test('the overflow offers the issue link, and copying it never activates the card', () => {
    render(<JiraCard issue={ISSUE} />)

    press('More actions')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }))

    expect(copyIssueLink).toHaveBeenCalledWith(ISSUE)
    expect(launch).not.toHaveBeenCalled()
  })

  test('an embedding board adds its own entries to the same overflow', () => {
    const assign = vi.fn()
    render(<JiraCard issue={ISSUE} overflow={[{ label: 'Assign to Intersect', onClick: assign }]} />)

    press('More actions')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assign to Intersect' }))

    expect(assign).toHaveBeenCalledTimes(1)
    // The card's own entry is still there alongside it.
    press('More actions')
    expect(screen.getByRole('menuitem', { name: 'Copy link' })).toBeTruthy()
  })

  test('the render stays quiet, so the card nests no button inside a button', () => {
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    try {
      render(<JiraCard issue={ISSUE} />)
      expect(logged).toEqual([])
    } finally {
      consoleError.mockRestore()
    }
  })
})
