import { describe, expect, test } from 'vitest'
import type { TodoTask } from '@common/domain'
import { matchTodoMentions } from './todoMentions'

const task = (id: string, text: string): TodoTask => ({
  id,
  text,
  dueDay: null,
  sortOrder: 0,
  doneAt: null
})

describe('matchTodoMentions', () => {
  test('matches the full name and its first token, case-insensitively', () => {
    const open = [
      task('a', 'Ask marek about the rate limit fix'),
      task('b', 'Prepare notes for Marek K. before Friday'),
      task('c', 'Order a new monitor')
    ]
    expect(matchTodoMentions('Marek K.', open, [])).toEqual([
      '- [open] Ask marek about the rate limit fix',
      '- [open] Prepare notes for Marek K. before Friday'
    ])
  })

  test('marks done tasks separately from open ones', () => {
    const open = [task('a', 'Ping Tereza about the deploy')]
    const done = [task('b', 'Review the PR from Tereza')]
    expect(matchTodoMentions('Tereza N.', open, done)).toEqual([
      '- [open] Ping Tereza about the deploy',
      '- [done] Review the PR from Tereza'
    ])
  })

  test('a one-character first token does not match on its own', () => {
    const open = [task('a', 'Check the deploy logs'), task('b', 'Send K Marek the summary')]
    expect(matchTodoMentions('K Marek', open, [])).toEqual(['- [open] Send K Marek the summary'])
  })

  test('returns nothing for a blank person or when nothing matches', () => {
    const open = [task('a', 'Ask Marek about the review')]
    expect(matchTodoMentions('   ', open, [])).toEqual([])
    expect(matchTodoMentions('Tereza', open, [])).toEqual([])
  })
})
