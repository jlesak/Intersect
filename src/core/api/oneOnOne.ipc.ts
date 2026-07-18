import { existsSync } from 'node:fs'
import type { OtoStartInput } from '@common/domain'
import { type WireRoutes } from '@common/coreBridge'
import { Channel, type IpcApi } from '@common/ipc'
import type { OtoRunRepo } from '../db/otoRunRepo'
import type { TodoRepo } from '../db/todoRepo'
import type { OtoManager } from '../oneOnOne/otoManager'
import { matchTodoMentions } from '../oneOnOne/todoMentions'

/** The renderer-facing 1:1 surface main implements (onRunChanged is a preload-side subscription). */
export type OneOnOneHandlers = Omit<IpcApi['oneOnOne'], 'onRunChanged'>

export interface OneOnOneHandlerDeps {
  runs: OtoRunRepo
  manager: Pick<OtoManager, 'start'>
  /** Read-only access to the TODO lists, fulltext-matched into the Prepare prompt. */
  todos: Pick<TodoRepo, 'listOpen' | 'listDone'>
  /** The native .vtt file picker (Electron dialog); injected for tests. */
  pickVttFile: () => Promise<string | null>
  /** Override for tests: whether the chosen VTT path exists on disk. */
  fileExists?: (path: string) => boolean
}

/**
 * Re-throw any failure as a message-only Error. Only an Error's `.message` survives the IPC
 * boundary, so this normalizes non-Error throws into something the renderer can display.
 */
async function surface<T>(op: () => T | Promise<T>): Promise<T> {
  try {
    return await op()
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err))
  }
}

/**
 * 1:1 workflow handlers: run-history reads, input validation, and the hand-off to the hidden
 * session manager. Validation lives here (not in the form) so a malformed start can never reach
 * the manager, whatever the renderer sends.
 */
export function createOneOnOneHandlers(d: OneOnOneHandlerDeps): OneOnOneHandlers {
  const fileExists = d.fileExists ?? existsSync

  return {
    list: () => surface(() => d.runs.listAll()),

    start: (input: OtoStartInput) =>
      surface(() => {
        if (input.type !== 'process' && input.type !== 'prep') {
          throw new Error(`Unknown workflow type: ${String(input.type)}`)
        }
        const person = (input.person ?? '').trim()
        if (!person) throw new Error('Person must not be empty')

        if (input.type === 'process') {
          const vttPath = input.vttPath ?? null
          if (!vttPath) throw new Error('Choose a VTT recording file')
          if (!vttPath.toLowerCase().endsWith('.vtt')) {
            throw new Error('The recording must be a .vtt file')
          }
          if (!fileExists(vttPath)) throw new Error(`The VTT file does not exist: ${vttPath}`)
          return d.manager.start({ type: 'process', person, vttPath, todoMentions: [] })
        }

        // Prepare: main splices the matching TODO items into the prompt as literal text, so the
        // hidden session never needs (or gets) access to the TODO store itself.
        const todoMentions = matchTodoMentions(person, d.todos.listOpen(), d.todos.listDone())
        return d.manager.start({ type: 'prep', person, vttPath: null, todoMentions })
      }),

    pickVttFile: () => surface(() => d.pickVttFile())
  }
}

/**
 * The slice's wire contract. `pickVttFile` is deliberately absent: it is Electron-only
 * (native dialog) and is answered by main before anything reaches the core.
 */
export function oneOnOneWireRoutes(h: OneOnOneHandlers): WireRoutes {
  return {
    [Channel.oneOnOneList]: h.list,
    [Channel.oneOnOneStart]: h.start
  }
}
