import { beforeEach, describe, expect, test } from 'vitest'
import {
  __resetSidebarRegistryForTests,
  getSidebarSections,
  registerSidebarSection,
  type SidebarSection
} from './sidebarRegistry'

const section = (over: Partial<SidebarSection> = {}): SidebarSection => ({
  id: 'workspaces',
  order: 0,
  label: 'Workspaces',
  icon: () => null,
  component: () => null,
  ...over
})

describe('sidebarRegistry', () => {
  beforeEach(() => __resetSidebarRegistryForTests())

  test('returns registered sections sorted by order', () => {
    registerSidebarSection(section({ id: 'b', order: 2, label: 'B' }))
    registerSidebarSection(section({ id: 'a', order: 1, label: 'A' }))
    registerSidebarSection(section({ id: 'c', order: 3, label: 'C' }))
    expect(getSidebarSections().map((s) => s.id)).toEqual(['a', 'b', 'c'])
  })

  test('throws on duplicate id', () => {
    registerSidebarSection(section({ id: 'x' }))
    expect(() => registerSidebarSection(section({ id: 'x' }))).toThrow(/already registered/i)
  })

  test('getSidebarSections returns a copy so callers cannot mutate internal state', () => {
    registerSidebarSection(section({ id: 'a', order: 1 }))
    const snapshot = getSidebarSections()
    snapshot.push(section({ id: 'injected', order: 99 }))
    expect(getSidebarSections().map((s) => s.id)).toEqual(['a'])
  })

  test('carries an optional mainComponent for the main-content seam', () => {
    const Main = () => null
    registerSidebarSection(section({ id: 'a', mainComponent: Main }))
    expect(getSidebarSections()[0].mainComponent).toBe(Main)
  })

  test('reset clears all sections', () => {
    registerSidebarSection(section({ id: 'a' }))
    __resetSidebarRegistryForTests()
    expect(getSidebarSections()).toEqual([])
  })
})
