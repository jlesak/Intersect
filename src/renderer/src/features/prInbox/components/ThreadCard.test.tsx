import { act, fireEvent, render } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { PrThread } from '@common/domain'
import { ThreadCard } from './ThreadCard'

const thread = (over: Partial<PrThread> = {}): PrThread => ({
  threadId: 1,
  filePath: 'src/core/sync.ts',
  line: 12,
  status: 'active',
  isSystem: false,
  comments: [{ authorName: 'Marek Kral', body: 'Should the limit be configurable?', publishedAt: 1 }],
  ...over
})

interface Mounted {
  input: HTMLTextAreaElement
  reply: ReturnType<typeof vi.fn>
}

async function mount(over: Partial<PrThread> = {}, initialReply = ''): Promise<Mounted> {
  const reply = vi.fn<(body: string) => Promise<boolean>>().mockResolvedValue(true)
  await act(async () => {
    render(
      <ThreadCard
        thread={thread(over)}
        initialReply={initialReply}
        onReply={reply}
        onSetStatus={async () => true}
      />
    )
  })
  const input = document.querySelector<HTMLTextAreaElement>('[data-testid="pr-thread-reply"]')!
  return { input, reply }
}

/**
 * The reply box of an ADO comment thread. A review reply is prose - a sentence of reasoning, often
 * a snippet - so the box has to take more than one line without the Enter key sending it half
 * written.
 */
describe('ThreadCard reply', () => {
  test('takes a multi-line reply', async () => {
    const { input } = await mount()

    expect(input.tagName).toBe('TEXTAREA')
    await act(async () => {
      fireEvent.change(input, { target: { value: 'First line.\nSecond line.' } })
    })
    expect(input.value).toBe('First line.\nSecond line.')
  })

  test('a plain Enter writes a newline instead of sending', async () => {
    const { input, reply } = await mount()

    await act(async () => {
      fireEvent.change(input, { target: { value: 'Half a thought' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    expect(reply).not.toHaveBeenCalled()
  })

  test('Cmd+Enter sends, and does not also insert a newline', async () => {
    const { input, reply } = await mount()

    await act(async () => {
      fireEvent.change(input, { target: { value: 'Fixed in the next push.' } })
    })
    let defaultAllowed = true
    await act(async () => {
      defaultAllowed = fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    })

    expect(reply).toHaveBeenCalledWith('Fixed in the next push.')
    // fireEvent answers false once the handler has called preventDefault.
    expect(defaultAllowed).toBe(false)
    // An accepted reply empties the box.
    expect(input.value).toBe('')
  })

  test('Escape stays inside the reply box, so the detail does not navigate away', async () => {
    const { input } = await mount()
    const onWindowEscape = vi.fn()
    window.addEventListener('keydown', onWindowEscape)

    try {
      await act(async () => {
        fireEvent.keyDown(input, { key: 'Escape' })
      })
      expect(onWindowEscape).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', onWindowEscape)
    }
  })

  test('a rejected reply keeps the typed text, and every keystroke is reported for the draft', async () => {
    const reply = vi.fn<(body: string) => Promise<boolean>>().mockResolvedValue(false)
    const onReplyChange = vi.fn()
    await act(async () => {
      render(
        <ThreadCard
          thread={thread()}
          initialReply="Seeded from the draft"
          onReply={reply}
          onSetStatus={async () => true}
          onReplyChange={onReplyChange}
        />
      )
    })
    const input = document.querySelector<HTMLTextAreaElement>('[data-testid="pr-thread-reply"]')!
    expect(input.value).toBe('Seeded from the draft')

    await act(async () => {
      fireEvent.change(input, { target: { value: 'Line one\nLine two' } })
    })
    expect(onReplyChange).toHaveBeenCalledWith('Line one\nLine two')

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
    })
    expect(input.value).toBe('Line one\nLine two')
  })
})
