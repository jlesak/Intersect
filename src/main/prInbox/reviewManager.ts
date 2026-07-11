import { randomUUID } from 'node:crypto'
import { createServer, type Server as NetServer } from 'node:net'
import { chmod, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DraftComment, PullRequest, ReviewSession } from '@common/domain'
import type { DraftCommentRepo } from '../db/draftCommentRepo'
import type { PrCacheRepo } from '../db/prCacheRepo'
import type { ReviewSessionRepo } from '../db/reviewSessionRepo'
import type { PtyProcess, SpawnFn } from '../pty/sessionManager'
import { handleDraftMessage, parseDraftPayload, type DraftContext } from './draftMessage'
import { REVIEW_GUIDE } from './reviewGuide'
import { buildReviewSpawnSpec } from './reviewSpawn'
import type { WorktreeManager } from './worktreeManager'

export interface ReviewManagerDeps {
  reviewSessions: ReviewSessionRepo
  drafts: DraftCommentRepo
  prCache: PrCacheRepo
  worktrees: WorktreeManager
  /** The clone folders to search for the PR's repo (from the workspaces slice). */
  workspaceFolders: () => string[]
  spawn: SpawnFn
  sendData: (data: string) => void
  sendExit: (exitCode: number) => void
  onDraft: (draft: DraftComment) => void
  claudePath: string
  /** Absolute path to the built draft MCP server (out/main/draftServer.js). */
  draftServerPath: string
}

interface Live {
  session: ReviewSession
  proc: PtyProcess
  socketServer: NetServer
  socketPath: string
  mcpConfigPath: string
}

export interface ReviewManager {
  start(pr: PullRequest, contextMarkdown: string, cols: number, rows: number): Promise<ReviewSession>
  input(data: string): void
  resize(cols: number, rows: number): void
  end(): Promise<void>
  /** Synchronous, DB-free teardown for app quit (the DB is about to close). */
  shutdown(): void
  /** On boot, reclaim any worktrees a previous run left behind. */
  pruneOnBoot(): Promise<void>
}

/** Keys that must never enter the review session's environment (Azure DevOps PAT and any secret). */
const SECRET_ENV = /^AZURE_DEVOPS_|(^|_)(PAT|TOKEN|SECRET|PASSWORD)($|_)/i

function hygienicEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith('ELECTRON_')) continue
    // Strip credentials so a prompt-injected read/leak of the process env yields nothing useful.
    // ANTHROPIC_/CLAUDE_ auth vars are kept so the session can authenticate.
    if (SECRET_ENV.test(k) && !/^(ANTHROPIC|CLAUDE)_/i.test(k)) continue
    env[k] = v
  }
  env.TERM = 'xterm-256color'
  return env
}

const REVIEW_PROMPT =
  'Zrecenzuj pull request, jehož změny jsou checkoutnuté v tomto worktree. Postupuj podle ' +
  'REVIEW_GUIDE.md. V REVIEW_CONTEXT.md je shrnutí a seznam změněných souborů; projdi diffy a ' +
  'každý komentář zaznamenej nástrojem record_draft_comment (jedno volání na jeden komentář, ' +
  'česky). Nic nepublikuj.'

