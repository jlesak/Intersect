import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  __resetCommandRegistryForTests,
  getAllCommands,
  getCommand,
  getProvidedCommands,
  isCommandEnabled,
  registerCommand,
  registerCommandProvider,
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

  test('carries the optional keywords, group and enabled predicate through the registry', () => {
    registerCommand(
      cmd({ id: 'a', keywords: ['bash', 'zsh'], group: 'Terminal', enabled: () => false })
    )
    const stored = getCommand('a')!
    expect(stored.keywords).toEqual(['bash', 'zsh'])
    expect(stored.group).toBe('Terminal')
    expect(stored.enabled!()).toBe(false)
  })

  test('a command that declares none of the optional fields leaves them undefined', () => {
    registerCommand(cmd({ id: 'a' }))
    const stored = getCommand('a')!
    expect(stored.keywords).toBeUndefined()
    expect(stored.group).toBeUndefined()
    expect(stored.enabled).toBeUndefined()
  })
})

describe('command providers', () => {
  beforeEach(() => __resetCommandRegistryForTests())

  test('no providers means nothing is contributed', () => {
    expect(getProvidedCommands('anything')).toEqual([])
  })

  test('every provider contributes, in registration order', () => {
    registerCommandProvider(() => [cmd({ id: 'a' })])
    registerCommandProvider(() => [cmd({ id: 'b' }), cmd({ id: 'c' })])
    expect(getProvidedCommands('').map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })

  test('the query reaches the provider so it can decline to answer', () => {
    const seen: string[] = []
    registerCommandProvider((query) => {
      seen.push(query)
      return query === '' ? [] : [cmd({ id: 'a' })]
    })
    expect(getProvidedCommands('')).toEqual([])
    expect(getProvidedCommands('x').map((c) => c.id)).toEqual(['a'])
    expect(seen).toEqual(['', 'x'])
  })

  test('a provider that throws costs only its own commands', () => {
    registerCommandProvider(() => [cmd({ id: 'a' })])
    registerCommandProvider(() => {
      throw new Error('store not ready')
    })
    registerCommandProvider(() => [cmd({ id: 'c' })])
    expect(getProvidedCommands('').map((c) => c.id)).toEqual(['a', 'c'])
  })

  test('reset clears the providers too', () => {
    registerCommandProvider(() => [cmd({ id: 'a' })])
    __resetCommandRegistryForTests()
    expect(getProvidedCommands('')).toEqual([])
  })
})

describe('isCommandEnabled', () => {
  test('a command with no predicate is always enabled', () => {
    expect(isCommandEnabled(cmd({}))).toBe(true)
  })

  test('follows the predicate in both directions', () => {
    expect(isCommandEnabled(cmd({ enabled: () => true }))).toBe(true)
    expect(isCommandEnabled(cmd({ enabled: () => false }))).toBe(false)
  })

  test('a predicate that throws counts as disabled rather than breaking the caller', () => {
    expect(
      isCommandEnabled(
        cmd({
          enabled: () => {
            throw new Error('store not ready')
          }
        })
      )
    ).toBe(false)
  })
})
