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
   *
   * A keyword must be a short, deliberate identifier a user would type to mean this command, and
   * never a long opaque string. The palette matches on subsequences, so every long string is an
   * accidental-match surface: some short query's letters will happen to appear in order somewhere
   * inside it, and the command surfaces for a reason nobody can see. A pull request's number,
   * repository, author, folder name and branch all pass that test. An absolute path does not.
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

/**
 * Builds the commands that only exist because of what is on screen right now - one per open
 * workspace, one per pull request, one per past session. They cannot be registered up front
 * because their targets appear and disappear while the app runs.
 *
 * The query is passed in so a provider over a long list can decline to answer an empty one: three
 * hundred sessions offered before the user has typed anything would bury every real command.
 */
export type CommandProvider = (query: string) => Command[]

const commands = new Map<string, Command>()
const providers: CommandProvider[] = []

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

/** Register a source of state-derived commands. */
export function registerCommandProvider(provider: CommandProvider): void {
  providers.push(provider)
}

/**
 * Every state-derived command for the given query. A provider that throws contributes nothing
 * rather than taking the palette down: its slice's state being unreadable must not cost the user
 * every other slice's commands.
 */
export function getProvidedCommands(query: string): Command[] {
  const built: Command[] = []
  for (const provider of providers) {
    try {
      built.push(...provider(query))
    } catch {
      // Deliberately ignored - see above.
    }
  }
  return built
}

/** Test-only: clear the module-level registry between tests. */
export function __resetCommandRegistryForTests(): void {
  commands.clear()
  providers.length = 0
}
