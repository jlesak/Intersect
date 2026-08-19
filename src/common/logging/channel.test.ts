import { describe, expect, it } from 'vitest'
import { Channel } from '../ipc'
import { RENDERER_LOG_CHANNEL, UNLOGGED_CHANNELS } from './channel'

describe('RENDERER_LOG_CHANNEL', () => {
  it('is not a member of the routed channel taxonomy', () => {
    // CORE_INVOKE_CHANNELS is derived as "every Channel not otherwise classified", so a log
    // channel added to the enum would silently be forwarded into the core process.
    expect(Object.values(Channel)).not.toContain(RENDERER_LOG_CHANNEL)
  })
})

describe('UNLOGGED_CHANNELS', () => {
  it('excludes the high-frequency terminal paths', () => {
    expect(UNLOGGED_CHANNELS.has(Channel.terminalInput)).toBe(true)
    expect(UNLOGGED_CHANNELS.has(Channel.terminalResize)).toBe(true)
    expect(UNLOGGED_CHANNELS.has(Channel.terminalData)).toBe(true)
    expect(UNLOGGED_CHANNELS.has(Channel.prInboxReviewData)).toBe(true)
  })

  it('still logs low-frequency terminal lifecycle', () => {
    expect(UNLOGGED_CHANNELS.has(Channel.terminalSpawn)).toBe(false)
    expect(UNLOGGED_CHANNELS.has(Channel.terminalKill)).toBe(false)
  })
})
