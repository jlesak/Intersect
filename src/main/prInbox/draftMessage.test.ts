import { beforeEach, describe, expect, test } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { createDraftCommentRepo, type DraftCommentRepo } from '../db/draftCommentRepo'
import { makeTestDb, makeTestDeps } from '../db/testkit'
import { handleDraftMessage, parseDraftPayload, type DraftContext } from './draftMessage'

const ctx: DraftContext = { prId: 42, repositoryId: 'repo-a', reviewSessionId: 'session-1' }

describe('parseDraftPayload', () => {
  test('parses a well-formed line', () => {
    const p = parseDraftPayload('{"sessionId":"s","filePath":"a.ts","line":3,"side":"right","body":"x"}')
    expect(p).toEqual({ sessionId: 's', filePath: 'a.ts', line: 3, side: 'right', body: 'x' })
  })
  test('throws on malformed json', () => {
    expect(() => parseDraftPayload('{not json')).toThrow()
  })
})

describe('handleDraftMessage', () => {
  let db: DatabaseSync
  let repo: DraftCommentRepo

  beforeEach(() => {
    db = makeTestDb()
    repo = createDraftCommentRepo(db, makeTestDeps())
  })

  test('persists a claude draft anchored to the trusted context', () => {
    const d = handleDraftMessage(repo, ctx, {
      sessionId: 'session-1',
      filePath: 'src/a.ts',
      line: 12,
      side: 'right',
      body: 'nit: rename'
    })
    expect(d.prId).toBe(42)
    expect(d.repositoryId).toBe('repo-a')
    expect(d.reviewSessionId).toBe('session-1')
    expect(d.source).toBe('claude')
    expect(repo.listByPr('repo-a', 42)).toHaveLength(1)
  })

  test('coerces an unknown side to right', () => {
    const d = handleDraftMessage(repo, ctx, { sessionId: 's', filePath: 'a.ts', line: 1, side: 'weird', body: 'b' })
    expect(d.side).toBe('right')
  })

  test('keeps an explicit left side', () => {
    const d = handleDraftMessage(repo, ctx, { sessionId: 's', filePath: 'a.ts', line: 1, side: 'left', body: 'b' })
    expect(d.side).toBe('left')
  })

  test.each([
    ['empty file path', { filePath: '', line: 1, body: 'b' }],
    ['empty body', { filePath: 'a.ts', line: 1, body: '  ' }],
    ['zero line', { filePath: 'a.ts', line: 0, body: 'b' }],
    ['NaN line', { filePath: 'a.ts', line: Number.NaN, body: 'b' }]
  ])('rejects %s', (_label, over) => {
    expect(() =>
      handleDraftMessage(repo, ctx, { sessionId: 's', side: 'right', ...over } as never)
    ).toThrow()
  })
})
