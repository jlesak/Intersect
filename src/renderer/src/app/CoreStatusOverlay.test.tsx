import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { CoreStatus } from '@common/ipc'
import { CoreStatusOverlay } from './CoreStatusOverlay'

describe('CoreStatusOverlay', () => {
  test('renders nothing while the core is starting or ready', () => {
    expect(
      renderToStaticMarkup(
        React.createElement(CoreStatusOverlay, { initialStatus: { state: 'starting' } })
      )
    ).toBe('')
    expect(
      renderToStaticMarkup(
        React.createElement(CoreStatusOverlay, { initialStatus: { state: 'ready' } })
      )
    ).toBe('')
  })

  test('a restarting core shows the attempt and reason without any action buttons', () => {
    const host = document.createElement('div')
    host.innerHTML = renderToStaticMarkup(
      React.createElement(CoreStatusOverlay, {
        initialStatus: { state: 'restarting', message: 'core process exited unexpectedly (code 9)', attempt: 2 }
      })
    )

    const dialog = host.querySelector('[role="alertdialog"]')
    expect(dialog).toBeTruthy()
    expect(host.querySelector('h1')?.textContent).toContain('(attempt 2)')
    expect(host.querySelector('.ix-core-failure__reason')?.textContent).toBe(
      'core process exited unexpectedly (code 9)'
    )
    expect(host.querySelectorAll('button')).toHaveLength(0)
  })

  test('a restarting core on a database failure still shows no action buttons', () => {
    const host = document.createElement('div')
    host.innerHTML = renderToStaticMarkup(
      React.createElement(CoreStatusOverlay, {
        initialStatus: {
          state: 'restarting',
          message: 'core bootstrap failed: database migration 1 failed: x',
          attempt: 1,
          databaseFailure: true
        }
      })
    )
    expect(host.querySelectorAll('button')).toHaveLength(0)
  })

  test('a failed core shows the reason with retry, quit, relaunch and reveal actions', () => {
    const host = document.createElement('div')
    host.innerHTML = renderToStaticMarkup(
      React.createElement(CoreStatusOverlay, {
        initialStatus: { state: 'failed', message: 'core bootstrap failed: db is corrupt' }
      })
    )

    const dialog = host.querySelector('[role="alertdialog"]')
    const reason = host.querySelector('.ix-core-failure__reason')
    const labels = [...host.querySelectorAll('button')].map((b) => b.textContent)
    expect(dialog).toBeTruthy()
    expect(host.querySelector('h1')?.textContent).toBe('Background services stopped')
    expect(reason?.textContent).toBe('core bootstrap failed: db is corrupt')
    expect(labels).toEqual(['Retry', 'Quit Intersect', 'Restart Intersect', 'Reveal data folder'])
    for (const button of host.querySelectorAll('button')) {
      expect(button.getAttribute('type')).toBe('button')
    }
  })
})

