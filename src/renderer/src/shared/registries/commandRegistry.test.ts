import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  __resetCommandRegistryForTests,
  getAllCommands,
  getCommand,
  registerCommand,
  type Command
} from './commandRegistry'

const cmd = (over: Partial<Command> = {}): Command => ({
  id: 'workspaces.create',
  title: 'Create Workspace',
  handler: () => {},
  ...over
})

describe('commandRegistry', () => {
  beforeEach(() => __resetCommandRegistryForTests())

  test('registers and retrieves a command by id', () => {
    const c = cmd({ id: 'terminal.splitRight' })
    registerCommand(c)
    expect(getCommand('terminal.splitRight')).toBe(c)
  })

  test('getCommand returns undefined for an unknown id', () => {
    expect(getCommand('nope')).toBeUndefined()
  })

  test('throws on duplicate id', () => {
    registerCommand(cmd({ id: 'x' }))
    expect(() => registerCommand(cmd({ id: 'x' }))).toThrow(/already registered/i)
  })

  test('getAllCommands returns every registered command', () => {
    registerCommand(cmd({ id: 'a' }))
    registerCommand(cmd({ id: 'b' }))
    expect(
      getAllCommands()
        .map((c) => c.id)
        .sort()
    ).toEqual(['a', 'b'])
  })

  test('a registered command handler can be invoked', async () => {
    const handler = vi.fn()
    registerCommand(cmd({ id: 'run', handler }))
    await getCommand('run')!.handler()
    expect(handler).toHaveBeenCalledOnce()
  })

  test('reset clears the registry', () => {
    registerCommand(cmd({ id: 'a' }))
    __resetCommandRegistryForTests()
    expect(getAllCommands()).toEqual([])
  })
})
