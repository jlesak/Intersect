import { describe, expect, test } from 'vitest'
import { Channel } from '@common/ipc'
import { createAppStateRepo } from '../db/appStateRepo'
import { makeTestDb } from '../db/testkit'
import { createPaletteHandlers, paletteWireRoutes, RECENT_COMMANDS_LIMIT } from './palette.ipc'

const handlers = () => createPaletteHandlers({ appState: createAppStateRepo(makeTestDb()) })

describe('palette handlers', () => {
  test('a profile that has never run a command has no recents', async () => {
    expect(await handlers().getRecent()).toEqual([])
  })

  test('the most recently used command comes first', async () => {
    const h = handlers()
    await h.recordUse('tabs.new')
    await h.recordUse('prInbox.sync')
    expect(await h.recordUse('shell.toggleSidebar')).toEqual([
      'shell.toggleSidebar',
      'prInbox.sync',
      'tabs.new'
    ])
  })

  test('using a command again moves it to the front instead of listing it twice', async () => {
    const h = handlers()
    await h.recordUse('a')
    await h.recordUse('b')
    expect(await h.recordUse('a')).toEqual(['a', 'b'])
  })

  test('the list is capped, dropping the least recently used', async () => {
    const h = handlers()
    for (let i = 0; i < RECENT_COMMANDS_LIMIT + 3; i++) await h.recordUse(`cmd.${i}`)
    const recents = await h.getRecent()
    expect(recents).toHaveLength(RECENT_COMMANDS_LIMIT)
    expect(recents[0]).toBe(`cmd.${RECENT_COMMANDS_LIMIT + 2}`)
    expect(recents).not.toContain('cmd.0')
  })

  test('recents survive being read back through a fresh handler over the same store', async () => {
    const appState = createAppStateRepo(makeTestDb())
    await createPaletteHandlers({ appState }).recordUse('tabs.new')
    expect(await createPaletteHandlers({ appState }).getRecent()).toEqual(['tabs.new'])
  })

  test('a corrupted stored value degrades to no recents rather than throwing', async () => {
    const appState = createAppStateRepo(makeTestDb())
    const h = createPaletteHandlers({ appState })
    await h.recordUse('tabs.new')

    for (const junk of ['not json', '{"a":1}', '[1,2,3]', 'null']) {
      appState.set('palette.recent_command_ids', junk)
      expect(await h.getRecent()).toEqual([])
    }
  })

  test('an empty command id is not recorded', async () => {
    const h = handlers()
    expect(await h.recordUse('  ')).toEqual([])
    expect(await h.getRecent()).toEqual([])
  })
})

describe('paletteWireRoutes', () => {
  test('binds both palette channels to their handlers', async () => {
    const h = handlers()
    const routes = paletteWireRoutes(h)

    expect(Object.keys(routes).sort()).toEqual(
      [Channel.paletteGetRecent, Channel.paletteRecordUse].sort()
    )
    await (routes[Channel.paletteRecordUse] as (id: string) => Promise<string[]>)('tabs.new')
    expect(await (routes[Channel.paletteGetRecent] as () => Promise<string[]>)()).toEqual([
      'tabs.new'
    ])
  })
})
