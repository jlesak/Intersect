import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { ClaudeMemoryDetail, ClaudeMemorySummary } from '@common/domain'
import { MemorySection } from './MemorySection'
import * as api from '../ipc'

vi.mock('../ipc', () => ({
  listMemoryProjects: vi.fn(), listMemories: vi.fn(), readMemory: vi.fn(), openMemoryExternal: vi.fn()
}))

const item = (filename: string, name: string): ClaudeMemorySummary => ({
  slug: 'alpha', filename, name, description: '', type: filename === 'MEMORY.md' ? 'index' : 'feedback',
  mtime: 0, error: null
})
const index = item('MEMORY.md', 'MEMORY')
const one = item('one.md', 'One')

afterEach(() => vi.clearAllMocks())

test('renders same-project wikilinks and suppresses remote images', async () => {
  vi.mocked(api.listMemoryProjects).mockResolvedValue([{ slug: 'alpha', name: 'Alpha', count: 2 }])
  vi.mocked(api.openMemoryExternal).mockResolvedValue(undefined)
  vi.mocked(api.listMemories).mockImplementation(async (_slug, query) =>
    query === 'index' ? [index] : [index, one])
  vi.mocked(api.readMemory).mockImplementation(async (_slug, filename) => ({
    ...(filename === 'MEMORY.md' ? index : one),
    body: filename === 'MEMORY.md'
      ? '[[One]] [[Missing]] `[[Code]]` ![remote](https://example.invalid/pixel.png) [external](https://example.com)'
      : 'Target'
  } as ClaudeMemoryDetail))
  render(<MemorySection />)
  await screen.findByRole('heading', { name: 'MEMORY' })
  expect(screen.getByRole('button', { name: 'One' })).toBeTruthy()
  expect(screen.queryByRole('img')).toBeNull()
  expect(screen.getByText('Missing').tagName).toBe('SPAN')
  expect(screen.getByText('[[Code]]').tagName).toBe('CODE')
  expect(screen.getByRole('button', { name: 'external' }).tagName).toBe('BUTTON')
  fireEvent.click(screen.getByRole('button', { name: 'external' }))
  expect(api.openMemoryExternal).toHaveBeenCalledWith('https://example.com')
  fireEvent.change(screen.getByLabelText('Search memories'), { target: { value: 'index' } })
  await waitFor(() => expect(screen.getByLabelText('Memories').querySelectorAll('.ix-memory__row')).toHaveLength(1))
  // Search hides the target row, but the project-wide link still resolves.
  await screen.findByRole('button', { name: 'One' })
  fireEvent.click(screen.getByRole('button', { name: 'One' }))
  await waitFor(() => expect(screen.getByText('Target')).toBeTruthy())
})

test('an older search response cannot replace a newer one', async () => {
  let resolveOld: (items: ClaudeMemorySummary[]) => void = () => {}
  let resolveNew: (items: ClaudeMemorySummary[]) => void = () => {}
  vi.mocked(api.listMemoryProjects).mockResolvedValue([{ slug: 'alpha', name: 'Alpha', count: 2 }])
  vi.mocked(api.listMemories).mockImplementation(async (slug, query) => {
    if (slug !== null) return [index, one]
    if (query === 'old') return new Promise((resolve) => { resolveOld = resolve })
    if (query === 'new') return new Promise((resolve) => { resolveNew = resolve })
    return []
  })
  vi.mocked(api.readMemory).mockResolvedValue({ ...one, body: 'Target' })
  render(<MemorySection />)
  fireEvent.change(screen.getByLabelText('Search memories'), { target: { value: 'old' } })
  fireEvent.change(screen.getByLabelText('Search memories'), { target: { value: 'new' } })
  await act(async () => resolveNew([one]))
  await screen.findByRole('button', { name: /One feedback/ })
  await act(async () => resolveOld([index]))
  expect(screen.getByRole('button', { name: /One feedback/ })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /MEMORY index/ })).toBeNull()
})
