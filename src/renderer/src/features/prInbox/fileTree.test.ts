import { describe, expect, test } from 'vitest'
import type { PrChangeFile } from '@common/domain'
import { buildFileTree, fileCount } from './fileTree'

const f = (path: string, changeType: PrChangeFile['changeType'] = 'edit'): PrChangeFile => ({
  path,
  changeType,
  originalPath: null
})

describe('buildFileTree', () => {
  test('groups files under compacted single-child directory chains', () => {
    const tree = buildFileTree(
      [
        f('/src/api/features/planning/Service.cs'),
        f('/src/api/features/planning/Algorithm.cs', 'add'),
        f('/tests/planning/ServiceTests.cs')
      ],
      new Map()
    )
    expect(tree.dirs.map((d) => d.label)).toEqual(['src/api/features/planning', 'tests/planning'])
    const planning = tree.dirs[0]
    expect(planning.files.map((x) => x.name)).toEqual(['Algorithm.cs', 'Service.cs'])
    expect(planning.files[0].changeType).toBe('add')
  })

  test('does not compact a directory that has files or several children', () => {
    const tree = buildFileTree([f('/src/a/one.ts'), f('/src/b/two.ts'), f('/src/root.ts')], new Map())
    expect(tree.dirs.map((d) => d.label)).toEqual(['src'])
    const src = tree.dirs[0]
    expect(src.files.map((x) => x.name)).toEqual(['root.ts'])
    expect(src.dirs.map((d) => d.label)).toEqual(['a', 'b'])
  })

  test('attaches unresolved comment counts by path', () => {
    const tree = buildFileTree([f('/src/a.ts')], new Map([['/src/a.ts', 2]]))
    expect(tree.dirs[0].files[0].commentCount).toBe(2)
  })

  test('fileCount counts files recursively', () => {
    const tree = buildFileTree([f('/src/a/one.ts'), f('/src/b/two.ts'), f('/src/root.ts')], new Map())
    expect(fileCount(tree.dirs[0])).toBe(3)
  })

  test('directories sort before files, both alphabetically', () => {
    const tree = buildFileTree([f('/z.ts'), f('/a/b.ts')], new Map())
    expect(tree.dirs.map((d) => d.label)).toEqual(['a'])
    expect(tree.files.map((x) => x.name)).toEqual(['z.ts'])
  })

  test('a compacted chain keeps the deepest node path for collapse state', () => {
    const tree = buildFileTree([f('/src/api/deep/One.cs'), f('/src/api/deep/Two.cs')], new Map())
    expect(tree.dirs[0].label).toBe('src/api/deep')
    expect(tree.dirs[0].path).toBe('/src/api/deep')
  })
})
