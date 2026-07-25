import { describe, expect, test } from 'vitest'
import { autoDescription, sanitizeWorklogDescription } from './worklogDescription'

describe('sanitizeWorklogDescription', () => {
  test('pure service XML leaves nothing human', () => {
    expect(
      sanitizeWorklogDescription('<task-notification><task-id>x</task-id></task-notification>')
    ).toBeNull()
  })

  test('an unclosed tag is truncated away, leaving nothing', () => {
    expect(sanitizeWorklogDescription('<system-reminder do not do this')).toBeNull()
  })

  test('keeps the human prefix and drops the trailing service block', () => {
    expect(
      sanitizeWorklogDescription(
        'Fix the login redirect <task-notification><task-id>x</task-id></task-notification>'
      )
    ).toBe('Fix the login redirect')
  })

  test('extracts only the first sentence', () => {
    expect(sanitizeWorklogDescription('Fix the login bug. Then deploy the change.')).toBe(
      'Fix the login bug.'
    )
  })

  test('strips ANSI escape sequences', () => {
    expect(sanitizeWorklogDescription('[31mRefactor the parser[0m')).toBe(
      'Refactor the parser'
    )
  })

  test('a lone command wrapper leaves nothing', () => {
    expect(sanitizeWorklogDescription('<command-name>/clear</command-name>')).toBeNull()
  })

  test('keeps the real prompt after a command wrapper', () => {
    expect(
      sanitizeWorklogDescription('<command-name>/model</command-name> refactor the parser')
    ).toBe('refactor the parser')
  })

  test('hard-caps an over-long first sentence with an ellipsis', () => {
    const long = 'a'.repeat(200)
    const result = sanitizeWorklogDescription(long)!
    expect(result).toHaveLength(140)
    expect(result.endsWith('…')).toBe(true)
    expect(result).toBe(`${'a'.repeat(139)}…`)
  })

  test('whitespace or self-closing-tags only leaves nothing', () => {
    expect(sanitizeWorklogDescription('   ')).toBeNull()
    expect(sanitizeWorklogDescription('<br/>')).toBeNull()
  })

  test('a bare less-than in ordinary prose survives', () => {
    expect(sanitizeWorklogDescription('Fix the case where a<b evaluates incorrectly')).toBe(
      'Fix the case where a<b evaluates incorrectly'
    )
  })

  test('a generic type in ordinary prose survives', () => {
    expect(sanitizeWorklogDescription('Add a Map<string, number> cache')).toBe(
      'Add a Map<string, number> cache'
    )
  })

  test('an unterminated hyphenated service tag still truncates the human prefix', () => {
    expect(sanitizeWorklogDescription('do the thing <task-notification><task-id>abc')).toBe(
      'do the thing'
    )
  })

  test('same-name nesting keeps text that follows the closed block', () => {
    expect(
      sanitizeWorklogDescription(
        'Fix the login bug <system-reminder><system-reminder>nested</system-reminder></system-reminder> after the fix'
      )
    ).toBe('Fix the login bug after the fix')
  })

  test('bounds regex cost on a huge pasted prompt while keeping the first sentence', () => {
    const huge = `Fix the parser. ${'x'.repeat(500_000)}`
    const start = performance.now()
    const result = sanitizeWorklogDescription(huge)
    const elapsed = performance.now() - start
    expect(result).toBe('Fix the parser.')
    expect(elapsed).toBeLessThan(1000)
  })
})

describe('autoDescription', () => {
  test('prefers the sanitized title', () => {
    expect(
      autoDescription({
        title: 'Fix the parser',
        userPrompts: ['ignored'],
        folderName: 'repo',
        id: 'abc'
      })
    ).toBe('Fix the parser')
  })

  test('falls to the first sane user prompt when the title is raw XML', () => {
    expect(
      autoDescription({
        title: '<task-notification><task-id>x</task-id></task-notification>',
        userPrompts: ['<command-name>/clear</command-name>', 'Wire up the worklog'],
        folderName: 'repo',
        id: 'abc'
      })
    ).toBe('Wire up the worklog')
  })

  test('falls to the folder name when nothing human survives', () => {
    expect(
      autoDescription({
        title: '<task-notification>x</task-notification>',
        userPrompts: ['<command-name>/clear</command-name>'],
        folderName: 'my-repo',
        id: 'abc'
      })
    ).toBe('my-repo')
  })

  test('falls to the id when there is no folder name either', () => {
    expect(
      autoDescription({
        title: '<task-notification>x</task-notification>',
        userPrompts: [],
        folderName: '',
        id: 'abc'
      })
    ).toBe('abc')
  })
})