export function createReviewManager(d: ReviewManagerDeps): ReviewManager {
  let live: Live | null = null
  // Synchronous guard: JS interleaves at every await, so the DB getActive() check alone cannot
  // prevent two concurrent start() calls from both passing before either commits its row.
  let starting = false
  // Set on app quit so the async PTY-exit handler does not touch the DB after it is closed.
  let disposed = false

  async function cleanup(current: Live): Promise<void> {
    current.socketServer.close()
    await rm(current.mcpConfigPath, { force: true }).catch(() => {})
    await rm(current.socketPath, { force: true }).catch(() => {})
    await d.worktrees
      .removeWorktree(current.session.repoDir, current.session.worktreePath)
      .catch(() => {})
    if (!disposed) d.reviewSessions.setStatus(current.session.id, 'cleaned')
  }

  return {
    async start(pr, contextMarkdown, cols, rows) {
      if (starting || live || d.reviewSessions.getActive()) {
        throw new Error('A review is already running. Finish it before starting another.')
      }
      starting = true

      const repoDir = await d.worktrees.resolveRepoDir(pr.repositoryName, d.workspaceFolders())
      let worktreePath: string | null = null
      let session: ReviewSession | null = null
      let socketServer: NetServer | null = null
      let socketPath: string | null = null
      try {
        worktreePath = await d.worktrees.createWorktree({
          repoDir,
          dirName: randomUUID(),
          sourceCommit: pr.sourceCommitId,
          sourceRefName: pr.sourceRefName,
          prId: pr.prId
        })

        session = d.reviewSessions.create({
          prId: pr.prId,
          repositoryId: pr.repositoryId,
          repoDir,
          worktreePath
        })

        await writeFile(join(worktreePath, 'REVIEW_CONTEXT.md'), contextMarkdown, 'utf8')
        await writeFile(join(worktreePath, 'REVIEW_GUIDE.md'), REVIEW_GUIDE, 'utf8')

        // Unix socket kept short and in tmp (macOS caps socket paths at ~104 bytes).
        socketPath = join(tmpdir(), `jrv-${session.id.slice(0, 8)}.sock`)
        await rm(socketPath, { force: true }).catch(() => {})
        const ctx: DraftContext = {
          prId: pr.prId,
          repositoryId: pr.repositoryId,
          reviewSessionId: session.id
        }
        const sid = session.id
        socketServer = createServer((conn) => {
          conn.on('error', () => {}) // a peer reset on session kill must not crash main
          let buffer = ''
          conn.on('data', (chunk) => {
            buffer += chunk.toString('utf8')
            let nl: number
            while ((nl = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, nl).trim()
              buffer = buffer.slice(nl + 1)
              if (!line) continue
              try {
                const payload = parseDraftPayload(line)
                if (payload.sessionId !== sid || disposed) continue
                const draft = handleDraftMessage(d.drafts, ctx, payload)
                d.onDraft(draft)
              } catch {
                // Ignore malformed/rejected draft lines; the session keeps running.
              }
            }
          })
        })
        socketServer.on('error', () => {})
        const server = socketServer
        const boundPath = socketPath
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(boundPath, () => {
            server.off('error', reject)
            resolve()
          })
        })
        await chmod(socketPath, 0o600).catch(() => {})

        const mcpConfigPath = join(worktreePath, '.intersect-review-mcp.json')
        const mcpConfig = {
          mcpServers: {
            intersectReview: {
              command: 'node',
              args: [d.draftServerPath],
              env: { INTERSECT_DRAFT_SOCK: socketPath, INTERSECT_REVIEW_SESSION: session.id }
            }
          }
        }
        await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 })

        const spec = buildReviewSpawnSpec({
          claudePath: d.claudePath,
          worktreePath,
          mcpConfigPath,
          prompt: REVIEW_PROMPT
        })
        const proc = d.spawn({
          file: spec.file,
          args: spec.args,
          cwd: spec.cwd,
          cols,
          rows,
          env: hygienicEnv()
        })

        const current: Live = { session, proc, socketServer, socketPath, mcpConfigPath }
        live = current

        proc.onData((data) => d.sendData(data))
        proc.onExit(({ exitCode }) => {
          if (!disposed) d.reviewSessions.setStatus(session!.id, exitCode === 0 ? 'completed' : 'failed')
          void cleanup(current)
          if (live === current) live = null
          d.sendExit(exitCode)
        })

        return session
      } catch (err) {
        // Roll back a partial start so a transient failure cannot wedge the feature (an orphaned
        // 'running' row would make every future start throw "already running").
        socketServer?.close()
        if (socketPath) await rm(socketPath, { force: true }).catch(() => {})
        if (worktreePath) await d.worktrees.removeWorktree(repoDir, worktreePath).catch(() => {})
        if (session) d.reviewSessions.setStatus(session.id, 'failed')
        live = null
        throw err
      } finally {
        starting = false
      }
    },

    input(data) {
      live?.proc.write(data)
    },

    resize(cols, rows) {
      live?.proc.resize(cols, rows)
    },

    async end() {
      if (!live) return
      // Killing triggers onExit, which sets status + cleans up the worktree/socket/config.
      live.proc.kill()
    },

    shutdown() {
      // App is quitting and the DB is about to close: kill the PTY and close the socket WITHOUT
      // any DB write. The leftover worktree is reclaimed by pruneOnBoot on the next launch.
      disposed = true
      const current = live
      live = null
      if (!current) return
      try {
        current.socketServer.close()
      } catch {
        /* ignore */
      }
      try {
        current.proc.kill()
      } catch {
        /* ignore */
      }
    },

    async pruneOnBoot() {
      const active = d.reviewSessions.getActive()
      if (active) d.reviewSessions.setStatus(active.id, 'cleaned')
      const repoDirs = new Set<string>(d.workspaceFolders())
      await d.worktrees.pruneStale([...repoDirs])
    }
  }
}
