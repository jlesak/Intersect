import { describe, expect, it } from 'vitest'
import {
  transition,
  type LifecycleEvent,
  type LifecycleOutput,
  type LifecycleState
} from './lifecycle'

interface Case {
  name: string
  from: LifecycleState
  event: LifecycleEvent
  to: LifecycleState
  outputs?: LifecycleOutput[]
}

const cases: Case[] = [
  {
    name: 'spawning -> working on sessionStart (stores session id)',
    from: 'spawning',
    event: { kind: 'sessionStart', claudeSessionId: 'abc' },
    to: 'working',
    outputs: [{ kind: 'storeClaudeSessionId', claudeSessionId: 'abc' }]
  },
  {
    name: 'working -> waiting-permission on notificationPermission',
    from: 'working',
    event: { kind: 'notificationPermission' },
    to: 'waiting-permission'
  },
  {
    name: 'working -> waiting-input on stopHook',
    from: 'working',
    event: { kind: 'stopHook' },
    to: 'waiting-input'
  },
  {
    name: 'waiting-input -> idle-notify on notificationIdle (idle backstop)',
    from: 'waiting-input',
    event: { kind: 'notificationIdle' },
    to: 'idle-notify'
  },
  {
    name: 'working -> idle-notify on notificationIdle (Stop hook was missed)',
    from: 'working',
    event: { kind: 'notificationIdle' },
    to: 'idle-notify'
  },
  {
    name: 'waiting-permission stays on notificationIdle (permission trumps idle)',
    from: 'waiting-permission',
    event: { kind: 'notificationIdle' },
    to: 'waiting-permission'
  },
  {
    name: 'waiting-permission -> working on userPromptSubmit (clears attention)',
    from: 'waiting-permission',
    event: { kind: 'userPromptSubmit' },
    to: 'working',
    outputs: [{ kind: 'clearAttention' }]
  },
  {
    name: 'waiting-input -> working on userPromptSubmit',
    from: 'waiting-input',
    event: { kind: 'userPromptSubmit' },
    to: 'working',
    outputs: [{ kind: 'clearAttention' }]
  },
  {
    name: 'idle-notify -> working on userPromptSubmit',
    from: 'idle-notify',
    event: { kind: 'userPromptSubmit' },
    to: 'working',
    outputs: [{ kind: 'clearAttention' }]
  },
  {
    name: 'waiting-input -> working on ptyData',
    from: 'waiting-input',
    event: { kind: 'ptyData' },
    to: 'working'
  },
  {
    name: 'idle-notify -> working on ptyData',
    from: 'idle-notify',
    event: { kind: 'ptyData' },
    to: 'working'
  },
  {
    name: 'working stays on ptyData (no-op)',
    from: 'working',
    event: { kind: 'ptyData' },
    to: 'working'
  },
  {
    name: 'waiting-permission stays on ptyData (prompt repaint is not an answer)',
    from: 'waiting-permission',
    event: { kind: 'ptyData' },
    to: 'waiting-permission'
  },
  {
    name: 'working -> finished on ptyExit(0)',
    from: 'working',
    event: { kind: 'ptyExit', code: 0 },
    to: 'finished'
  },
  {
    name: 'working -> crashed on ptyExit(non-zero)',
    from: 'working',
    event: { kind: 'ptyExit', code: 1 },
    to: 'crashed'
  },
  {
    name: 'waiting-input -> crashed on ptyExit(137)',
    from: 'waiting-input',
    event: { kind: 'ptyExit', code: 137 },
    to: 'crashed'
  },
  {
    name: 'working stays on sessionEnd (mid-life rollover, not terminal)',
    from: 'working',
    event: { kind: 'sessionEnd' },
    to: 'working'
  },
  {
    name: 'waiting-input stays on sessionEnd (mid-life rollover, not terminal)',
    from: 'waiting-input',
    event: { kind: 'sessionEnd' },
    to: 'waiting-input'
  },
  {
    name: 'waiting-permission stays on stopHook (permission trumps input)',
    from: 'waiting-permission',
    event: { kind: 'stopHook' },
    to: 'waiting-permission'
  }
]

describe('transition', () => {
  for (const c of cases) {
    it(c.name, () => {
      const result = transition(c.from, c.event)
      expect(result.state).toBe(c.to)
      if (c.outputs) expect(result.outputs).toEqual(c.outputs)
      else expect(result.outputs).toEqual([])
    })
  }

  it('is a no-op for every event in terminal states', () => {
    expect(transition('finished', { kind: 'ptyData' }).state).toBe('finished')
    expect(transition('finished', { kind: 'sessionStart', claudeSessionId: 'x' })).toEqual({
      state: 'finished',
      outputs: []
    })
    expect(transition('crashed', { kind: 'userPromptSubmit' }).state).toBe('crashed')
    expect(transition('crashed', { kind: 'notificationPermission' }).state).toBe('crashed')
  })

  it('a delayed sessionEnd cannot finish a live session in any non-terminal state', () => {
    for (const from of [
      'spawning',
      'working',
      'waiting-permission',
      'waiting-input',
      'idle-notify'
    ] as const) {
      expect(transition(from, { kind: 'sessionEnd' })).toEqual({ state: from, outputs: [] })
    }
  })

  it('sessionStart on non-spawning state stays put but still records the session id (post-/clear rollover)', () => {
    const result = transition('working', { kind: 'sessionStart', claudeSessionId: 'xyz' })
    expect(result.state).toBe('working')
    expect(result.outputs).toEqual([{ kind: 'storeClaudeSessionId', claudeSessionId: 'xyz' }])
  })
})
