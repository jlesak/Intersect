/**
 * The single source of truth for the app-wide keyboard layer. The native macOS menu turns each
 * entry into an accelerator and the command palette renders the same entry as a hint, so a
 * shortcut and its palette command can never drift apart. Behaviour lives nowhere here - the
 * menu only dispatches `id`, and the renderer resolves it through the command registry.
 */

/** The top-level menu an action is filed under. */
export type ShortcutMenu = 'file' | 'view' | 'window'

/**
 * One app-wide action: what the user sees, the key that reaches it, and the command id both the
 * menu and the palette dispatch.
 */
export interface ShortcutAction {
  id: string
  label: string
  accelerator: string
  menu: ShortcutMenu
  /** True for actions that should not appear in the command palette. */
  hidden?: boolean
}

/**
 * Jump straight to the Nth tab. Positional and therefore worthless to type into the palette -
 * nobody searches for "Tab 4" - so these stay hidden and live in a menu submenu instead.
 */
const TAB_JUMPS: readonly ShortcutAction[] = Array.from({ length: 9 }, (_unused, index) => {
  const n = index + 1
  return {
    id: `tabs.jump.${n}`,
    label: `Tab ${n}`,
    accelerator: `CmdOrCtrl+${n}`,
    menu: 'window' as const,
    hidden: true
  }
})

/**
 * The approved shortcut map. Array order is menu order: filtering by `menu` yields the items of
 * that menu already in the sequence they should be shown in.
 */
export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  { id: 'tabs.new', label: 'New Tab', accelerator: 'CmdOrCtrl+T', menu: 'file' },
  {
    id: 'tabs.newWithPreset',
    label: 'New Tab with Preset…',
    accelerator: 'CmdOrCtrl+Shift+T',
    menu: 'file'
  },
  { id: 'tabs.close', label: 'Close Tab', accelerator: 'CmdOrCtrl+W', menu: 'file' },
  {
    // Reachable from the menu, but never listed inside the palette it opens: running it from
    // there would close and immediately reopen the palette, which reads as a broken command.
    id: 'palette.open',
    label: 'Command Palette',
    accelerator: 'CmdOrCtrl+K',
    menu: 'view',
    hidden: true
  },
  { id: 'shell.toggleSidebar', label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', menu: 'view' },
  { id: 'projects.next', label: 'Switch Project', accelerator: 'CmdOrCtrl+Shift+P', menu: 'view' },
  {
    id: 'attention.jumpOldestWaiting',
    label: 'Jump to Waiting Session',
    accelerator: 'CmdOrCtrl+Shift+A',
    menu: 'view'
  },
  { id: 'tabs.next', label: 'Next Tab', accelerator: 'Control+Tab', menu: 'window' },
  ...TAB_JUMPS
]

/**
 * The shortcut a command id owns, or undefined for a command that has none. Lets the command
 * palette derive a command's key hint and its palette visibility from the shortcut map instead of
 * repeating either on the command itself, so the two can never disagree.
 */
export function shortcutActionFor(id: string): ShortcutAction | undefined {
  return SHORTCUT_ACTIONS.find((action) => action.id === id)
}

// Every spelling Electron accepts for a modifier, mapped to the glyph macOS prints for it.
// `CmdOrCtrl` resolves to Command because this app ships for macOS.
const MODIFIER_GLYPHS: Record<string, string> = {
  control: '⌃',
  ctrl: '⌃',
  alt: '⌥',
  option: '⌥',
  shift: '⇧',
  cmdorctrl: '⌘',
  commandorcontrol: '⌘',
  cmd: '⌘',
  command: '⌘',
  meta: '⌘',
  super: '⌘'
}

// macOS always prints modifiers in this order, whatever order the accelerator declares them.
const MODIFIER_ORDER = ['⌃', '⌥', '⇧', '⌘']

// Keys whose Electron name is not what a macOS menu shows.
const KEY_GLYPHS: Record<string, string> = {
  tab: '⇥'
}

function formatKey(key: string): string {
  const glyph = KEY_GLYPHS[key.toLowerCase()]
  if (glyph) return glyph
  return key.length === 1 ? key.toUpperCase() : key
}

/**
 * An Electron accelerator as macOS renders it, for display next to a command palette entry -
 * `CmdOrCtrl+Shift+T` becomes `⇧⌘T`. A key name with no glyph of its own is printed as written, so
 * a newly mapped accelerator reads as text rather than vanishing.
 */
export function formatAccelerator(accelerator: string): string {
  const modifiers = new Set<string>()
  let key = ''
  for (const part of accelerator.split('+')) {
    const glyph = MODIFIER_GLYPHS[part.toLowerCase()]
    if (glyph) modifiers.add(glyph)
    else if (part.length > 0) key = formatKey(part)
  }
  return [...MODIFIER_ORDER.filter((glyph) => modifiers.has(glyph)), key].join('')
}
