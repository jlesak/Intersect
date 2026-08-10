import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { SHORTCUT_ACTIONS } from '@common/shortcuts'
import { registerCommandPaletteFeature } from '@renderer/features/commandPalette'
import { registerTabsFeature } from '@renderer/features/tabs'
import { registerTerminalFeature } from '@renderer/features/terminal'
import {
  __resetCommandRegistryForTests,
  getCommand
} from '@renderer/shared/registries/commandRegistry'
import { registerShellCommands } from './shellCommands'

/**
 * The native menu dispatches nothing but a command id, so a mapped shortcut whose command was
 * never registered produces a menu item that silently does nothing - the kind of defect no
 * type-checker sees. These tests pin the map and the registry to each other.
 */
describe('shortcut commands', () => {
  beforeEach(() => {
    __resetCommandRegistryForTests()
    registerCommandPaletteFeature()
    registerTabsFeature()
    registerTerminalFeature()
    registerShellCommands()
  })

  afterEach(() => {
    __resetCommandRegistryForTests()
  })

  test('every mapped shortcut resolves to a registered command', () => {
    const unregistered = SHORTCUT_ACTIONS.filter((action) => !getCommand(action.id)).map(
      (action) => action.id
    )
    expect(unregistered).toEqual([])
  })

  // The menu shows the map's label and the palette shows the command's title. They describe the
  // same action, so a mismatch would name one action two different things.
  test('every mapped shortcut has a command titled exactly as the menu labels it', () => {
    const mismatched = SHORTCUT_ACTIONS.filter(
      (action) => getCommand(action.id)?.title !== action.label
    ).map((action) => ({
      id: action.id,
      label: action.label,
      title: getCommand(action.id)?.title
    }))
    expect(mismatched).toEqual([])
  })
})
