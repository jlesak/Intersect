import { describe, expect, test } from 'vitest'
import type { TerminalDataEvent } from '@common/ipc'
import { createTerminalSnapshots, type TerminalSnapshots } from './terminalSnapshots'
import { createTerminalStream } from './terminalStream'

function harness() {
  const emitted: TerminalDataEvent[] = []
  const logs: string[] = []
  const snapshots = createTerminalSnapshots()
  const stream = createTerminalStream({
    snapshots,
    emit: (e) => emitted.push(e),
    log: (m) => logs.push(m)
  })
  return { stream, emitted, logs, snapshots }
}

describe('terminalStream', () => {
  test('numbers chunks monotonically from 1, independently per session', () => {
    const h = harness()
    h.stream.onSpawn('a', 80, 24)
    h.stream.onSpawn('b', 80, 24)
    h.stream.onData('a', 'one')
    h.stream.onData('b', 'uno')
    h.stream.onData('a', 'two')
    expect(h.emitted).toEqual([
      { sessionId: 'a', data: 'one', seq: 1 },
      { sessionId: 'b', data: 'uno', seq: 1 },
      { sessionId: 'a', data: 'two', seq: 2 }
    ])
  })

  test('feeds the snapshot before fanning out each chunk', () => {
    const order: string[] = []
    const fake: TerminalSnapshots = {
      create: () => order.push('create'),
      feed: (_id, chunk) => order.push(`feed:${chunk}`),
      flush: () => Promise.resolve(),
      serialize: () => '',
      resize: () => {},
      dispose: () => {}
    }
    const stream = createTerminalStream({ snapshots: fake, emit: (e) => order.push(`emit:${e.data}`) })
    stream.onSpawn('a', 80, 24)
    stream.onData('a', 'x')
    stream.onData('a', 'y')
    expect(order).toEqual(['create', 'feed:x', 'emit:x', 'feed:y', 'emit:y'])
  })

  test('attach on an unknown session answers live: false', async () => {
    const h = harness()
    await expect(h.stream.attach('ghost')).resolves.toEqual({ live: false })
  })

  test('safe empty attach: a fresh session answers live with empty data and real dims', async () => {
    const h = harness()
    h.stream.onSpawn('a', 100, 40)
    await expect(h.stream.attach('a')).resolves.toEqual({
      live: true,
      data: '',
      cols: 100,
      rows: 40,
      lastSeq: 0
    })
  })

  test('attach returns the serialized ANSI screen and the current dimensions after a resize', async () => {
    const h = harness()
    h.stream.onSpawn('a', 80, 24)
    h.stream.onData('a', '\x1b[33myellow\x1b[0m output\r\n')
    h.stream.onResize('a', 132, 43)
    const result = await h.stream.attach('a')
    if (!result.live) throw new Error('expected a live attach')
    expect(result.data).toContain('yellow')
    expect(result.data).toContain('[33m')
    expect(result.cols).toBe(132)
    expect(result.rows).toBe(43)
    expect(result.lastSeq).toBe(1)
  })

  test('exactly-once: chunks arriving during an attach are excluded from the snapshot and replayed after lastSeq', async () => {
    const h = harness()
    h.stream.onSpawn('a', 80, 24)
    h.stream.onData('a', 'before-attach\r\n')

    const pending = h.stream.attach('a')
    // Let the attach close its gate (it starts on the microtask queue), then emit mid-attach
    // output - the deterministic race the protocol must resolve.
    await Promise.resolve()
    h.stream.onData('a', 'during-attach-1\r\n')
    h.stream.onData('a', 'during-attach-2\r\n')
    const result = await pending
    if (!result.live) throw new Error('expected a live attach')

    // The snapshot contains exactly seq <= lastSeq: the pre-attach chunk and nothing else.
    expect(result.lastSeq).toBe(1)
    expect(result.data).toContain('before-attach')
    expect(result.data).not.toContain('during-attach')

    // The held chunks were replayed through the normal pipeline, in order, numbered past
    // lastSeq - so a renderer dropping seq <= lastSeq renders every byte exactly once.
    const replayed = h.emitted.filter((e) => (e.seq ?? 0) > result.lastSeq)
    expect(replayed).toEqual([
      { sessionId: 'a', data: 'during-attach-1\r\n', seq: 2 },
      { sessionId: 'a', data: 'during-attach-2\r\n', seq: 3 }
    ])

    // Replay also fed the snapshot: a second attach sees the held output.
    const second = await h.stream.attach('a')
    if (!second.live) throw new Error('expected a live attach')
    expect(second.data).toContain('during-attach-1')
    expect(second.data).toContain('during-attach-2')
    expect(second.lastSeq).toBe(3)
  })

  test('chunks emitted between the attach call and the gate closing stay on the drop side of lastSeq', async () => {
    const h = harness()
    h.stream.onSpawn('a', 80, 24)
    const pending = h.stream.attach('a')
    // No microtask has run yet: the gate is not closed, so this goes through the normal
    // pipeline - but it is then covered by the flush barrier and counted into lastSeq.
    h.stream.onData('a', 'racing-chunk\r\n')
    const result = await pending
    if (!result.live) throw new Error('expected a live attach')
    expect(result.data).toContain('racing-chunk')
    expect(result.lastSeq).toBe(1)
    expect(h.emitted).toEqual([{ sessionId: 'a', data: 'racing-chunk\r\n', seq: 1 }])
  })

  test('concurrent attaches for one session serialize instead of clobbering held chunks', async () => {
    const h = harness()
    h.stream.onSpawn('a', 80, 24)
    const first = h.stream.attach('a')
    const second = h.stream.attach('a')
    await Promise.resolve()
    h.stream.onData('a', 'held-under-double-attach\r\n')
    const [r1, r2] = await Promise.all([first, second])
    if (!r1.live || !r2.live) throw new Error('expected live attaches')
    // The chunk is replayed exactly once and lands after the first attach's boundary.
    const numbered = h.emitted.filter((e) => e.data.includes('held-under-double-attach'))
    expect(numbered).toHaveLength(1)
    expect(numbered[0].seq).toBe(1)
    expect(r1.lastSeq).toBe(0)
    expect(r2.lastSeq).toBe(1)
    expect(r2.data).toContain('held-under-double-attach')
  })

  test('dispose is idempotent, later attaches answer live: false, late chunks flow through unnumbered', () => {
    const h = harness()
    h.stream.onSpawn('a', 80, 24)
    h.stream.onData('a', 'x')
    h.stream.dispose('a')
    expect(() => h.stream.dispose('a')).not.toThrow()
    h.stream.onData('a', 'late-bytes')
    expect(h.emitted).toContainEqual({ sessionId: 'a', data: 'late-bytes' })
    return expect(h.stream.attach('a')).resolves.toEqual({ live: false })
  })

  test('a session disposed during an in-flight attach answers live: false', async () => {
    const h = harness()
    h.stream.onSpawn('a', 80, 24)
    h.stream.onData('a', 'doomed output\r\n')
    const pending = h.stream.attach('a')
    await Promise.resolve()
    h.stream.dispose('a')
    await expect(pending).resolves.toEqual({ live: false })
  })

  test('onSpawn is idempotent: a re-spawn of a live session keeps the counter and snapshot', async () => {
    const h = harness()
    expect(h.stream.onSpawn('a', 80, 24)).toBe(true)
    h.stream.onData('a', 'survives respawn\r\n')
    expect(h.stream.onSpawn('a', 80, 24)).toBe(false)
    const result = await h.stream.attach('a')
    if (!result.live) throw new Error('expected a live attach')
    expect(result.data).toContain('survives respawn')
    expect(result.lastSeq).toBe(1)
  })

  test('disposeAll drops every session', async () => {
    const h = harness()
    h.stream.onSpawn('a', 80, 24)
    h.stream.onSpawn('b', 80, 24)
    h.stream.disposeAll()
    await expect(h.stream.attach('a')).resolves.toEqual({ live: false })
    await expect(h.stream.attach('b')).resolves.toEqual({ live: false })
  })

  test('a flooded session still attaches, bounded to recent history, and logs the duration', async () => {
    const h = harness()
    h.stream.onSpawn('a', 80, 24)
    for (let i = 1; i <= 1000; i++) {
      h.stream.onData('a', `flood-${String(i).padStart(4, '0')}\r\n`)
    }
    const result = await h.stream.attach('a')
    if (!result.live) throw new Error('expected a live attach')
    expect(result.data).toContain('flood-1000')
    expect(result.data).not.toContain('flood-0001')
    expect(result.lastSeq).toBe(1000)
    expect(h.logs.some((l) => l.includes('attach a:'))).toBe(true)
  })
})
