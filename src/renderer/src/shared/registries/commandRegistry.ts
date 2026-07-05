/**
 * A named command with a handler. Slices register commands (e.g. `workspaces.create`,
 * `terminal.splitRight`) so a future command-palette slice can list and invoke them. This
 * is the data-structure seam only - there is no palette UI in this MVP.
 */
export interface Command {
  id: string
  title: string
  handler: () => void | Promise<void>
}

const commands = new Map<string, Command>()

/** Register a command. Throws if the id is already registered. */
export function registerCommand(command: Command): void {
  if (commands.has(command.id)) {
    throw new Error(`Command "${command.id}" is already registered`)
  }
  commands.set(command.id, command)
}

/** Look up a command by id, or undefined if none is registered. */
export function getCommand(id: string): Command | undefined {
  return commands.get(id)
}

/** Every registered command, in insertion order. */
export function getAllCommands(): Command[] {
  return [...commands.values()]
}

/** Test-only: clear the module-level registry between tests. */
export function __resetCommandRegistryForTests(): void {
  commands.clear()
}
