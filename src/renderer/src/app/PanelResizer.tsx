import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react'

/** How much one arrow-key press moves a divider. */
export const KEYBOARD_STEP_PX = 8

/** A size that may have to be measured when it is needed rather than stated up front. */
type Measurable = number | (() => number)

const read = (value: Measurable | undefined, fallback: number): number =>
  value === undefined ? fallback : typeof value === 'number' ? value : value()

export interface PanelResizerProps {
  /**
   * `vertical` is a divider between side-by-side panels, dragged left and right (the sidebar's own
   * width). `horizontal` is a divider between stacked panels, dragged up and down.
   */
  orientation: 'vertical' | 'horizontal'
  /** Named for screen readers and for the tooltip, e.g. "Sidebar width". */
  label: string
  /**
   * The size a gesture starts from, read when the gesture begins rather than passed as a number.
   * A panel that has never been dragged has no size of its own - its height has to be measured off
   * the live element, and on the render that mounts this divider that element does not exist yet.
   */
  size: () => number
  /**
   * True when the panel being sized lies *after* the divider, so dragging towards it makes it
   * smaller. The usage panel sits below its divider; the rail sits above its own.
   */
  invert?: boolean
  /** Bounds. Pass a function for one that depends on the window, which a resize changes silently. */
  min?: Measurable
  max?: Measurable
  onResize(px: number): void
  /** Double-click, and the tooltip says so: back to sizing by content. */
  onReset?(): void
  testId?: string
}

/**
 * One draggable divider between two panels.
 *
 * Deliberately not `react-resizable-panels`, which the terminal stage uses: that library owns the
 * whole layout and distributes percentages between panels it renders. The sidebar's panels are a
 * plain flex column whose members come and go (the timer exists only while a timer runs), and what
 * a user wants here is a pixel height for one panel while the middle slot takes the rest. So this
 * moves one number, and the flex column keeps doing the layout.
 *
 * The gesture is tracked on the window rather than through `setPointerCapture`. A divider is a 6px
 * strip the pointer leaves on the first move of any real drag, and capture did not hold in the
 * running app: `hasPointerCapture` came back false and not one `pointermove` arrived, so dragging a
 * stacked panel did nothing at all. Window listeners have no such dependency, and they also keep
 * the drag alive while the pointer is over the panels on either side.
 *
 * Keyboard-operable on purpose: a divider that only answers to a pointer is unreachable for anyone
 * driving the app from the keyboard, and this app is keyboard-first.
 */
export function PanelResizer({
  orientation,
  label,
  size,
  invert = false,
  min,
  max,
  onResize,
  onReset,
  testId
}: PanelResizerProps) {
  // The gesture's own origin, so a drag stays anchored to where it began: deriving each move from
  // the previous one accumulates rounding and drifts away from the pointer.
  const from = useRef<{ pointer: number; size: number } | null>(null)
  const stopTracking = useRef<(() => void) | null>(null)

  // A drag interrupted by an unmount (the sidebar collapses, the panel goes away) must not leave
  // its listeners or the window's resize cursor behind.
  useEffect(() => () => stopTracking.current?.(), [])

  const clamp = (px: number): number =>
    Math.round(Math.min(read(max, Number.POSITIVE_INFINITY), Math.max(read(min, 0), px)))

  const coordinate = (e: { clientX: number; clientY: number }): number =>
    orientation === 'vertical' ? e.clientX : e.clientY

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || from.current) return
    from.current = { pointer: coordinate(e), size: size() }
    // The pointer spends the whole drag away from the divider, so the cursor and the ban on
    // selecting text have to hold for the whole window.
    document.body.classList.add(`ix-resizing--${orientation}`)

    const onMove = (move: globalThis.PointerEvent): void => {
      const start = from.current
      if (!start) return
      const delta = coordinate(move) - start.pointer
      onResize(clamp(start.size + (invert ? -delta : delta)))
    }
    const onEnd = (): void => {
      from.current = null
      stopTracking.current?.()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
    stopTracking.current = () => {
      stopTracking.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
      document.body.classList.remove(`ix-resizing--${orientation}`)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const grow = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown'
    const shrink = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp'
    if (e.key !== grow && e.key !== shrink) return
    e.preventDefault()
    const towards = e.key === grow ? 1 : -1
    onResize(clamp(size() + KEYBOARD_STEP_PX * (invert ? -towards : towards)))
  }

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(size())}
      tabIndex={0}
      className={`ix-resizer ix-resizer--${orientation}`}
      data-testid={testId}
      title={onReset ? `${label} - drag, or double-click to reset` : `${label} - drag to resize`}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    />
  )
}
