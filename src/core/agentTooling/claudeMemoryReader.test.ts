import { describe, expect, test } from 'vitest'
import { createMemoryConfigFs } from './memoryConfigFs'
import { createClaudeMemoryReader } from './claudeMemoryReader'

const root = '/home/.claude/projects'
const alpha = `${root}/-Users-test-Alpha/memory`
const beta = `${root}/-Users-test-Beta/memory`

describe('Claude memory reader', () => {
  test('lists projects and memories, searches bodies, and reads without changing files', () => {
    const fs = createMemoryConfigFs({
      [`${alpha}/MEMORY.md`]: '# Index',
      [`${alpha}/note.md`]: '---\nname: One\ndescription: useful note\ntype: feedback\n---\nA searchable secret',
      [`${beta}/other.md`]: '---\ntype: strange\n---\nAnother body'
    })
    const before = [...fs.files].map(([path, file]) => [path, file.data])
    const reader = createClaudeMemoryReader({ projectsDir: root, fs: fs.read })
    expect(reader.listProjects()).toEqual([
      { slug: '-Users-test-Alpha', name: 'Alpha', count: 2 },
      { slug: '-Users-test-Beta', name: 'Beta', count: 1 }
    ])
    expect(reader.listMemories(null, 'SEARCHABLE').map((m) => m.filename)).toEqual(['note.md'])
    expect(reader.listMemories('-Users-test-Alpha', '').map((m) => m.type)).toEqual([
      'index', 'feedback'
    ])
    expect(reader.readMemory('-Users-test-Alpha', 'note.md')?.body).toBe('A searchable secret')
    expect(reader.readMemory('-Users-test-Alpha', '../other.md')).toBeNull()
    expect([...fs.files].map(([path, file]) => [path, file.data])).toEqual(before)
  })

  test('blocks canonical escapes before reading', () => {
    const fs = createMemoryConfigFs({ [`${alpha}/note.md`]: 'safe' })
    const readFile = fs.read.readFile
    let reads = 0
    const reader = createClaudeMemoryReader({
      projectsDir: root,
      fs: {
        ...fs.read,
        realpath: (path) => path === `${alpha}/note.md` ? '/outside/note.md' : fs.read.realpath(path),
        readFile: (path) => { reads++; return readFile(path) }
      }
    })
    expect(reader.listMemories(null, '')).toEqual([])
    expect(reader.readMemory('-Users-test-Alpha', 'note.md')).toBeNull()
    expect(reads).toBe(0)
  })

  test('sorts by mtime, tolerates malformed and unreadable files, and rejects missing paths', () => {
    const fs = createMemoryConfigFs({
      [`${alpha}/older.md`]: '---\nname: Broken\ntype: strange\nUnclosed frontmatter',
      [`${alpha}/newer.md`]: '---\nname: Newer\ntype: user\n---\nBody'
    })
    const reader = createClaudeMemoryReader({
      projectsDir: root,
      fs: {
        ...fs.read,
        mtime: (path) => path.endsWith('newer.md') ? 200 : 100,
        readFile: (path) => path.endsWith('newer.md') ? null : fs.read.readFile(path)
      }
    })
    const memories = reader.listMemories(null, '')
    expect(memories.map((item) => item.filename)).toEqual(['newer.md', 'older.md'])
    expect(memories[0]).toMatchObject({ error: 'Could not read file', type: 'unknown' })
    expect(memories[1]).toMatchObject({ name: 'older', type: 'unknown' })
    expect(reader.readMemory('-Users-test-Alpha', 'missing.md')).toBeNull()
    expect(reader.readMemory('missing', 'newer.md')).toBeNull()
  })

  test('a project with a regular file named memory is not a memory project', () => {
    const fs = createMemoryConfigFs({ [`${root}/-Users-test-Fake/memory`]: 'not a directory' })
    const reader = createClaudeMemoryReader({ projectsDir: root, fs: fs.read })
    expect(reader.listProjects()).toEqual([])
  })
})
