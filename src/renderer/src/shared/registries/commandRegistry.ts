/**
 * A named command with a handler. Slices register commands (e.g. `workspaces.create`,
 * `terminal.splitRight`) so the command palette and the native menu can list and invoke them.
 */
export interface Command {
  id: string
  title: string
  handler: () => void | Promise<void>
  /**
   * Extra words the command should be findable by - the vocabulary a user reaches for when they
   * do not know what the command is called. "New Shell Tab" is what it is called; "bash" is what
   * someone types looking for it.
   */
  keywords?: string[]
  /** The heading the palette files the command under. Ungrouped commands sort after grouped ones. */
  group?: string
  /**
   * Whether the command can run right now. A command whose preconditions are unmet stays listed
   * but unrunnable, so its absence never reads as the palette having lost it. Omitted means
   * always runnable.
   */
  enabled?: () => boolean
}

/**
 * Whether a command can run right now. A predicate that throws counts as "no": a command whose
 * own precondition check is broken must not be offered as runnable, and one slice's fault must
 * not take down the listing of every other slice's commands.
 */
export function isCommandEnabled(command: Command): boolean {
  if (!command.enabled) return true
  try {
    return command.enabled()
  } catch {
    return false
  }
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
