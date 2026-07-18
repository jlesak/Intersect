import { basename, dirname } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { ConfigFileState } from '@common/domain'
import { createClaudeConfigReader, type ResolvedScope } from './claudeConfigReader'
import type { ConfigFs } from './configFs'

const HOME = '/home/.claude'
const ROOT = '/repo'

/**
 * An in-memory {@link ConfigFs} over a flat path->content map. Directories are inferred from the
 * file paths; `realpathMap` overrides where a path resolves so symlink-escape and containment
 * scenarios are expressible without touching real disk.
 */
function memFs(files: Record<string, string>, realpathMap: Record<string, string> = {}): ConfigFs {
  const fileSet = new Set(Object.keys(files))
  const dirSet = new Set<string>(['/'])
  for (const f of fileSet) {
    let d = dirname(f)
    while (d && d !== '/' && !dirSet.has(d)) {
      dirSet.add(d)
      d = dirname(d)
    }
  }
  const exists = (p: string): boolean => fileSet.has(p) || dirSet.has(p)
  return {
    readFile: (p) => files[p] ?? null,
    readDir: (p) => {
      if (!dirSet.has(p)) return null
      const children = new Map<string, { isDirectory: boolean; isFile: boolean }>()
      for (const f of fileSet) if (dirname(f) === p) children.set(basename(f), { isFile: true, isDirectory: false })
      for (const d of dirSet) if (d !== p && dirname(d) === p) children.set(basename(d), { isFile: false, isDirectory: true })
      return [...children].map(([name, t]) => ({ name, ...t }))
    },
    realpath: (p) => (p in realpathMap ? realpathMap[p] : exists(p) ? p : null)
  }
}

const project = (): ResolvedScope => ({ kind: 'project', repoRoots: [ROOT] })
const global = (): ResolvedScope => ({ kind: 'global' })

const reader = (files: Record<string, string>, realpathMap?: Record<string, string>) =>
  createClaudeConfigReader({ claudeHome: HOME, fs: memFs(files, realpathMap) })

const fileFor = (files: ConfigFileState[], source: string): ConfigFileState | undefined =>
  files.find((f) => f.source === source)

describe('getEffectiveConfig - global scope provenance', () => {
  test('layers settings.json under settings.local.json with per-leaf provenance', () => {
    const config = reader({
      [`${HOME}/settings.json`]: JSON.stringify({
        model: 'sonnet',
        includeCoAuthoredBy: true,
        permissions: { allow: ['Read(*)'], deny: ['Bash(rm*)'] }
      }),
      [`${HOME}/settings.local.json`]: JSON.stringify({
        model: 'opus',
        permissions: { allow: ['Write(*)'] }
      })
    }).getEffectiveConfig(global())

    // model overridden by the local layer; includeCoAuthoredBy only in the base layer.
    const model = config.advanced.find((a) => a.key === 'model')
    expect(model).toEqual({ key: 'model', value: '"opus"', source: 'global-local' })
    expect(config.advanced.find((a) => a.key === 'includeCoAuthoredBy')?.source).toBe('global')

    // permissions union across layers, each rule tagged with its owning layer.
    expect(config.permissions).toContainEqual({ list: 'allow', rule: 'Read(*)', source: 'global' })
    expect(config.permissions).toContainEqual({ list: 'allow', rule: 'Write(*)', source: 'global-local' })
    expect(config.permissions).toContainEqual({ list: 'deny', rule: 'Bash(rm*)', source: 'global' })

    expect(fileFor(config.files, 'global')?.exists).toBe(true)
    expect(fileFor(config.files, 'global-local')?.exists).toBe(true)
  })

  test('a value present only in the base layer keeps that provenance when local overrides another rule', () => {
    const config = reader({
      [`${HOME}/settings.json`]: JSON.stringify({ permissions: { allow: ['Read(*)'] } }),
      [`${HOME}/settings.local.json`]: JSON.stringify({ permissions: { allow: ['Read(*)', 'Edit(*)'] } })
    }).getEffectiveConfig(global())
    // Read(*) exists in both; the highest-precedence layer owns the provenance.
    expect(config.permissions.find((p) => p.rule === 'Read(*)')?.source).toBe('global-local')
    expect(config.permissions.find((p) => p.rule === 'Edit(*)')?.source).toBe('global-local')
  })
})

