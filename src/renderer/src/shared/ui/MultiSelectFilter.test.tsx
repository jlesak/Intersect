import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { MultiSelectFilter } from './MultiSelectFilter'

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' }
]

/** Mount the control and open its popover, returning the trigger button. */
function opened(): HTMLElement {
  render(
    <MultiSelectFilter
      label="Epic"
      options={OPTIONS}
      selection={null}
      onChange={vi.fn()}
      testId="chip"
    />
  )
  const button = screen.getByTestId('chip')
  fireEvent.click(button)
  expect(screen.getByLabelText('Alpha')).toBeTruthy()
  return button
}

const popover = (): Element | null => document.querySelector('.ix-msel__pop')

/** One press of the mouse, in the order a browser delivers it. */
function realClick(element: Element): void {
  fireEvent.pointerDown(element)
  fireEvent.click(element)
}

/** Two chip controls side by side, as the Jira board shows Epic and Component. */
function twoChips() {
  render(
    <>
      <MultiSelectFilter
        label="Epic"
        options={[{ value: 'e1', label: 'Reporting' }]}
        selection={null}
        onChange={vi.fn()}
        testId="epic"
      />
      <MultiSelectFilter
        label="Component"
        options={[{ value: 'c1', label: 'Excel' }]}
        selection={null}
        onChange={vi.fn()}
        testId="component"
      />
    </>
  )
}

describe('MultiSelectFilter', () => {
  test('Escape closes the popover and hands focus back to the control that opened it', () => {
    const button = opened()
    screen.getByLabelText('Alpha').focus()

    fireEvent.keyDown(screen.getByLabelText('Alpha'), { key: 'Escape' })

    expect(popover()).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  test('Escape on the closed control leaves it closed and is not swallowed', () => {
    render(
      <MultiSelectFilter
        label="Epic"
        options={OPTIONS}
        selection={null}
        onChange={vi.fn()}
        testId="chip"
      />
    )
    const outer = vi.fn()
    document.body.addEventListener('keydown', outer)

    fireEvent.keyDown(screen.getByTestId('chip'), { key: 'Escape' })

    expect(popover()).toBeNull()
    expect(outer).toHaveBeenCalled()
    document.body.removeEventListener('keydown', outer)
  })

  test('focus leaving the control closes it, so Tab cannot walk on behind an open popover', () => {
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    opened()

    fireEvent.focusOut(screen.getByLabelText('Alpha'), { relatedTarget: outside })

    expect(popover()).toBeNull()
    outside.remove()
  })

  test('focus going nowhere in particular leaves it open, or no option could be clicked', () => {
    // Pressing an option's label drops focus a moment before the label hands it to the checkbox.
    opened()

    fireEvent.focusOut(screen.getByLabelText('Alpha'), { relatedTarget: null })

    expect(popover()).not.toBeNull()
  })

  test('focus moving within the control leaves it open', () => {
    opened()

    fireEvent.focusOut(screen.getByLabelText('Alpha'), {
      relatedTarget: screen.getByLabelText('Beta')
    })

    expect(popover()).not.toBeNull()
  })

  test('ticking a value never resurrects one the control no longer offers', () => {
    // The selection still holds "gone", which this dimension has stopped offering. Toggling from
    // the raw selection instead of the pruned one would carry it back into the next selection -
    // invisible today, and quietly narrowing again the moment its option returned.
    const onChange = vi.fn()
    render(
      <MultiSelectFilter
        label="Epic"
        options={[
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta' },
          { value: 'c', label: 'Gamma' }
        ]}
        selection={['a', 'gone']}
        onChange={onChange}
        testId="chip"
      />
    )
    fireEvent.click(screen.getByTestId('chip'))

    fireEvent.click(screen.getByLabelText('Beta'))

    expect(onChange).toHaveBeenCalledWith(['a', 'b'])
  })

  test('one press on a second chip closes the open one and opens it, not just the first', () => {
    twoChips()
    realClick(screen.getByTestId('epic'))
    expect(screen.getByRole('group', { name: 'Epic' })).toBeTruthy()

    realClick(screen.getByTestId('component'))

    expect(document.querySelectorAll('.ix-msel__pop')).toHaveLength(1)
    expect(screen.getByRole('group', { name: 'Component' })).toBeTruthy()
  })

  test('pressing the open chip again closes it rather than reopening it', () => {
    twoChips()
    realClick(screen.getByTestId('epic'))

    realClick(screen.getByTestId('epic'))

    expect(popover()).toBeNull()
  })

  test('pressing anywhere outside puts the popover away', () => {
    const elsewhere = document.createElement('div')
    document.body.appendChild(elsewhere)
    opened()

    fireEvent.pointerDown(elsewhere)

    expect(popover()).toBeNull()
    elsewhere.remove()
  })

  test('pressing inside the popover leaves it open', () => {
    opened()

    fireEvent.pointerDown(screen.getByLabelText('Alpha'))

    expect(popover()).not.toBeNull()
  })

  test('the popover is described as what it is - a named group of checkboxes, not a menu', () => {
    opened()

    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('group', { name: 'Epic' })).toBeTruthy()
  })
})
