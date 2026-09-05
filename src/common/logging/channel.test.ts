import { describe, expect, it } from 'vitest'
import { Channel } from '../ipc'
import { RENDERER_LOG_CHANNEL } from './channel'

describe('RENDERER_LOG_CHANNEL', () => {
  it('is not a member of the routed channel taxonomy', () => {
    // CORE_INVOKE_CHANNELS is derived as "every Channel not otherwise classified", so a log
    // channel added to the enum would silently be forwarded into the core process.
    expect(Object.values(Channel)).not.toContain(RENDERER_LOG_CHANNEL)
  })
})