describe('CoreStatusOverlay - a database that stops every boot', () => {
  const DB_FAILED: CoreStatus = {
    state: 'failed',
    message: 'core bootstrap failed: database migration 1 failed: table workspaces already exists',
    databaseFailure: true
  }

  /** The bridge the card calls, every method a spy; `overrides` replace single methods. */
  function stubBridge(
    overrides: Partial<Record<'startFreshDatabase' | 'revealUserData', () => Promise<void>>> = {}
  ) {
    let push: (status: CoreStatus) => void = () => {}
    const system = {
      onCoreStatus: vi.fn((cb: (status: CoreStatus) => void) => {
        push = cb
        return () => {}
      }),
      retryCore: vi.fn(async () => {}),
      quitApp: vi.fn(async () => {}),
      restartApp: vi.fn(async () => {}),
      revealUserData: vi.fn(overrides.revealUserData ?? (async () => {})),
      startFreshDatabase: vi.fn(overrides.startFreshDatabase ?? (async () => {}))
    }
    ;(window as unknown as { intersect: unknown }).intersect = { system }
    return { system, push: (status: CoreStatus) => act(() => push(status)) }
  }

  const button = (name: string | RegExp): HTMLElement => screen.getByRole('button', { name })
  const START_FRESH = 'Set database aside and start fresh'

  afterEach(() => {
    delete (window as { intersect?: unknown }).intersect
  })

  test('names the database as the cause and says retrying repeats the failure', () => {
    stubBridge()
    render(<CoreStatusOverlay initialStatus={DB_FAILED} />)

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Intersect could not open its database'
    )
    expect(screen.getByRole('alertdialog').textContent).toMatch(
      /Retry and Restart Intersect.*fail the same way/
    )
    expect(document.querySelector('.ix-core-failure__reason')?.textContent).toBe(DB_FAILED.message)
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Retry',
      'Quit Intersect',
      'Restart Intersect',
      'Reveal data folder',
      START_FRESH
    ])
  })

  test('a failure elsewhere offers no set-aside, even when its message is a failed set-aside', () => {
    stubBridge()
    const message =
      'core bootstrap failed: could not set the database aside: renaming intersect.db-wal failed (EACCES). Where the files are now: intersect.db is under its own name'
    render(<CoreStatusOverlay initialStatus={{ state: 'failed', message }} />)

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Background services stopped'
    )
    expect(document.querySelector('.ix-core-failure__reason')?.textContent).toBe(message)
    expect(button('Reveal data folder')).toBeTruthy()
    expect(screen.queryByRole('button', { name: START_FRESH })).toBeNull()
  })

  test('reveal data folder asks main to open the folder, once', () => {
    const { system } = stubBridge()
    render(<CoreStatusOverlay initialStatus={{ state: 'failed', message: 'x' }} />)

    fireEvent.click(button('Reveal data folder'))
    expect(system.revealUserData).toHaveBeenCalledOnce()
  })

  test('start fresh asks for confirmation, and Cancel calls nothing', () => {
    const { system } = stubBridge()
    render(<CoreStatusOverlay initialStatus={DB_FAILED} />)

    fireEvent.click(button(START_FRESH))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeTruthy()
    fireEvent.click(button('Cancel'))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(system.startFreshDatabase).not.toHaveBeenCalled()
    expect(system.retryCore).not.toHaveBeenCalled()
  })

  test('the confirmation names every file, what is lost and kept, and an undo that pairs files right', () => {
    stubBridge()
    render(<CoreStatusOverlay initialStatus={DB_FAILED} />)
    fireEvent.click(button(START_FRESH))
    const text = screen.getByRole('dialog').textContent ?? ''

    for (const name of ['intersect.db', 'intersect.db-wal', 'intersect.db-shm']) {
      expect(text).toContain(name)
    }
    expect(text).toContain('intersect-set-aside-')
    for (const lost of ['workspaces', 'tabs', 'projects', 'settings', 'TODOs', 'time entries']) {
      expect(text).toContain(lost)
    }
    expect(text).toMatch(/1:1 history/)
    expect(text).toMatch(/PR and Jira/)
    expect(text).toMatch(/logs/)

    // Undo: quit, then remove all three new files, then rename all three set-aside files back.
    const steps = [...screen.getByRole('dialog').querySelectorAll('ol li')].map(
      (li) => li.textContent ?? ''
    )
    expect(steps).toHaveLength(4)
    expect(steps[0]).toMatch(/^Quit Intersect/)
    expect(steps[1]).toMatch(/new intersect\.db, intersect\.db-wal and intersect\.db-shm/)
    expect(steps[2]).toMatch(/\.db-wal to intersect\.db-wal/)
    expect(steps[2]).toMatch(/\.db-shm to intersect\.db-shm/)
    expect(steps[2]).toMatch(/\.db to intersect\.db\b/)
    expect(steps[3]).toMatch(/^Start Intersect/)
  })

  test('confirming asks main for a fresh start exactly once', async () => {
    const { system } = stubBridge()
    render(<CoreStatusOverlay initialStatus={DB_FAILED} />)

    fireEvent.click(button(START_FRESH))
    await act(async () => {
      fireEvent.click(button('Set aside and start fresh'))
    })

    expect(system.startFreshDatabase).toHaveBeenCalledOnce()
    expect(system.retryCore).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('the buttons are disabled while the request runs, and a refusal is shown and re-enables them', async () => {
    let refuse: (err: Error) => void = () => {}
    stubBridge({
      startFreshDatabase: () =>
        new Promise<void>((_resolve, reject) => {
          refuse = reject
        })
    })
    render(<CoreStatusOverlay initialStatus={DB_FAILED} />)

    fireEvent.click(button(START_FRESH))
    fireEvent.click(button('Set aside and start fresh'))
    for (const b of screen.getAllByRole('button')) expect((b as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      refuse(new Error('Starting fresh is only offered when the database stopped the core.'))
    })

    expect(screen.getByRole('alertdialog').textContent).toContain(
      'That did not run: Starting fresh is only offered when the database stopped the core.'
    )
    for (const b of screen.getAllByRole('button')) expect((b as HTMLButtonElement).disabled).toBe(false)
  })

  test('a new status clears an earlier refusal', async () => {
    const { push } = stubBridge({
      revealUserData: async () => {
        throw new Error('no folder')
      }
    })
    render(<CoreStatusOverlay initialStatus={DB_FAILED} />)
    await act(async () => {
      fireEvent.click(button('Reveal data folder'))
    })
    expect(screen.getByRole('alertdialog').textContent).toContain('That did not run: no folder')

    push({ state: 'starting' })
    push(DB_FAILED)
    expect(screen.getByRole('alertdialog').textContent).not.toContain('That did not run')
  })
})
