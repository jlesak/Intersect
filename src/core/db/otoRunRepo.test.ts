import { beforeEach, describe, expect, test } from 'vitest'
import { createOtoRunRepo, type OtoRunRepo } from './otoRunRepo'
import { makeTestDb, makeTestDeps } from './testkit'

describe('otoRunRepo', () => {
  let repo: OtoRunRepo

  beforeEach(() => {
    repo = createOtoRunRepo(makeTestDb(), makeTestDeps())
  })

  test('create starts a run as running with empty results', () => {
    const run = repo.create({ type: 'process', person: 'Marek K.', vttPath: '/tmp/marek.vtt' })
    expect(run).toMatchObject({
      type: 'process',
      person: 'Marek K.',
      vttPath: '/tmp/marek.vtt',
      status: 'running',
      notionUrl: null,
      slackDraftCreated: false,
      slackChannelLink: null,
      resultMarkdown: null,
      error: null,
      finishedAt: null
    })
    expect(run.createdAt).toBeGreaterThan(0)
    expect(repo.get(run.id)).toEqual(run)
  })

  test('a prep run stores a null vtt path', () => {
    const run = repo.create({ type: 'prep', person: 'Tereza N.', vttPath: null })
    expect(run.vttPath).toBeNull()
  })

  test('listAll returns runs newest first', () => {
    const a = repo.create({ type: 'process', person: 'A', vttPath: '/a.vtt' })
    const b = repo.create({ type: 'prep', person: 'B', vttPath: null })
    const c = repo.create({ type: 'prep', person: 'C', vttPath: null })
    expect(repo.listAll().map((r) => r.id)).toEqual([c.id, b.id, a.id])
  })

  test('setDone on a process run stores the Notion/Slack outcome and stamps finishedAt', () => {
    const run = repo.create({ type: 'process', person: 'Marek K.', vttPath: '/m.vtt' })
    const done = repo.setDone(run.id, {
      type: 'process',
      notionUrl: 'https://www.notion.so/page-1',
      slackDraftCreated: true,
      slackChannelLink: 'https://greencode.slack.com/archives/D1'
    })
    expect(done.status).toBe('done')
    expect(done.notionUrl).toBe('https://www.notion.so/page-1')
    expect(done.slackDraftCreated).toBe(true)
    expect(done.slackChannelLink).toBe('https://greencode.slack.com/archives/D1')
    expect(done.resultMarkdown).toBeNull()
    expect(done.finishedAt).not.toBeNull()
  })

  test('setDone on a prep run stores the markdown briefing', () => {
    const run = repo.create({ type: 'prep', person: 'Tereza N.', vttPath: null })
    const done = repo.setDone(run.id, { type: 'prep', resultMarkdown: '## Previous 1:1\n- ok' })
    expect(done.status).toBe('done')
    expect(done.resultMarkdown).toBe('## Previous 1:1\n- ok')
    expect(done.notionUrl).toBeNull()
    expect(done.finishedAt).not.toBeNull()
  })

  test('setFailed records the error and stamps finishedAt', () => {
    const run = repo.create({ type: 'prep', person: 'X', vttPath: null })
    const failed = repo.setFailed(run.id, 'The session timed out')
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('The session timed out')
    expect(failed.finishedAt).not.toBeNull()
  })

  test('setDone / setFailed on an unknown id throw', () => {
    expect(() =>
      repo.setDone('nope', { type: 'prep', resultMarkdown: 'x' })
    ).toThrow(/not found/)
    expect(() => repo.setFailed('nope', 'x')).toThrow(/not found/)
  })

  test('reconcileOnBoot fails every running run and leaves finished ones alone', () => {
    const interrupted = repo.create({ type: 'process', person: 'A', vttPath: '/a.vtt' })
    const doneRun = repo.create({ type: 'prep', person: 'B', vttPath: null })
    repo.setDone(doneRun.id, { type: 'prep', resultMarkdown: 'md' })
    const failedRun = repo.create({ type: 'prep', person: 'C', vttPath: null })
    repo.setFailed(failedRun.id, 'boom')

    repo.reconcileOnBoot()

    const after = repo.get(interrupted.id)!
    expect(after.status).toBe('failed')
    expect(after.error).toBe('Interrupted by app restart')
    expect(after.finishedAt).not.toBeNull()
    expect(repo.get(doneRun.id)!.status).toBe('done')
    expect(repo.get(failedRun.id)!.error).toBe('boom')
  })
})
