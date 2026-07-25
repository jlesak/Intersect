import type { MenuItemConstructorOptions } from 'electron'
import { SHORTCUT_ACTIONS, type ShortcutAction, type ShortcutMenu } from '@common/shortcuts'

/**
 * The native application menu, built as data so it can be asserted without Electron. macOS
 * handles menu accelerators before web contents see the key, which is the only reliable way to
 * own a shortcut in an app where xterm.js holds keyboard focus. The menu itself carries no
 * behaviour: each item dispatches its command id and the renderer decides what that means.
 */

// The nine positional jumps are gathered into their own submenu rather than crowding Window.
const TAB_JUMP_PREFIX = 'tabs.jump.'

function actionItem(
  action: ShortcutAction,
  invoke: (id: string) => void
): MenuItemConstructorOptions {
  return {
    id: action.id,
    label: action.label,
    accelerator: action.accelerator,
    click: () => invoke(action.id)
  }
}

function actionsIn(menu: ShortcutMenu): ShortcutAction[] {
  return SHORTCUT_ACTIONS.filter((action) => action.menu === menu)
}

/**
 * The items of one menu bucket in shortcut-map order, with a separator inserted ahead of
 * `separatorBefore` so the visual grouping is pinned to a command id, not to a position.
 */
function bucketItems(
  menu: ShortcutMenu,
  invoke: (id: string) => void,
  separatorBefore?: string
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []
  for (const action of actionsIn(menu)) {
    if (action.id === separatorBefore) items.push({ type: 'separator' })
    items.push(actionItem(action, invoke))
  }
  return items
}

/**
 * Build the application menu template. `invoke` receives the command id of whatever the user
 * picked - it is the single hand-off from the native menu into the renderer. Installing any menu
 * at all displaces Electron's default one, so the window roles it used to provide are restored
 * here explicitly; `devTools` keeps the developer-only entries out of a packaged build.
 */
export function appMenuTemplate(
  invoke: (id: string) => void,
  { devTools = false }: { devTools?: boolean } = {}
): MenuItemConstructorOptions[] {
  const windowActions = actionsIn('window')
  const tabJumps = windowActions.filter((action) => action.id.startsWith(TAB_JUMP_PREFIX))
  const windowItems = windowActions
    .filter((action) => !action.id.startsWith(TAB_JUMP_PREFIX))
    .map((action) => actionItem(action, invoke))

  return [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: bucketItems('file', invoke, 'tabs.close')
    },
    {
      // Not decoration: without these roles the clipboard shortcuts stop working inside text
      // inputs in a packaged mac build, and this app is full of them.
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        ...bucketItems('view', invoke, 'shell.toggleSidebar'),
        { type: 'separator' },
        // Full screen and, in development, reload and the inspector: all of these came free with
        // Electron's default menu, and replacing it would otherwise leave no way to reach them.
        { role: 'togglefullscreen' },
        ...(devTools
          ? ([{ role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[])
          : [])
      ]
    },
    {
      // No `close` role here on purpose: Electron's close role claims Cmd+W by default, which
      // would shadow Close Tab.
      label: 'Window',
      submenu: [
        ...windowItems,
        { label: 'Go to Tab', submenu: tabJumps.map((action) => actionItem(action, invoke)) },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'front' }
      ]
    }
  ]
}
