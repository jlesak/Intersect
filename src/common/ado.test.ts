import { describe, expect, test } from 'vitest'
import type { AdoFallback, AdoSettings } from './domain'
import { effectiveAdoOrgUrl, hasAdoConnection, prWebUrl } from './ado'

const blank: AdoSettings = { orgUrl: '', project: '', repository: '', pat: '' }
const noFallback: AdoFallback = { orgUrl: '', project: '', hasPat: false }

describe('hasAdoConnection', () => {
  test('an org URL and a token the user saved are a connection', () => {
    expect(hasAdoConnection({ ...blank, orgUrl: 'https://ado', pat: 't' }, noFallback)).toBe(true)
  })

  test('an org URL and a token from the fallback alone are a connection', () => {
    expect(hasAdoConnection(blank, { orgUrl: 'https://ado', project: 'SPOT', hasPat: true })).toBe(
      true
    )
  })

  test('a blank saved field defers to the fallback rather than overriding it', () => {
    const orgUrlFallback: AdoFallback = { orgUrl: 'https://ado', project: '', hasPat: false }
    const patFallback: AdoFallback = { orgUrl: '', project: '', hasPat: true }
    expect(hasAdoConnection({ ...blank, pat: 't' }, orgUrlFallback)).toBe(true)
    expect(hasAdoConnection({ ...blank, orgUrl: 'https://ado' }, patFallback)).toBe(true)
  })

  test('either half missing is no connection', () => {
    expect(hasAdoConnection(blank, noFallback)).toBe(false)
    expect(hasAdoConnection({ ...blank, orgUrl: 'https://ado' }, noFallback)).toBe(false)
    expect(hasAdoConnection({ ...blank, pat: 't' }, noFallback)).toBe(false)
  })

  test('whitespace is not a value', () => {
    // The core trims before deciding the same thing, so a form holding only spaces is not a
    // connection here either.
    expect(hasAdoConnection({ ...blank, orgUrl: '  ', pat: '  ' }, noFallback)).toBe(false)
    const blankishFallback: AdoFallback = { orgUrl: '  ', project: '', hasPat: false }
    expect(hasAdoConnection({ ...blank, pat: 't' }, blankishFallback)).toBe(false)
  })
})

describe('effectiveAdoOrgUrl', () => {
  test('what the user saved wins over the fallback', () => {
    expect(
      effectiveAdoOrgUrl({ ...blank, orgUrl: ' https://saved ' }, { orgUrl: 'https://fallback', project: '', hasPat: true })
    ).toBe('https://saved')
  })

  test('a blank saved org URL defers to the fallback', () => {
    expect(effectiveAdoOrgUrl({ ...blank, orgUrl: '  ' }, { orgUrl: ' https://fallback ', project: '', hasPat: false })).toBe(
      'https://fallback'
    )
  })

  test('neither configured is no org URL at all', () => {
    expect(effectiveAdoOrgUrl(blank, noFallback)).toBe('')
  })
})

describe('prWebUrl', () => {
  const pr = { projectId: 'SPOT', repositoryName: 'intersect-app', prId: 501 }

  test('builds the browsable pull-request page from the org URL, project, repository and id', () => {
    expect(prWebUrl('https://devops.example.com/tfs/DefaultCollection', pr)).toBe(
      'https://devops.example.com/tfs/DefaultCollection/SPOT/_git/intersect-app/pullrequest/501'
    )
  })

  test('a trailing slash on the org URL does not double up', () => {
    expect(prWebUrl('https://devops.example.com/tfs/DefaultCollection//', pr)).toBe(
      'https://devops.example.com/tfs/DefaultCollection/SPOT/_git/intersect-app/pullrequest/501'
    )
  })

  test('a project or repository whose name needs encoding stays one path segment', () => {
    expect(
      prWebUrl('https://devops.example.com', {
        projectId: 'Škoda Digital',
        repositoryName: 'intersect/app',
        prId: 7
      })
    ).toBe(
      'https://devops.example.com/%C5%A0koda%20Digital/_git/intersect%2Fapp/pullrequest/7'
    )
  })

  test('nothing to build a link from is no link, never a malformed one', () => {
    expect(prWebUrl('', pr)).toBe('')
    expect(prWebUrl('   ', pr)).toBe('')
    expect(prWebUrl('https://devops.example.com', { ...pr, projectId: '' })).toBe('')
    expect(prWebUrl('https://devops.example.com', { ...pr, repositoryName: '' })).toBe('')
    expect(prWebUrl('https://devops.example.com', { ...pr, prId: 0 })).toBe('')
  })
})