describe('getEffectiveConfig - project scope provenance', () => {
  test('layers global < project < project-local', () => {
    const config = reader({
      [`${HOME}/settings.json`]: JSON.stringify({ model: 'haiku', env: { A: '1' } }),
      [`${ROOT}/.claude/settings.json`]: JSON.stringify({ model: 'sonnet' }),
      [`${ROOT}/.claude/settings.local.json`]: JSON.stringify({ model: 'opus' })
    }).getEffectiveConfig(project())

    expect(config.advanced.find((a) => a.key === 'model')).toEqual({
      key: 'model',
      value: '"opus"',
      source: 'project-local'
    })
    // env only defined globally keeps global provenance.
    expect(config.advanced.find((a) => a.key === 'env')?.source).toBe('global')
    expect(fileFor(config.files, 'global')?.exists).toBe(true)
    expect(fileFor(config.files, 'project')?.exists).toBe(true)
    expect(fileFor(config.files, 'project-local')?.exists).toBe(true)
  })

  test('project scope does not read the global settings.local layer', () => {
    const config = reader({
      [`${HOME}/settings.json`]: JSON.stringify({ model: 'haiku' }),
      [`${HOME}/settings.local.json`]: JSON.stringify({ model: 'GLOBAL-LOCAL-LEAK' }),
      [`${ROOT}/.claude/settings.json`]: JSON.stringify({ model: 'sonnet' })
    }).getEffectiveConfig(project())
    expect(config.advanced.find((a) => a.key === 'model')?.value).toBe('"sonnet"')
    expect(config.files.some((f) => f.source === 'global-local')).toBe(false)
  })
})

describe('getEffectiveConfig - malformed layers degrade per file', () => {
  test('an invalid JSON layer becomes a per-file error while other layers resolve', () => {
    const config = reader({
      [`${HOME}/settings.json`]: JSON.stringify({ model: 'sonnet' }),
      [`${ROOT}/.claude/settings.json`]: '{ this is not json',
      [`${ROOT}/.claude/settings.local.json`]: JSON.stringify({ includeCoAuthoredBy: false })
    }).getEffectiveConfig(project())

    const projectFile = fileFor(config.files, 'project')
    expect(projectFile?.exists).toBe(true)
    expect(projectFile?.error).toMatch(/Invalid JSON/)
    // The other two layers still contribute values.
    expect(config.advanced.find((a) => a.key === 'model')?.value).toBe('"sonnet"')
    expect(config.advanced.find((a) => a.key === 'includeCoAuthoredBy')?.source).toBe('project-local')
  })

  test('a JSON array (not an object) is reported as a shape error', () => {
    const config = reader({
      [`${HOME}/settings.json`]: JSON.stringify(['nope'])
    }).getEffectiveConfig(global())
    expect(fileFor(config.files, 'global')?.error).toMatch(/Not a JSON object/)
  })
})

describe('getEffectiveConfig - containment fails closed', () => {
  test('a project settings file resolving outside its root is blocked, not read', () => {
    const config = reader(
      {
        [`${HOME}/settings.json`]: JSON.stringify({ model: 'sonnet' }),
        [`${ROOT}/.claude/settings.json`]: JSON.stringify({ model: 'ESCAPED-SECRET' })
      },
      // The project settings.json symlink-resolves outside the repo root.
      { [`${ROOT}/.claude/settings.json`]: '/outside/settings.json' }
    ).getEffectiveConfig(project())

    const projectFile = fileFor(config.files, 'project')
    expect(projectFile?.exists).toBe(false)
    expect(projectFile?.error).toMatch(/Blocked/)
    // Its value must never appear - the outside file was not read.
    expect(config.advanced.find((a) => a.key === 'model')?.value).toBe('"sonnet"')
  })
})

describe('getEffectiveConfig - missing files', () => {
  test('a project without a .claude settings file reports absent layers without error', () => {
    const config = reader({
      [`${HOME}/settings.json`]: JSON.stringify({ model: 'sonnet' })
    }).getEffectiveConfig(project())
    const projectFile = fileFor(config.files, 'project')
    expect(projectFile?.exists).toBe(false)
    expect(projectFile?.error).toBeNull()
  })
})

describe('getEffectiveConfig - hooks', () => {
  test('flattens hook commands with matcher and provenance, deduped highest-wins', () => {
    const config = reader({
      [`${HOME}/settings.json`]: JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo global' }] }
          ]
        }
      }),
      [`${HOME}/settings.local.json`]: JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }]
        }
      })
    }).getEffectiveConfig(global())

    expect(config.hooks).toContainEqual({
      event: 'PreToolUse',
      matcher: 'Bash',
      type: 'command',
      command: 'echo global',
      source: 'global'
    })
    expect(config.hooks).toContainEqual({
      event: 'Stop',
      matcher: null,
      type: 'command',
      command: 'echo done',
      source: 'global-local'
    })
  })
})

