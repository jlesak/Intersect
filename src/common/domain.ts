/**
 * Cross-process domain model. Shared verbatim between the main process (SQLite rows),
 * the preload bridge, and the renderer stores/components. No behavior lives here - only
 * the shapes both sides must agree on.
 */

export const PRESETS = ['shell', 'claude'] as const
export type Preset = (typeof PRESETS)[number]

/** How a preset presents and launches. One entry here is all a new preset needs (plus the union). */
export interface PresetMeta {
  label: string
  badge: string
  description: string
  defaultTitle: string
  /** Typed into the resolved shell once ready; null spawns a plain shell. */
  initialCommand: string | null
}

export const PRESET_META: Record<Preset, PresetMeta> = {
  shell: {
    label: 'Shell',
    badge: 'SH',
    description: 'Your default shell',
    defaultTitle: 'Shell',
    initialCommand: null
  },
  claude: {
    label: 'Claude Code',
    badge: 'AI',
    description: 'claude in this folder',
    defaultTitle: 'Claude',
    initialCommand: 'claude'
  }
}

export const LAYOUTS = ['single', 'columns', 'rows', 'grid'] as const
export type Layout = (typeof LAYOUTS)[number]

/**
 * A workspace is a named reference to a folder on disk. It owns an ordered set of tabs,
 * a split layout, and a pointer to the focused tab. Deleting a workspace is app-state
 * only and never touches the filesystem.
 */
export interface Workspace {
  id: string
  name: string
  folderPath: string
  layout: Layout
  /** The focused tab; intentionally not a DB foreign key - reconciled by the app. */
  activeTabId: string | null
  sortOrder: number
}

/**
 * A tab belongs to a workspace and, when placed, occupies one pane slot of the current
 * layout. `preset` decides how its PTY is launched. `paneSlot` is null when the tab lives
 * only in the tab bar (not shown in a pane under the current layout).
 */
export interface Tab {
  id: string
  workspaceId: string
  title: string
  preset: Preset
  paneSlot: number | null
  sortOrder: number
  /**
   * The Claude Code session UUID this tab resumes on spawn (`claude --resume <id>`), or null for a
   * fresh tab. It is the session id from `~/.claude/projects`, distinct from Intersect's own
   * `${workspaceId}:${tabId}` session id. Persisted, so the resumed conversation survives a restart.
   */
  resumeSessionId: string | null
}

/** Full state needed to hydrate the renderer at boot. */
export interface BootState {
  workspaces: Workspace[]
  selectedWorkspaceId: string | null
}

// ---------------------------------------------------------------------------
// PR Review Inbox (slice 2) - see docs/DESIGN-pr-inbox.md
// ---------------------------------------------------------------------------

/** A reviewer's vote, normalized from Azure DevOps's numeric vote codes. */
export const PR_VOTES = ['approved', 'approvedWithSuggestions', 'noVote', 'waiting', 'rejected'] as const
export type PrVote = (typeof PR_VOTES)[number]

export interface PrReviewer {
  id: string
  displayName: string
  vote: PrVote
  isRequired: boolean
}

/** My relationship to a PR. A PR I both created and review is shown as 'author'. */
export const PR_ROLES = ['author', 'reviewer'] as const
export type PrRole = (typeof PR_ROLES)[number]

/**
 * An active pull request I am involved in, as consolidated from Azure DevOps and cached locally.
 * `createdAt` is epoch ms. `role` records how I relate to it (for the inbox grouping).
 */
export interface PullRequest {
  prId: number
  repositoryId: string
  repositoryName: string
  projectId: string
  title: string
  authorId: string
  authorName: string
  createdAt: number
  status: string
  sourceRefName: string
  targetRefName: string
  /** Source commit id for the diff's modified side (may be empty if the PR payload lacked it). */
  sourceCommitId: string
  /** Target/base commit id for the diff's original side. */
  targetCommitId: string
  url: string
  role: PrRole
  /** My own vote when I am among the reviewers; null otherwise (e.g. a PR I only authored). */
  myVote: PrVote | null
  reviewers: PrReviewer[]
  /**
   * True when the PR's source branch moved past the commit I last voted on - the author pushed
   * new changes since my review. Derived from the review watermark on every read; never persisted.
   */
  newChangesSinceMyReview: boolean
}

/** Which side of the diff a comment anchors to. Publishing supports 'right' only (ADO server). */
export const COMMENT_SIDES = ['left', 'right'] as const
export type CommentSide = (typeof COMMENT_SIDES)[number]

/**
 * Draft lifecycle. `publishing` is the in-flight sentinel claimed atomically before the ADO write
 * so a double-approve cannot post the same comment twice.
 */
export const DRAFT_STATUSES = ['pending', 'approved', 'publishing', 'published', 'discarded'] as const
export type DraftStatus = (typeof DRAFT_STATUSES)[number]

export const DRAFT_SOURCES = ['claude', 'manual'] as const
export type DraftSource = (typeof DRAFT_SOURCES)[number]

/**
 * A review comment that has NOT reached Azure DevOps. Created either by the guardrailed Claude
 * session (via the draft MCP server) or by me manually on the diff. Only an explicitly approved
 * draft is published, under my identity, by Intersect's own code.
 */
