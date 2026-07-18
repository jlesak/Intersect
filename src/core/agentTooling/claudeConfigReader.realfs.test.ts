import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createClaudeConfigReader, type ResolvedScope } from './claudeConfigReader'

/**
 * The handful of scenarios worth exercising against a real filesystem: symlink containment (a
 * fake seam cannot prove the realpath resolution) and the read-only guarantee that a missing
 * project settings file is never created. Everything else runs on injected seams.
 */
describe('createClaudeConfigReader (real filesystem)', () => {
  let dir: string
  let home: string
  let repo: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'intersect-agenttooling-'))
    home = join(dir, 'home', '.claude')
    repo = join(dir, 'repo')
    mkdirSync(home, { recursive: true })
    mkdirSync(repo, { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const reader = () => createClaudeConfigReader({ claudeHome: home, fs: undefined })
  const scoped = (): ReturnType<typeof createClaudeConfigReader> =>
    createClaudeConfigReader({ claudeHome: home })
  const projectScope = (): ResolvedScope => ({ kind: 'project', repoRoots: [repo] })

  test('reading a missing project settings file creates no file or directory', () => {
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ model: 'sonnet' }))
    const config = scoped().getEffectiveConfig(projectScope())

    expect(config.files.find((f) => f.source === 'project')?.exists).toBe(false)
    // The read must not have materialized the project's .claude directory or any file in it.
    expect(existsSync(join(repo, '.claude'))).toBe(false)
    expect(existsSync(join(repo, '.claude', 'settings.json'))).toBe(false)
  })

  test('a project settings.json symlinked outside the repo root is blocked and not read', () => {
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ model: 'sonnet' }))
    // The secret lives outside the repo; the project's .claude/settings.json is a symlink to it.
    const outside = join(dir, 'outside')
    mkdirSync(outside, { recursive: true })
    const secret = join(outside, 'secret.json')
    writeFileSync(secret, JSON.stringify({ model: 'ESCAPED' }))
    mkdirSync(join(repo, '.claude'), { recursive: true })
    symlinkSync(secret, join(repo, '.claude', 'settings.json'))

    const config = scoped().getEffectiveConfig(projectScope())
    const projectFile = config.files.find((f) => f.source === 'project')
    expect(projectFile?.exists).toBe(false)
    expect(projectFile?.error).toMatch(/Blocked/)
    // The escaped value must never surface.
    expect(config.advanced.find((a) => a.key === 'model')?.value).toBe('"sonnet"')
  })

  test('a project skill symlinked outside the repo root is not discovered', () => {
    const outside = join(dir, 'outside-skill')
    mkdirSync(join(outside, 'SKILL_DIR'), { recursive: true })
    writeFileSync(join(outside, 'SKILL_DIR', 'SKILL.md'), '---\ndescription: escaped\n---\n')
    mkdirSync(join(repo, '.claude', 'skills'), { recursive: true })
    symlinkSync(join(outside, 'SKILL_DIR'), join(repo, '.claude', 'skills', 'evil'))

    const skills = scoped().listSkills(projectScope())
    expect(skills.some((s) => s.name === 'evil')).toBe(false)
  })

  test('discovers a real user skill + agent from a ~/.claude-like layout', () => {
    mkdirSync(join(home, 'skills', 'demo'), { recursive: true })
    writeFileSync(join(home, 'skills', 'demo', 'SKILL.md'), '---\ndescription: demo skill\n---\nbody')
    mkdirSync(join(home, 'agents'), { recursive: true })
    writeFileSync(join(home, 'agents', 'helper.md'), '---\ndescription: helper\nmodel: opus\n---\nbody')

    const r = reader()
    expect(r.listSkills({ kind: 'global' })).toMatchObject([
      { name: 'demo', description: 'demo skill', external: false }
    ])
    expect(r.listAgents({ kind: 'global' })).toMatchObject([
      { name: 'helper', description: 'helper', model: 'opus', external: false }
    ])
  })
})
