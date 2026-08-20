import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { TodoTask } from '@common/domain'
import { copyTodoTask, todoClipboardText } from './clipboard'

// 2026-08-07 is a Friday. Every relative wording below is read against that day.
const FRIDAY = '2026-08-07'

const task = (over: Partial<TodoTask> = {}): TodoTask => ({
  id: 't1',
  text: 'Call the vendor',
  description: '',
  dueDay: null,
  priority: 4,
  sortOrder: 0,
  doneAt: null,
  ...over
})

describe('todoClipboardText', () => {
  test('a bare task is its title and nothing else', () => {
    expect(todoClipboardText(task(), FRIDAY)).toBe('Call the vendor')
  })

  test('a description follows the title on its own line', () => {
    expect(todoClipboardText(task({ description: 'about the invoice' }), FRIDAY)).toBe(
      'Call the vendor\nabout the invoice'
    )
  })

  test('the due day is written the way the row shows it', () => {
    expect(todoClipboardText(task({ dueDay: '2026-08-08' }), FRIDAY)).toBe(
      'Call the vendor\ndue tomorrow'
    )
    expect(todoClipboardText(task({ dueDay: '2026-08-20' }), FRIDAY)).toBe(
      'Call the vendor\ndue Thu 20.08'
    )
  })

  test('everything the task carries lands in title, description, due order', () => {
    expect(
      todoClipboardText(task({ description: 'about the invoice', dueDay: FRIDAY }), FRIDAY)
    ).toBe('Call the vendor\nabout the invoice\ndue today')
  })
})

describe('copyTodoTask', () => {
  const clipboard = { writeText: vi.fn<(text: string) => Promise<void>>() }

  beforeEach(() => {
    clipboard.writeText.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
  })

  test('writes the task text to the clipboard', async () => {
    await copyTodoTask(task({ dueDay: '2026-08-08' }), FRIDAY)

    expect(clipboard.writeText).toHaveBeenCalledWith('Call the vendor\ndue tomorrow')
  })

  test('a refused clipboard is reported, never an unhandled rejection', async () => {
    clipboard.writeText.mockRejectedValue(new Error('denied'))

    await expect(copyTodoTask(task(), FRIDAY)).resolves.toBeUndefined()
  })
})
