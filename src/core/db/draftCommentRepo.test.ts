import { beforeEach, describe, expect, test } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import type { NewManualDraft } from '@common/domain'
import { createDraftCommentRepo, type DraftCommentRepo } from './draftCommentRepo'
import { makeTestDb, makeTestDeps } from './testkit'

const draft = (over: Partial<NewManualDraft> = {}): NewManualDraft => ({
  prId: 42,
  repositoryId: 'repo-a',
  filePath: 'src/index.ts',
  line: 10,
  side: 'right',
  body: 'consider extracting this',
  ...over
})

describe('draftCommentRepo', () => {
  let db: DatabaseSync
  let repo: DraftCommentRepo

  beforeEach(() => {
    db = makeTestDb()
    repo = createDraftCommentRepo(db, makeTestDeps())
  })

  test('create stores a pending draft with its source and deterministic id', () => {
    const d = repo.create(draft(), 'claude', 'source-sha', 'session-1')
    expect(d.id).toBe('id-1')
    expect(d.status).toBe('pending')
    expect(d.source).toBe('claude')
    expect(d.reviewSessionId).toBe('session-1')
    expect(d.sourceCommitId).toBe('source-sha')
    expect(d.publishedThreadId).toBeNull()
    expect(d.line).toBe(10)
  })

  test('manual drafts default to a null review session', () => {
    const d = repo.create(draft(), 'manual', 'source-sha')
    expect(d.reviewSessionId).toBeNull()
    expect(d.source).toBe('manual')
  })

  test('listByPr returns non-discarded drafts oldest-first, scoped to the PR', () => {
    repo.create(draft({ body: 'first' }), 'claude', 'sha')
    repo.create(draft({ body: 'second' }), 'manual', 'sha')
    repo.create(draft({ prId: 99, body: 'other pr' }), 'manual', 'sha')
    const list = repo.listByPr('repo-a', 42)
    expect(list.map((d) => d.body)).toEqual(['first', 'second'])
  })

  test('discarded drafts are hidden from listByPr but the row survives', () => {
    const d = repo.create(draft(), 'manual', 'sha')
    repo.setStatus(d.id, 'discarded')
    expect(repo.listByPr('repo-a', 42)).toEqual([])
    expect(repo.get(d.id)?.status).toBe('discarded')
  })

  test('setBody edits the text and returns the canonical row', () => {
    const d = repo.create(draft(), 'manual', 'sha')
    const updated = repo.setBody(d.id, 'rewritten')
    expect(updated.body).toBe('rewritten')
  })

  test('setStatus can record the published thread id', () => {
    const d = repo.create(draft(), 'claude', 'sha')
    const published = repo.setStatus(d.id, 'published', 7788)
    expect(published.status).toBe('published')
    expect(published.publishedThreadId).toBe(7788)
  })

  test('claimForPublish wins once then rejects a second concurrent claim', () => {
    const d = repo.create(draft(), 'manual', 'sha')
    expect(repo.claimForPublish(d.id)).toBe(true)
    expect(repo.get(d.id)?.status).toBe('publishing')
    // Second claim finds status 'publishing', not pending/approved -> loses.
    expect(repo.claimForPublish(d.id)).toBe(false)
  })

  test('claimForPublish refuses an already-published draft', () => {
    const d = repo.create(draft(), 'manual', 'sha')
    repo.setStatus(d.id, 'published', 1)
    expect(repo.claimForPublish(d.id)).toBe(false)
  })

  test('missing draft mutations throw a message-only error', () => {
    expect(() => repo.setBody('nope', 'x')).toThrow(/not found/i)
  })

  test('CHECK constraint rejects an invalid side', () => {
    expect(() => repo.create(draft({ side: 'middle' as unknown as 'right' }), 'manual', 'sha')).toThrow()
  })

  test('published and discarded rows are history, not remaining review work', () => {
    const published = repo.create(draft({ body: 'published' }), 'claude', 'sha')
    const discarded = repo.create(draft({ body: 'discarded' }), 'claude', 'sha')
    const remaining = repo.create(draft({ body: 'remaining' }), 'claude', 'sha')
    repo.setStatus(published.id, 'published', 12)
    repo.setStatus(discarded.id, 'discarded')

    expect(repo.listByPr('repo-a', 42).map((d) => d.id)).toEqual([remaining.id])
    expect(repo.listUnfinishedReviews()).toEqual([
      { repositoryId: 'repo-a', prId: 42, remainingDraftCount: 1 }
    ])
  })
})
