import { fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { KEYBOARD_STEP_PX, PanelResizer } from './PanelResizer'

afterEach(() => {
  document.body.className = ''
})

const separator = (): HTMLElement => document.querySelector('[role="separator"]')!

/**
 * A drag is tracked on the window, not on the divider: the pointer leaves the 6px strip on the
 * first move of any real gesture. So the moves are fired at the window here, exactly as the browser
 * delivers them.
 */
const drag = (from: { x: number; y: number }, to: { x: number; y: number }): void => {
  fireEvent.pointerDown(separator(), { button: 0, pointerId: 1, clientX: from.x, clientY: from.y })
  fireEvent.pointerMove(window, { pointerId: 1, clientX: to.x, clientY: to.y })
  fireEvent.pointerUp(window, { pointerId: 1, clientX: to.x, clientY: to.y })
}

describe('PanelResizer', () => {
  test('a horizontal drag moves the size by the distance travelled', () => {
    const onResize = vi.fn()
    render(<PanelResizer orientation="horizontal" label="Rail" size={() => 200} onResize={onResize} />)

    drag({ x: 0, y: 100 }, { x: 0, y: 160 })

    expect(onResize).toHaveBeenLastCalledWith(260)
  })

  test('an inverted divider grows the panel that lies after it when dragged the other way', () => {
    const onResize = vi.fn()
    render(<PanelResizer orientation="horizontal" label="Usage" size={() => 200} invert onResize={onResize} />)

    drag({ x: 0, y: 300 }, { x: 0, y: 240 })

    expect(onResize).toHaveBeenLastCalledWith(260)
  })

  test('a vertical drag follows the horizontal axis', () => {
    const onResize = vi.fn()
    render(<PanelResizer orientation="vertical" label="Width" size={() => 244} onResize={onResize} />)

    drag({ x: 244, y: 0 }, { x: 300, y: 0 })

    expect(onResize).toHaveBeenLastCalledWith(300)
  })

  test('every move is measured from where the gesture began, so a drag cannot drift', () => {
    const onResize = vi.fn()
    render(<PanelResizer orientation="horizontal" label="Rail" size={() => 100} onResize={onResize} />)

    fireEvent.pointerDown(separator(), { button: 0, pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 0, clientY: 10 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 0, clientY: 30 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 0, clientY: 5 })

    expect(onResize.mock.calls.map(([px]) => px)).toEqual([110, 130, 105])
  })

  test('the size never leaves its bounds', () => {
    const onResize = vi.fn()
    render(
      <PanelResizer orientation="horizontal" label="Rail" size={() => 200} min={100} max={300} onResize={onResize} />
    )

    drag({ x: 0, y: 0 }, { x: 0, y: 5000 })
    expect(onResize).toHaveBeenLastCalledWith(300)

    drag({ x: 0, y: 0 }, { x: 0, y: -5000 })
    expect(onResize).toHaveBeenLastCalledWith(100)
  })

  test('the size is read when the gesture begins, not when the divider was drawn', () => {
    // A panel that was never dragged has no size of its own: its height is measured off the live
    // element, which does not exist yet on the render that mounts this divider.
    let live = 0
    const onResize = vi.fn()
    render(
      <PanelResizer orientation="horizontal" label="Rail" size={() => live} onResize={onResize} />
    )

    live = 240
    drag({ x: 0, y: 0 }, { x: 0, y: 30 })

    expect(onResize).toHaveBeenLastCalledWith(270)
  })

  test('a move with no drag in progress changes nothing', () => {
    const onResize = vi.fn()
    render(<PanelResizer orientation="horizontal" label="Rail" size={() => 200} onResize={onResize} />)

    fireEvent.pointerMove(window, { pointerId: 1, clientX: 0, clientY: 400 })

    expect(onResize).not.toHaveBeenCalled()
  })

  test('a non-primary button starts nothing, so a right-click cannot begin a drag', () => {
    const onResize = vi.fn()
    render(<PanelResizer orientation="horizontal" label="Rail" size={() => 200} onResize={onResize} />)

    fireEvent.pointerDown(separator(), { button: 2, pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 0, clientY: 60 })

    expect(onResize).not.toHaveBeenCalled()
  })

  test('the window shows the resize cursor for the whole gesture and stops afterwards', () => {
    render(<PanelResizer orientation="vertical" label="Width" size={() => 244} onResize={vi.fn()} />)

    fireEvent.pointerDown(separator(), { button: 0, pointerId: 1, clientX: 0, clientY: 0 })
    expect(document.body.classList.contains('ix-resizing--vertical')).toBe(true)

    fireEvent.pointerUp(window, { pointerId: 1, clientX: 0, clientY: 0 })
    expect(document.body.classList.contains('ix-resizing--vertical')).toBe(false)
  })

  test('a cancelled gesture releases the window too', () => {
    render(<PanelResizer orientation="horizontal" label="Rail" size={() => 200} onResize={vi.fn()} />)

    fireEvent.pointerDown(separator(), { button: 0, pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerCancel(window, { pointerId: 1, clientX: 0, clientY: 0 })

    expect(document.body.classList.contains('ix-resizing--horizontal')).toBe(false)
  })

  test('the drag follows the pointer once it has left the divider', () => {
    // The whole reason the gesture is tracked on the window: a 6px strip is behind the pointer
    // after the very first move, and listening on the divider alone made dragging do nothing.
    const onResize = vi.fn()
    render(<PanelResizer orientation="horizontal" label="Rail" size={() => 200} onResize={onResize} />)

    fireEvent.pointerDown(separator(), { button: 0, pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(document.body, { pointerId: 1, clientX: 0, clientY: 500 })

    expect(onResize).toHaveBeenLastCalledWith(700)
  })

  test('a finished drag stops listening, so later pointer moves are ignored', () => {
    const onResize = vi.fn()
    render(<PanelResizer orientation="horizontal" label="Rail" size={() => 200} onResize={onResize} />)

    drag({ x: 0, y: 0 }, { x: 0, y: 40 })
    onResize.mockClear()
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 0, clientY: 900 })

    expect(onResize).not.toHaveBeenCalled()
  })

  test('unmounting mid-drag releases the window it took over', () => {
    const view = render(
      <PanelResizer orientation="vertical" label="Width" size={() => 244} onResize={vi.fn()} />
    )

    fireEvent.pointerDown(separator(), { button: 0, pointerId: 1, clientX: 0, clientY: 0 })
    view.unmount()

    expect(document.body.classList.contains('ix-resizing--vertical')).toBe(false)
  })

  test('bounds may be measured at gesture time, not fixed when the divider was drawn', () => {
    let ceiling = 0
    const onResize = vi.fn()
    render(
      <PanelResizer
        orientation="horizontal"
        label="Rail"
        size={() => 200}
        max={() => ceiling}
        onResize={onResize}
      />
    )

    ceiling = 260
    drag({ x: 0, y: 0 }, { x: 0, y: 400 })

    expect(onResize).toHaveBeenLastCalledWith(260)
  })

  test('arrow keys resize it, so a divider is reachable without a pointer', () => {
    const onResize = vi.fn()
    render(<PanelResizer orientation="horizontal" label="Rail" size={() => 200} onResize={onResize} />)

    fireEvent.keyDown(separator(), { key: 'ArrowDown' })
    expect(onResize).toHaveBeenLastCalledWith(200 + KEYBOARD_STEP_PX)

    fireEvent.keyDown(separator(), { key: 'ArrowUp' })
    expect(onResize).toHaveBeenLastCalledWith(200 - KEYBOARD_STEP_PX)
  })

  test('an inverted divider answers the arrow keys the way it answers the pointer', () => {
    const onResize = vi.fn()
    render(<PanelResizer orientation="horizontal" label="Usage" size={() => 200} invert onResize={onResize} />)

    fireEvent.keyDown(separator(), { key: 'ArrowUp' })

    expect(onResize).toHaveBeenLastCalledWith(200 + KEYBOARD_STEP_PX)
  })

  test('it ignores keys that are not its own axis', () => {
    const onResize = vi.fn()
    render(<PanelResizer orientation="horizontal" label="Rail" size={() => 200} onResize={onResize} />)

    fireEvent.keyDown(separator(), { key: 'ArrowLeft' })
    fireEvent.keyDown(separator(), { key: 'Enter' })

    expect(onResize).not.toHaveBeenCalled()
  })

  test('double-click is the way back to sizing by content', () => {
    const onReset = vi.fn()
    render(
      <PanelResizer orientation="horizontal" label="Rail" size={() => 200} onResize={vi.fn()} onReset={onReset} />
    )

    fireEvent.doubleClick(separator())

    expect(onReset).toHaveBeenCalledTimes(1)
    expect(separator().getAttribute('title')).toContain('double-click to reset')
  })

  test('it announces itself as a focusable separator on its own axis', () => {
    render(<PanelResizer orientation="vertical" label="Sidebar width" size={() => 244} onResize={vi.fn()} />)

    expect(separator().getAttribute('aria-orientation')).toBe('vertical')
    expect(separator().getAttribute('aria-label')).toBe('Sidebar width')
    expect(separator().getAttribute('aria-valuenow')).toBe('244')
    expect(separator().tabIndex).toBe(0)
  })
})
