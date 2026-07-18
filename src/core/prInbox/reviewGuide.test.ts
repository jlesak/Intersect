import { describe, expect, test } from 'vitest'
import { REVIEW_GUIDE } from './reviewGuide'

describe('REVIEW_GUIDE', () => {
  test('instructs Czech, concise, unlabeled, line-anchored comments via the draft tool', () => {
    expect(REVIEW_GUIDE).toMatch(/česky/i)
    expect(REVIEW_GUIDE).toMatch(/stručn/i)
    // No severity labels in front of comments.
    expect(REVIEW_GUIDE).toMatch(/bez\s+štítk/i)
    // Comments are recorded through the draft tool, one per line.
    expect(REVIEW_GUIDE).toContain('record_draft_comment')
  })
})
