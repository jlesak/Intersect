import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type {
  ClaudeMemoryDetail,
  ClaudeMemoryProject,
  ClaudeMemorySummary,
  ClaudeMemoryType
} from '@common/domain'
import { defaultConfigFs, type ConfigFs } from './configFs'
import { isContained } from './configPaths'
import { readFrontmatterField, splitFrontmatter } from './frontmatter'

export interface ClaudeMemoryReaderDeps {
  projectsDir?: string
  fs?: ConfigFs
}

const MEMORY_TYPES: ClaudeMemoryType[] = ['user', 'feedback', 'project', 'reference']

/** Read-only Claude memory catalog. Every path is checked after symlink resolution. */
export function createClaudeMemoryReader(deps: ClaudeMemoryReaderDeps = {}) {
  const fs = deps.fs ?? defaultConfigFs
  const projectsDir = deps.projectsDir ?? process.env.INTERSECT_CLAUDE_PROJECTS_DIR ??
    join(process.env.INTERSECT_CLAUDE_HOME ?? join(homedir(), '.claude'), 'projects')

  function contained(path: string, root: string): boolean {
    const target = fs.realpath(path)
    const base = fs.realpath(root)
    return target !== null && base !== null && isContained(target, base)
  }

  function projectEntries() {
    const rootReal = fs.realpath(projectsDir)
    if (!rootReal) return []
    return (fs.readDir(projectsDir) ?? []).filter((entry) =>
      entry.isDirectory && entry.name !== '.' && entry.name !== '..' &&
      !entry.name.includes('/') && contained(join(projectsDir, entry.name), projectsDir)
    )
  }

  function memoryDir(slug: string): string | null {
    if (!projectEntries().some((entry) => entry.name === slug)) return null
    const project = join(projectsDir, slug)
    const memory = join(project, 'memory')
    if (!contained(memory, project) || fs.readDir(memory) === null) return null
    return memory
  }

  function filenames(slug: string): string[] {
    const memory = memoryDir(slug)
    if (!memory) return []
    return (fs.readDir(memory) ?? [])
      .filter((entry) => entry.isFile && entry.name.endsWith('.md') &&
        entry.name !== '.' && entry.name !== '..' && !entry.name.includes('/') &&
        contained(join(memory, entry.name), memory))
      .map((entry) => entry.name)
  }

  function parse(slug: string, filename: string): ClaudeMemoryDetail | null {
    const path = join(projectsDir, slug, 'memory', filename)
    // Recheck immediately before reading: the entry may have changed since enumeration.
    if (!contained(path, join(projectsDir, slug, 'memory'))) return null
    const raw = fs.readFile(path)
    const { frontmatter, body } = splitFrontmatter(raw ?? '')
    const typeField = readFrontmatterField(frontmatter, 'type')
    return {
      slug,
      filename,
      name: readFrontmatterField(frontmatter, 'name') || basename(filename, '.md'),
      description: readFrontmatterField(frontmatter, 'description').replace(/\s+/g, ' ').trim(),
      type: filename === 'MEMORY.md' ? 'index' : MEMORY_TYPES.includes(typeField as ClaudeMemoryType)
        ? typeField as ClaudeMemoryType : 'unknown',
      mtime: fs.mtime(path),
      error: raw === null ? 'Could not read file' : null,
      body
    }
  }

  function listProjects(): ClaudeMemoryProject[] {
    return projectEntries().flatMap((entry) => {
      const memory = memoryDir(entry.name)
      if (!memory) return []
      return [{
        slug: entry.name,
        name: entry.name.split('-').filter(Boolean).at(-1) ?? entry.name,
        count: filenames(entry.name).length
      }]
    }).sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug))
  }

  function listMemories(slug: string | null, query: string): ClaudeMemorySummary[] {
    const needle = query.trim().toLocaleLowerCase()
    const slugs = slug === null ? listProjects().map((project) => project.slug) : [slug]
    return slugs.flatMap((projectSlug) => filenames(projectSlug).flatMap((filename) => {
      const item = parse(projectSlug, filename)
      return item ? [item] : []
    })).filter((item) => !needle || [item.name, item.description, item.body].some((value) =>
      value.toLocaleLowerCase().includes(needle)
    )).sort((a, b) => (b.mtime ?? -1) - (a.mtime ?? -1) || a.name.localeCompare(b.name))
      .map((item) => ({
        slug: item.slug, filename: item.filename, name: item.name,
        description: item.description, type: item.type, mtime: item.mtime, error: item.error
      }))
  }

  function readMemory(slug: string, filename: string): ClaudeMemoryDetail | null {
    if (!filenames(slug).includes(filename)) return null
    return parse(slug, filename)
  }

  return { listProjects, listMemories, readMemory }
}

export type ClaudeMemoryReader = ReturnType<typeof createClaudeMemoryReader>