export interface DraftComment {
  id: string
  prId: number
  repositoryId: string
  filePath: string
  line: number
  side: CommentSide
  body: string
  status: DraftStatus
  source: DraftSource
  reviewSessionId: string | null
  publishedThreadId: number | null
  createdAt: number
}

/** The fields a caller supplies to create a manual draft; the rest are set by the repo. */
export type NewManualDraft = Pick<
  DraftComment,
  'prId' | 'repositoryId' | 'filePath' | 'line' | 'side' | 'body'
>

export const REVIEW_STATUSES = ['running', 'completed', 'failed', 'cleaned'] as const
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

/** One AI review run bound to a git worktree. At most one is live at a time (non-goal: batch). */
export interface ReviewSession {
  id: string
  prId: number
  repositoryId: string
  repoDir: string
  worktreePath: string
  status: ReviewStatus
  createdAt: number
}

/** A changed file in a PR. */
export interface PrChangeFile {
  path: string
  changeType: 'add' | 'edit' | 'delete' | 'rename'
  originalPath: string | null
}

/** Both sides of one file for the diff editor. `binary`/`tooLarge` render a placeholder instead. */
export interface FileDiff {
  path: string
  original: string
  modified: string
  language: string
  binary: boolean
  tooLarge: boolean
}

/** An existing ADO comment thread (read-only display of prior review activity). */
export interface PrThread {
  threadId: number
  filePath: string | null
  line: number | null
  status: string
  comments: { authorName: string; body: string; publishedAt: number }[]
}

// ---------------------------------------------------------------------------
// Session Search (slice 4) - see docs/superpowers/specs/2026-07-06-session-search-design.md
// ---------------------------------------------------------------------------

/**
 * A lightweight index record for one past Claude Code session (`~/.claude/projects/**\/<id>.jsonl`),
 * parsed once and cached in the main process. Holds everything the list and filters need; the full
 * conversation is fetched on demand as a SessionTranscript. Timestamps are epoch ms.
 */
export interface SessionSummary {
  /** The Claude session UUID (the `.jsonl` filename without extension). */
  id: string
  /** Absolute path to the `.jsonl`, so main can re-open it for the transcript. */
  filePath: string
  /** Working directory the session ran in, read from file content (not the lossy dir name). */
  cwd: string
  /** basename(cwd) - used for display and the folder filter. */
  folderName: string
  /** aiTitle when present, else the first non-meta user prompt, else folderName. */
  title: string
  gitBranch: string | null
  firstTimestamp: number
  /** Last activity - the key both the date filter and default sort use. */
  lastTimestamp: number
  durationMs: number
  /** Count of user + assistant messages. */
  messageCount: number
  /** Every user prompt (command wrappers stripped) - the searchable text alongside the title. */
  userPrompts: string[]
}

/** One rendered turn of a transcript. `text` is markdown; `tools` are one-line call summaries. */
export interface TranscriptEntry {
  role: 'user' | 'assistant'
  text: string
  timestamp: number
  tools: string[]
}

/** The full, on-demand transcript of a session for the read-only viewer. */
export interface SessionTranscript {
  id: string
  title: string
  cwd: string
  entries: TranscriptEntry[]
}

// ---------------------------------------------------------------------------
// My Work (slice 5) - see docs/superpowers/specs/2026-07-06-my-work-design.md
// ---------------------------------------------------------------------------

/**
 * The My Work Jira board's columns, in display order. There is no Done column: the board only
 * shows unresolved issues, which can never sit in Done.
 */
export const JIRA_COLUMNS = ['todo', 'progress', 'waiting', 'review', 'test'] as const
export type JiraColumn = (typeof JIRA_COLUMNS)[number]

/** The priority bucket shown on a card; null when Jira reports no (or an unknown) priority. */
export const JIRA_PRIORITIES = ['high', 'medium', 'low'] as const
export type JiraPriority = (typeof JIRA_PRIORITIES)[number]

/**
 * One unresolved Jira issue assigned to me, as shown on the My Work board. Normalized in the main
 * process from the raw Jira fields; `updatedAt` (last activity, epoch ms) is the within-column
 * sort key. `url` is the canonical browse link opened in the system browser on card click.
 */
export interface JiraIssue {
  key: string
  url: string
  summary: string
  column: JiraColumn
  priority: JiraPriority | null
  updatedAt: number
}

/** Why a board fetch failed: a missing/expired SSO browser session vs. anything else. */
export const JIRA_ERROR_KINDS = ['auth', 'other'] as const
export type JiraErrorKind = (typeof JIRA_ERROR_KINDS)[number]

/**
 * The outcome of one board fetch. A failure is data rather than a thrown error because the
 * renderer presents the auth-expired case differently from a generic failure, and only an Error's
 * `.message` would survive the IPC boundary.
 */
export type JiraBoardResult =
  | { ok: true; issues: JiraIssue[]; fetchedAt: number }
  | { ok: false; kind: JiraErrorKind; message: string }

/**
 * The outcome of one interactive Jira SSO login (a headed browser window the user completes).
 * Failure means the user closed the window, the login timed out, or the jira skill is missing.
 */
export type JiraLoginResult = { ok: true } | { ok: false; message: string }
