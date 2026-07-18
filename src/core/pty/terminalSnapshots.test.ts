import { describe, expect, test } from 'vitest'
import { createTerminalSnapshots } from './terminalSnapshots'

describe('terminalSnapshots', () => {
  test('serializes fed chunks after flush', async () => {
    const snaps = createTerminalSnapshots()
    snaps.create('a', 80, 24)
    snaps.feed('a', 'Allow Bash(ls)?\r\n1. Yes\r\n2. No\r\n')
    await snaps.flush('a')
    const out = snaps.serialize('a')
    expect(out).toContain('Allow Bash(ls)?')
    expect(out).toContain('1. Yes')
    expect(out).toContain('2. No')
  })

  test('SGR colors survive serialization', async () => {
    const snaps = createTerminalSnapshots()
    snaps.create('a', 80, 24)
    snaps.feed('a', '\x1b[31mred\x1b[0m plain \x1b[1;32mbold green\x1b[0m\r\n')
    await snaps.flush('a')
    const out = snaps.serialize('a')
    expect(out).toContain('red')
    expect(out).toContain('bold green')
    expect(out).toContain('[31m')
    expect(out).toMatch(/\[(1;32|32;1)m/)
  })

  test('screen + scrollback clear serializes only the final frame', async () => {
    const snaps = createTerminalSnapshots()
    snaps.create('a', 80, 24)
    snaps.feed('a', 'first frame\r\n')
    snaps.feed('a', '\x1b[2J\x1b[3J\x1b[Hsecond frame\r\n')
    await snaps.flush('a')
    const out = snaps.serialize('a')
    expect(out).toContain('second frame')
    expect(out).not.toContain('first frame')
  })

  test('unknown session: feed no-ops, flush resolves, serialize is empty', async () => {
    const snaps = createTerminalSnapshots()
    expect(() => snaps.feed('ghost', 'x')).not.toThrow()
    await expect(snaps.flush('ghost')).resolves.toBeUndefined()
    expect(snaps.serialize('ghost')).toBe('')
  })

  test('a second create for a live session keeps the parsed content', async () => {
    const snaps = createTerminalSnapshots()
    snaps.create('a', 80, 24)
    snaps.feed('a', 'kept output\r\n')
    await snaps.flush('a')
    snaps.create('a', 120, 40)
    expect(snaps.serialize('a')).toContain('kept output')
  })

  test('dispose drops the terminal and is idempotent', async () => {
    const snaps = createTerminalSnapshots()
    snaps.create('a', 80, 24)
    snaps.feed('a', 'hello\r\n')
    await snaps.flush('a')
    snaps.dispose('a')
    expect(snaps.serialize('a')).toBe('')
    expect(() => snaps.dispose('a')).not.toThrow()
    expect(() => snaps.feed('a', 'late')).not.toThrow()
  })

  test('scrollback stays capped: the oldest flooded lines fall out of the snapshot', async () => {
    const snaps = createTerminalSnapshots()
    snaps.create('a', 80, 24)
    for (let i = 1; i <= 500; i++) {
      snaps.feed('a', `line-${String(i).padStart(4, '0')}\r\n`)
    }
    await snaps.flush('a')
    const out = snaps.serialize('a')
    expect(out).toContain('line-0500')
    expect(out).not.toContain('line-0001')
    // 200 scrollback lines + 24 screen rows bound the recoverable history.
    expect(out).not.toContain('line-0250')
    expect(out).toContain('line-0300')
  })

  test('resize applies real dimensions and ignores non-positive ones', async () => {
    const snaps = createTerminalSnapshots()
    snaps.create('a', 80, 24)
    snaps.feed('a', 'resize me\r\n')
    expect(() => snaps.resize('a', 0, 0)).not.toThrow()
    expect(() => snaps.resize('a', 120, 40)).not.toThrow()
    expect(() => snaps.resize('ghost', 120, 40)).not.toThrow()
    await snaps.flush('a')
    expect(snaps.serialize('a')).toContain('resize me')
  })
})
