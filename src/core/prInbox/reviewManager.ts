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
  sendData: (sessionId: string, data: string) => void
  sendExit: (sessionId: string, exitCode: number) => void
  onDraft: (draft: DraftComment) => void
  /** Read when each review starts so Settings changes apply without restarting Intersect. */
  reviewPrompt: () => string
  /** Likewise for the model the review runs on (`claude --model`). */
  reviewModel: () => string
  /** Absolute path to the built draft MCP server (out/main/draftServer.js). */
  draftServerPath: string
  /** Test seam; production uses node:net createServer. */
  createSocketServer?: typeof createServer
}

interface Live {
  session: ReviewSession
  proc: PtyProcess
  socketServer: NetServer
  socketPath: string
  mcpConfigPath: string
}

/**
 * How many reviews may run at once. Each one is a full worktree checkout, a login shell running
 * Claude Code, and a node MCP child, so this is a real resource ceiling and not a UI preference -
 * and reviews are routinely left running rather than formally ended. Enforced here rather than by
 * a disabled button, because the renderer's picture of what is live can be stale (a window reload
 * resets the store while main keeps every PTY).
 */
export const MAX_CONCURRENT_REVIEWS = 3

export interface ReviewManager {
  /**
   * Start a review of `pr`. A pull request already under a live review is not started twice: its
   * running session is returned instead, so the caller lands back on the terminal it left.
   */
  start(pr: PullRequest, contextMarkdown: string, cols: number, rows: number): Promise<ReviewSession>
  /** Every live session, so a freshly loaded renderer can rebind to what is already running. */
  listLive(): ReviewSession[]
  input(sessionId: string, data: string): void
  resize(sessionId: string, cols: number, rows: number): void
  end(sessionId: string): Promise<void>
  /** Synchronous, DB-free teardown for app quit (the DB is about to close). */
  shutdown(): void
  /** On boot, reclaim any worktrees a previous run left behind. */
  pruneOnBoot(): Promise<void>
}

const prKeyOf = (pr: { repositoryId: string; prId: number }): string =>
  `${pr.repositoryId}:${pr.prId}`

export function createReviewManager(d: ReviewManagerDeps): ReviewManager {
  const live = new Map<string, Live>()
  // Synchronous guard, one entry per pull request: JS interleaves at every await, so a DB or map
  // check alone cannot prevent two concurrent start() calls for one PR from both getting through
  // before either commits its row.
  const starting = new Set<string>()
  // Set on app quit so the async PTY-exit handler does not touch the DB after it is closed.
  let disposed = false
  // The boot sweep. It deletes every directory under the managed worktree root, so a review must
  // never be created while it is still running - the sweep would delete that review's worktree.
  let pruning: Promise<void> | null = null

  const liveForPr = (key: string): Live | undefined => {
    for (const current of live.values()) {
      if (prKeyOf(current.session) === key) return current
    }
    return undefined
  }

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
      const key = prKeyOf(pr)
      const already = liveForPr(key)
      if (already) return already.session
      if (starting.has(key)) {
        throw new Error(`A review of pull request ${pr.prId} is already starting.`)
      }
      // Starts in flight count too. A start reaches `live` only after resolving the clone, waiting
      // for the boot sweep and creating a worktree - a git fetch, so seconds at least - and two
      // clicks inside that window would otherwise both pass a check that counts only what has
      // already landed.
      if (live.size + starting.size >= MAX_CONCURRENT_REVIEWS) {
        throw new Error(
          `${MAX_CONCURRENT_REVIEWS} reviews are already running. End one before starting another.`
        )
      }
      starting.add(key)

      let repoDir: string | null = null
      let worktreePath: string | null = null
      let session: ReviewSession | null = null
      let socketServer: NetServer | null = null
      let socketPath: string | null = null
      try {
        // Inside the try, so a clone that cannot be resolved releases this pull request's claim
        // instead of leaving it permanently unstartable.
        repoDir = await d.worktrees.resolveRepoDir(pr.repositoryName, d.workspaceFolders())
        // The boot sweep must be finished before this review's worktree exists.
        await pruning?.catch(() => {})
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
          reviewSessionId: session.id,
          sourceCommitId: pr.sourceCommitId
        }
        const sid = session.id
        socketServer = (d.createSocketServer ?? createServer)((conn) => {
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
          worktreePath,
          mcpConfigPath,
          prompt: d.reviewPrompt(),
          model: d.reviewModel()
        })
        const proc = d.spawn({
          file: spec.file,
          args: spec.args,
          cwd: spec.cwd,
          cols,
          rows,
          env: spec.env
        })

        const current: Live = { session, proc, socketServer, socketPath, mcpConfigPath }
        live.set(sid, current)

        let initialWritten = false
        proc.onData((data) => {
          d.sendData(sid, data)
          if (!initialWritten) {
            initialWritten = true
            proc.write(`${spec.initialCommand}\r`)
          }
        })
        proc.onExit(({ exitCode }) => {
          if (!disposed) d.reviewSessions.setStatus(sid, exitCode === 0 ? 'completed' : 'failed')
          void cleanup(current)
          if (live.get(sid) === current) live.delete(sid)
          d.sendExit(sid, exitCode)
        })

        return session
      } catch (err) {
        // Roll back this review's partial start so a transient failure cannot wedge the feature (an
        // orphaned 'running' row would keep the PR looking busy forever). Only this session's own
        // state is touched; every other live review keeps running.
        socketServer?.close()
        if (socketPath) await rm(socketPath, { force: true }).catch(() => {})
        if (repoDir && worktreePath) {
          await d.worktrees.removeWorktree(repoDir, worktreePath).catch(() => {})
        }
        if (session) {
          live.delete(session.id)
          d.reviewSessions.setStatus(session.id, 'failed')
        }
        throw err
      } finally {
        starting.delete(key)
      }
    },

    listLive() {
      return [...live.values()].map((current) => current.session)
    },

    input(sessionId, data) {
      // An unknown id is a no-op, never a fallback to "the current session": input typed into the
      // wrong Claude session is the worst failure this feature can have.
      live.get(sessionId)?.proc.write(data)
    },

    resize(sessionId, cols, rows) {
      live.get(sessionId)?.proc.resize(cols, rows)
    },

    async end(sessionId) {
      // Killing triggers onExit, which sets status + cleans up the worktree/socket/config.
      live.get(sessionId)?.proc.kill()
    },

    shutdown() {
      // App is quitting and the DB is about to close: kill every PTY and close every socket WITHOUT
      // any DB write. The leftover worktrees are reclaimed by pruneOnBoot on the next launch.
      disposed = true
      const current = [...live.values()]
      live.clear()
      for (const one of current) {
        try {
          one.socketServer.close()
        } catch {
          /* ignore */
        }
        try {
          one.proc.kill()
        } catch {
          /* ignore */
        }
      }
    },

    async pruneOnBoot() {
      const sweep = (async () => {
        // A crash can leave several rows 'running'; none of them survives a restart.
        for (const active of d.reviewSessions.listActive()) {
          d.reviewSessions.setStatus(active.id, 'cleaned')
        }
        const repoDirs = new Set<string>(d.workspaceFolders())
        await d.worktrees.pruneStale([...repoDirs])
      })()
      pruning = sweep
      try {
        await sweep
      } finally {
        if (pruning === sweep) pruning = null
      }
    }
  }
}
