import { useFindStore } from './findStore'

/**
 * Whether a keystroke belongs to the terminal area. A keystroke raised inside the stage does, and
 * so does one raised with nothing focused at all - the user is looking at terminals either way.
 * Anything else is somebody else's surface: an editor, the command palette, a rename field, each
 * with a find of its own that must keep working.
 */
export function isTerminalFindTarget(target: EventTarget | null): boolean {
  if (target === document.body) return true
  return target instanceof Element && target.closest('.ix-stage') !== null
}

/**
 * The terminal a find request is about: the pane the keystroke came from, or - with nothing
 * focused - the first pane actually on screen. Resolution is DOM-first because in a split layout
 * the active tab may hold no pane at all.
 */
export function resolveFindSession(target: EventTarget | null): string | null {
  const owner = target instanceof Element ? target.closest('[data-session-id]') : null
  const pane = owner ?? document.querySelector('.ix-stage [data-session-id]')
  return pane?.getAttribute('data-session-id') ?? null
}

/**
 * Bind Cmd+F to find-in-scrollback for as long as the terminal area is on screen, and answer with
 * the way to unbind it.
 *
 * It is deliberately not an application menu accelerator: macOS answers those before web contents
 * ever see the key, which would take the find widget away from every editor in the app. Meta only,
 * never Ctrl - Ctrl+F is readline's forward-char and belongs to the shell. The listener captures,
 * so the key is spent here rather than being typed into the terminal.
 */
export function installTerminalFindShortcut(): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'f') return
    if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    if (!isTerminalFindTarget(event.target)) return
    const sessionId = resolveFindSession(event.target)
    if (!sessionId) return
    event.preventDefault()
    event.stopPropagation()
    useFindStore.getState().openFind(sessionId)
  }
  document.addEventListener('keydown', onKeyDown, true)
  return () => document.removeEventListener('keydown', onKeyDown, true)
}
