import { describe, expect, test } from 'vitest'
import type { Project } from './domain'
import {
  effectiveProject,
  indexOverrides,
  jiraProjectKeys,
  prOverrideKey,
  resolveJiraProject,
  resolvePrProject
} from './projectAssign'

function project(overrides: Partial<Project> & { id: string }): Project {
  return {
    name: overrides.id,
    sortOrder: 0,
    archived: false,
    repoPaths: ['/repos/' + overrides.id],
    jiraJql: null,
    jiraBoardUrl: null,
    adoRepositories: [],
    togglProjectId: null,
    ...overrides
  }
}

describe('resolvePrProject', () => {
  test('matches the ADO repository binding case-insensitively', () => {
    const projects = [project({ id: 'a', adoRepositories: ['Spot-Backend'] })]
    expect(resolvePrProject('spot-backend', projects)).toBe('a')
    expect(resolvePrProject('unrelated', projects)).toBeNull()
  })

  test('archived projects never match; ties break by manual order then id', () => {
    const archived = project({ id: 'a', adoRepositories: ['spot'], archived: true })
    expect(resolvePrProject('spot', [archived])).toBeNull()

    const first = project({ id: 'b', adoRepositories: ['spot'], sortOrder: 1 })
    const second = project({ id: 'a', adoRepositories: ['spot'], sortOrder: 2 })
    expect(resolvePrProject('spot', [second, first])).toBe('b')

    const tied = project({ id: 'z', adoRepositories: ['spot'], sortOrder: 1 })
    expect(resolvePrProject('spot', [tied, first])).toBe('b')
  })
})

describe('jiraProjectKeys', () => {
  test('extracts equality and in-list forms, quoted or bare', () => {
    expect(jiraProjectKeys('project = FID2507')).toEqual(['FID2507'])
    expect(jiraProjectKeys('project = "ABC" AND status = Open')).toEqual(['ABC'])
    expect(jiraProjectKeys("project in (ABC, 'DEF')")).toEqual(['ABC', 'DEF'])
    expect(jiraProjectKeys('project=fid2507 ORDER BY updated')).toEqual(['FID2507'])
  })

  test('null, empty, negated and unparseable filters yield no keys', () => {
    expect(jiraProjectKeys(null)).toEqual([])
    expect(jiraProjectKeys('')).toEqual([])
    expect(jiraProjectKeys('project != ABC')).toEqual([])
    expect(jiraProjectKeys('assignee = currentUser()')).toEqual([])
  })
})

describe('resolveJiraProject', () => {
  test('assigns by issue-key prefix against the project JQL', () => {
    const projects = [
      project({ id: 'a', jiraJql: 'project = FID2507' }),
      project({ id: 'b', jiraJql: 'project in (OPS, SEC)' })
    ]
    expect(resolveJiraProject('FID2507-611', projects)).toBe('a')
    expect(resolveJiraProject('OPS-1', projects)).toBe('b')
    expect(resolveJiraProject('OTHER-9', projects)).toBeNull()
  })

  test('archived projects and malformed keys resolve to Other', () => {
    const projects = [project({ id: 'a', jiraJql: 'project = ABC', archived: true })]
    expect(resolveJiraProject('ABC-1', projects)).toBeNull()
    expect(resolveJiraProject('', projects)).toBeNull()
  })
})

describe('effectiveProject', () => {
  const overrides = indexOverrides([
    { kind: 'pr', key: prOverrideKey('repo1', 42), projectId: 'pinned' },
    { kind: 'jira', key: 'ABC-1', projectId: null }
  ])

  test('an override wins over inference, including a pin to Other', () => {
    expect(effectiveProject('pr', 'repo1:42', 'inferred', overrides)).toBe('pinned')
    expect(effectiveProject('jira', 'ABC-1', 'inferred', overrides)).toBeNull()
  })

  test('without an override the inference stands', () => {
    expect(effectiveProject('pr', 'repo1:1', 'inferred', overrides)).toBe('inferred')
    expect(effectiveProject('jira', 'XYZ-2', null, overrides)).toBeNull()
  })

  test('kinds never collide even with equal keys', () => {
    const o = indexOverrides([{ kind: 'pr', key: 'K', projectId: 'p' }])
    expect(effectiveProject('jira', 'K', null, o)).toBeNull()
  })
})