describe('getEffectiveConfig - mcp', () => {
  test('merges settings mcpServers with a project .mcp.json labeled mcp-file', () => {
    const config = reader({
      [`${HOME}/settings.json`]: JSON.stringify({
        mcpServers: { ctx: { command: 'npx', args: ['ctx-server'] } }
      }),
      [`${ROOT}/.mcp.json`]: JSON.stringify({
        mcpServers: { remote: { type: 'http', url: 'https://mcp.example.com' } }
      })
    }).getEffectiveConfig(project())

    expect(config.mcpServers).toContainEqual({
      name: 'ctx',
      transport: 'stdio',
      detail: 'npx ctx-server',
      source: 'global'
    })
    expect(config.mcpServers).toContainEqual({
      name: 'remote',
      transport: 'http',
      detail: 'https://mcp.example.com',
      source: 'mcp-file'
    })
    expect(fileFor(config.files, 'mcp-file')?.exists).toBe(true)
  })

  test('project-local mcpServers overrides an earlier layer for the same name', () => {
    const config = reader({
      [`${HOME}/settings.json`]: JSON.stringify({ mcpServers: { s: { command: 'old' } } }),
      [`${ROOT}/.claude/settings.local.json`]: JSON.stringify({
        mcpServers: { s: { command: 'new' } }
      })
    }).getEffectiveConfig(project())
    expect(config.mcpServers.find((m) => m.name === 's')).toEqual({
      name: 's',
      transport: 'stdio',
      detail: 'new',
      source: 'project-local'
    })
  })
})

describe('listSkills', () => {
  test('discovers user and plugin skills, labels source, marks plugins external, sorts stably', () => {
    const skills = reader({
      [`${HOME}/skills/zeta/SKILL.md`]: '---\ndescription: user zeta\n---\nbody',
      [`${HOME}/skills/alpha/SKILL.md`]: '---\ndescription: user alpha\n---\nbody',
      [`${HOME}/plugins/installed_plugins.json`]: JSON.stringify({
        version: 1,
        plugins: { 'super@official': [{ installPath: '/plugins/super' }] }
      }),
      '/plugins/super/skills/brainstorm/SKILL.md': '---\ndescription: plugin skill\n---\nbody'
    }).listSkills(global())

    expect(skills.map((s) => `${s.source.kind}:${s.name}`)).toEqual([
      'user:alpha',
      'user:zeta',
      'plugin:brainstorm'
    ])
    expect(skills.find((s) => s.name === 'brainstorm')).toMatchObject({
      external: true,
      source: { kind: 'plugin', label: 'super@official' },
      description: 'plugin skill'
    })
    expect(skills.find((s) => s.name === 'alpha')?.external).toBe(false)
  })

  test('a malformed plugin index does not fail the catalog - user skills still returned', () => {
    const skills = reader({
      [`${HOME}/skills/alpha/SKILL.md`]: '---\ndescription: a\n---\nbody',
      [`${HOME}/plugins/installed_plugins.json`]: '{ broken json'
    }).listSkills(global())
    expect(skills.map((s) => s.name)).toEqual(['alpha'])
  })

  test('a skill with malformed/absent frontmatter is still listed with empty description', () => {
    const skills = reader({
      [`${HOME}/skills/nofm/SKILL.md`]: '# just a heading, no frontmatter'
    }).listSkills(global())
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ name: 'nofm', description: '' })
  })

  test('project scope adds project-level skills', () => {
    const skills = reader({
      [`${ROOT}/.claude/skills/proj/SKILL.md`]: '---\ndescription: p\n---\nbody'
    }).listSkills(project())
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ name: 'proj', source: { kind: 'project' }, external: false })
  })
})

describe('listAgents', () => {
  test('discovers user and plugin agents with model/tools/description, sorted stably', () => {
    const agents = reader({
      [`${HOME}/agents/reviewer.md`]: '---\ndescription: reviews code\nmodel: opus\ntools: Read, Grep\n---\nbody',
      [`${HOME}/plugins/installed_plugins.json`]: JSON.stringify({
        version: 1,
        plugins: { 'pack@x': [{ installPath: '/plugins/pack' }] }
      }),
      '/plugins/pack/agents/builder.md': '---\ndescription: builds\nmodel: sonnet\n---\nbody'
    }).listAgents(global())

    expect(agents.map((a) => `${a.source.kind}:${a.name}`)).toEqual(['user:reviewer', 'plugin:builder'])
    expect(agents.find((a) => a.name === 'reviewer')).toMatchObject({
      description: 'reviews code',
      model: 'opus',
      tools: 'Read, Grep',
      external: false
    })
    expect(agents.find((a) => a.name === 'builder')).toMatchObject({ external: true, model: 'sonnet' })
  })

  test('tolerates a malformed plugin index and a frontmatter-less agent file', () => {
    const agents = reader({
      [`${HOME}/agents/bare.md`]: 'no frontmatter here',
      [`${HOME}/plugins/installed_plugins.json`]: 'not json at all'
    }).listAgents(global())
    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({ name: 'bare', description: '', model: '', tools: '' })
  })
})
