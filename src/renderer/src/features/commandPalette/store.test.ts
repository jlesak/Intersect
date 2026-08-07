import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('./ipc')
import * as api from './ipc'
import { useCommandPaletteStore } from './store'

const mocked = vi.mocked(api)

beforeEach(() => {
  useCommandPaletteStore.setState({ open: false, recentIds: [] }, false)
  vi.clearAllMocks()
})

describe('recently used commands', () => {
  test('hydration takes the list the core reports', async () => {
    mocked.getRecent.mockResolvedValue(['tabs.new', 'prInbox.sync'])
    await useCommandPaletteStore.getState().hydrateRecent()
    expect(useCommandPaletteStore.getState().recentIds).toEqual(['tabs.new', 'prInbox.sync'])
  })

  test('recording a use takes the reordered list back from the core, not a local guess', async () => {
    useCommandPaletteStore.setState({ recentIds: ['a', 'b'] }, false)
    mocked.recordUse.mockResolvedValue(['b', 'a'])

    await useCommandPaletteStore.getState().recordUse('b')

    expect(mocked.recordUse).toHaveBeenCalledWith('b')
    expect(useCommandPaletteStore.getState().recentIds).toEqual(['b', 'a'])
  })

  test('a core that cannot answer leaves the known list standing instead of throwing', async () => {
    useCommandPaletteStore.setState({ recentIds: ['a'] }, false)
    mocked.getRecent.mockRejectedValue(new Error('core down'))
    mocked.recordUse.mockRejectedValue(new Error('core down'))

    await expect(useCommandPaletteStore.getState().hydrateRecent()).resolves.toBeUndefined()
    await expect(useCommandPaletteStore.getState().recordUse('b')).resolves.toBeUndefined()
    expect(useCommandPaletteStore.getState().recentIds).toEqual(['a'])
  })
})
