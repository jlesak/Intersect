import type { ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { RowActions } from './RowActions'

const names = (): string[] => screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '')

/** The bar as a row embeds it: inside the activatable row it belongs to. */
function inRow(bar: ReactNode, onRowClick: () => void, onRowDoubleClick?: () => void) {
  return render(
    <div role="button" tabIndex={0} onClick={onRowClick} onDoubleClick={onRowDoubleClick}>
      <span>FID2507-1</span>
      {bar}
    </div>
  )
}

describe('RowActions', () => {
  test('the primary action is a named button that runs on a press', () => {
    const onClick = vi.fn()
    render(<RowActions primary={{ label: 'Start session', onClick }} />)

    fireEvent.click(screen.getByRole('button', { name: 'Start session' }))

    expect(onClick).toHaveBeenCalledTimes(1)
  })

  test('a bar given only a primary action offers nothing else to press', () => {
    render(<RowActions primary={{ label: 'Start session', onClick: vi.fn() }} />)

    expect(names()).toEqual(['Start session'])
  })

  test('an empty overflow list raises no overflow button', () => {
    render(<RowActions primary={{ label: 'Start session', onClick: vi.fn() }} overflow={[]} />)

    expect(names()).toEqual(['Start session'])
  })

  test('the external action is a second named button of its own', () => {
    const onClick = vi.fn()
    render(
      <RowActions primary={{ label: 'Start session', onClick: vi.fn() }} external={{ label: 'Jira', onClick }} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Jira' }))

    expect(onClick).toHaveBeenCalledTimes(1)
  })

  test('the overflow raises a menu whose entry runs and then closes it', () => {
    const onClick = vi.fn()
    render(
      <RowActions
        primary={{ label: 'Start session', onClick: vi.fn() }}
        overflow={[{ label: 'Copy link', onClick }]}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }))

    expect(onClick).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  test('a second press on the overflow closes the menu it opened', () => {
    render(
      <RowActions
        primary={{ label: 'Start session', onClick: vi.fn() }}
        overflow={[{ label: 'Copy link', onClick: vi.fn() }]}
      />
    )
    const trigger = screen.getByRole('button', { name: 'More actions' })

    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeTruthy()

    fireEvent.click(trigger)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  test('pressing a bar button never also activates the row behind it', () => {
    const onRowClick = vi.fn()
    inRow(
      <RowActions
        primary={{ label: 'Start session', onClick: vi.fn() }}
        external={{ label: 'Jira', onClick: vi.fn() }}
        overflow={[{ label: 'Copy link', onClick: vi.fn() }]}
      />,
      onRowClick
    )

    fireEvent.click(screen.getByRole('button', { name: 'Start session' }))
    fireEvent.click(screen.getByRole('button', { name: 'Jira' }))
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))

    expect(onRowClick).not.toHaveBeenCalled()
  })

  test('a double-press on a bar button never activates the row behind it either', () => {
    const onRowDoubleClick = vi.fn()
    inRow(
      <RowActions
        primary={{ label: 'Start session', onClick: vi.fn() }}
        external={{ label: 'Jira', onClick: vi.fn() }}
        overflow={[{ label: 'Copy link', onClick: vi.fn() }]}
      />,
      vi.fn(),
      onRowDoubleClick
    )

    fireEvent.dblClick(screen.getByRole('button', { name: 'Start session' }))
    fireEvent.dblClick(screen.getByRole('button', { name: 'Jira' }))
    fireEvent.dblClick(screen.getByRole('button', { name: 'More actions' }))

    expect(onRowDoubleClick).not.toHaveBeenCalled()
  })

  test('the bar stays revealed while its own menu is open, which lives outside the row', () => {
    const { container } = render(
      <RowActions
        primary={{ label: 'Start session', onClick: vi.fn() }}
        overflow={[{ label: 'Copy link', onClick: vi.fn() }]}
      />
    )
    const bar = container.querySelector('.ix-rowactions')!
    expect(bar.className).not.toContain('ix-rowactions--open')

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))

    expect(bar.className).toContain('ix-rowactions--open')
  })

  test('the render stays quiet, so no bar nests a button inside a button', () => {
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    try {
      inRow(
        <RowActions
          primary={{ label: 'Start session', onClick: vi.fn() }}
          external={{ label: 'Jira', onClick: vi.fn() }}
          overflow={[{ label: 'Copy link', onClick: vi.fn() }]}
        />,
        vi.fn()
      )
      expect(logged).toEqual([])
    } finally {
      consoleError.mockRestore()
    }
  })
})
