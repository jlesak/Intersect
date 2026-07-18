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
  /** The project this terminal context belongs to; null means the virtual "Other" bucket. */
  projectId: string | null
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
// Projects (F1) - see docs/2026-07-07-intersect-final-form-design.md §3.2
// ---------------------------------------------------------------------------

/**
 * The umbrella entity binding repositories and external tools into one durable work context.
 * A project owns one or more repository-folder bindings (`repoPaths`, canonical absolute paths
 * in binding order - the first is the original/primary folder) plus optional Jira, Azure DevOps
 * and Toggl bindings. Sessions, PRs, issues and time attach to a project automatically through
 * these bindings; anything unmatched falls into a virtual "Other" bucket that is never persisted
 * as a project. Deleting or archiving a project is app-state only and never touches the
 * filesystem or any remote resource.
 */
export interface Project {
  id: string
  name: string
  sortOrder: number
  archived: boolean
  /** Canonical absolute repository folders bound to this project, in binding order (never empty). */
  repoPaths: string[]
  /** Jira JQL filter selecting this project's issues (e.g. `project = FID2507`), or null. */
  jiraJql: string | null
  /** Jira board URL opened from the project context, or null. */
  jiraBoardUrl: string | null
  /** Azure DevOps repository names whose PRs belong to this project. */
  adoRepositories: string[]
  /** Toggl project id time is booked against, or null. */
  togglProjectId: number | null
}

/** The bindings and fields editable on an existing project; an omitted field is left unchanged. */
export interface ProjectPatch {
  name?: string
  jiraJql?: string | null
  jiraBoardUrl?: string | null
  adoRepositories?: string[]
  togglProjectId?: number | null
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
  /**
   * The id of my own reviewer entry on this PR, so a vote cast from Intersect can address the
   * reviewer resource directly. Null when I am not among the reviewers (e.g. a PR I only authored)
   * or my entry carries no id.
   */
  myReviewerId: string | null
  reviewers: PrReviewer[]
  /**
   * True when the PR's source branch moved past the commit I last voted on - the author pushed
   * new changes since my review. Derived from the review watermark on every read; never persisted.
   */
  newChangesSinceMyReview: boolean
  /**
   * Unresolved, non-system comment threads counted at the last sync. Drives the author-side
   * "needs my action" board signal; 0 when the thread fetch for this PR failed.
   */
  activeThreadCount: number
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
 * A review comment that has NOT reached Azure DevOps. Created either by the interactive Claude
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

/** A comment written by me in the app and published to ADO immediately (no draft step). */
export interface NewPrComment {
  repositoryId: string
  prId: number
  /** Null anchors the comment to the PR itself instead of a file line. */
  filePath: string | null
  line: number | null
  body: string
}

/** An existing ADO comment thread (prior review activity, replies and resolution included). */
export interface PrThread {
  threadId: number
  filePath: string | null
  line: number | null
  status: string
  /** True for ADO housekeeping threads (vote changes, policy updates); hidden from every view. */
  isSystem: boolean
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

// ---------------------------------------------------------------------------
// Time Tracking - see docs/superpowers/specs/2026-07-06-time-tracking-design.md
// ---------------------------------------------------------------------------

/** Where a worklog entry comes from: derived from a Claude Code session, or typed in by hand. */
export const TIME_ENTRY_SOURCES = ['auto', 'manual'] as const
export type TimeEntrySource = (typeof TIME_ENTRY_SOURCES)[number]

/**
 * One card on the weekly worklog board. An auto entry is derived from a past Claude Code session
 * (its id IS the session id) with any user edits applied on top; a manual entry is a standalone
 * worklog the user typed in. `day` is the local calendar day in `yyyy-mm-dd` form; `issueKey` is
 * the Jira issue the time belongs to, or null for unattributed time (e.g. a meeting).
 */
export interface TimeEntry {
  id: string
  source: TimeEntrySource
  day: string
  description: string
  issueKey: string | null
  durationMs: number
}

/** The fields a caller supplies to create a manual worklog entry; the id is set by the repo. */
export type NewManualTimeEntry = Pick<TimeEntry, 'day' | 'description' | 'issueKey' | 'durationMs'>

/** The two fields editable in place on any card, auto or manual. */
export type TimeEntryUpdate = Pick<TimeEntry, 'issueKey' | 'durationMs'>

// ---------------------------------------------------------------------------
// TODO list - see docs/superpowers/specs/2026-07-06-todo-list-design.md
// ---------------------------------------------------------------------------

/** Legacy persisted priority. Kept only so priority-era rows can round-trip without data loss. */
export type TodoPriority = 1 | 2 | 3 | 4

/**
 * One task on the personal TODO list - a lightweight note-to-self with no tie to workspaces or
 * Jira. `dueDay` is the optional local calendar day (`yyyy-mm-dd`) the task is due; `sortOrder`
 * is its persisted manual position in the open list. `priority` is compatibility-only and never
 * affects approved behavior. A non-null `doneAt` (epoch ms) means the task is done and orders the
 * Done section, most recently completed first.
 */
export interface TodoTask {
  id: string
  text: string
  description: string
  dueDay: string | null
  priority: TodoPriority
  sortOrder: number
  doneAt: number | null
}

/** The fields editable in place via inline edit; an omitted field is left unchanged. */
export interface TodoTaskPatch {
  text?: string
  description?: string
  dueDay?: string | null
}

/** Both TODO lists fetched together, so a single call hydrates the whole section. */
export interface TodoLists {
  /** Open tasks in persisted manual order. */
  open: TodoTask[]
  /** Done tasks, most recently completed first. */
  done: TodoTask[]
}

// ---------------------------------------------------------------------------
// 1:1 workflows - see docs/superpowers/specs/2026-07-06-one-on-one-workflows-design.md
// ---------------------------------------------------------------------------

/**
 * The two runnable 1:1 workflows: `process` turns a VTT recording into a Notion note plus a Slack
 * summary (via the user's 1to1 skill), `prep` produces an in-app markdown briefing for an
 * upcoming 1:1.
 */
export const OTO_RUN_TYPES = ['process', 'prep'] as const
export type OtoRunType = (typeof OTO_RUN_TYPES)[number]

/** A run's lifecycle. `running` means the hidden Claude Code session is still working. */
export const OTO_RUN_STATUSES = ['running', 'done', 'failed'] as const
export type OtoRunStatus = (typeof OTO_RUN_STATUSES)[number]

/**
 * One 1:1 workflow run, persisted so the run history survives app restarts. The result fields are
 * per type: a done `process` run carries the Notion page URL and the Slack draft outcome; a done
 * `prep` run carries the briefing as markdown. `error` is set only on a failed run. Timestamps
 * are epoch ms; `finishedAt` is null while the run is still going.
 */
export interface OtoRun {
  id: string
  type: OtoRunType
  /** Free-text person name typed into the form (no persistent people list by design). */
  person: string
  /** Absolute path of the VTT recording; null for `prep` runs. */
  vttPath: string | null
  status: OtoRunStatus
  /** URL of the Notion page the 1to1 skill updated; null until a `process` run is done. */
  notionUrl: string | null
  /** Whether the 1to1 skill created the Slack summary draft (false also while running/for prep). */
  slackDraftCreated: boolean
  /** Slack link to the created draft's conversation, when the skill reported one. */
  slackChannelLink: string | null
  /** The `prep` briefing rendered in-app as markdown; null until a `prep` run is done. */
  resultMarkdown: string | null
  error: string | null
  createdAt: number
  finishedAt: number | null
}

/** The fields the form supplies to start a run; `vttPath` is required only for `process`. */
export interface OtoStartInput {
  type: OtoRunType
  person: string
  vttPath?: string | null
}

// ---------------------------------------------------------------------------
// Settings - see docs/superpowers/specs/2026-07-06-settings-design.md
// ---------------------------------------------------------------------------

/**
 * Which session-status changes raise a native OS notification. `enabled` is the master switch:
 * when off, no notification fires regardless of the per-status toggles. `sound` picks whether the
 * notification plays the OS sound. The per-status defaults mirror the pre-settings behavior:
 * waiting/done alert (they need the user), working is informational and stays quiet.
 */
export interface NotificationSettings {
  enabled: boolean
  working: boolean
  waiting: boolean
  done: boolean
  sound: boolean
}

/**
 * The Azure DevOps connection as configured in the UI. When saved, it takes precedence over the
 * `~/.claude.json` MCP entry / `AZURE_DEVOPS_*` env resolution; those remain the fallback.
 */
export interface AdoSettings {
  orgUrl: string
  project: string
  repository: string
  pat: string
}

/**
 * The live Azure DevOps fallback (`~/.claude.json` / `AZURE_DEVOPS_*` env) shown to the user as
 * hints while the matching saved field is blank. The PAT itself is never sent to the renderer;
 * `hasPat` only says whether the fallback supplies one, so the form can hint that a token is
 * inherited without exposing it.
 */
export interface AdoFallback {
  orgUrl: string
  project: string
  hasPat: boolean
}

export interface AppearanceSettings {
  /** Font size (px) of every xterm terminal; applied to live instances immediately. */
  terminalFontSize: number
}

/**
 * The initial user prompt sent to the interactive PR-review session. Kept in the shared domain so
 * the main process and the Settings reset action always use exactly the same text.
 */
export const DEFAULT_PR_REVIEW_PROMPT =
  'Zrecenzuj pull request, jehož změny jsou checkoutnuté v tomto worktree. Postupuj podle ' +
  'REVIEW_GUIDE.md. V REVIEW_CONTEXT.md je shrnutí a seznam změněných souborů; projdi diffy a ' +
  'každý komentář zaznamenej nástrojem record_draft_comment (jedno volání na jeden komentář, ' +
  'česky). Nic nepublikuj.'

export interface ReviewSettings {
  /** Preserved verbatim: users may replace the prompt with any language, whitespace, or content. */
  prompt: string
}

/** All user settings fetched together, so a single call hydrates the whole section. */
export interface AppSettings {
  notifications: NotificationSettings
  /** Only what the user actually entered; a blank field defers to `adoFallback` at resolve time. */
  ado: AdoSettings
  adoFallback: AdoFallback
  appearance: AppearanceSettings
  review: ReviewSettings
}

/** Bounds the terminal font-size slider offers; main clamps saved values to the same range. */
export const TERMINAL_FONT_SIZE_MIN = 10
export const TERMINAL_FONT_SIZE_MAX = 20

/**
 * Outcome of an Azure DevOps test-connection request. A failure is a value (not a thrown error)
 * because a rejected PAT is an expected answer the form renders inline, not an app fault.
 */
export type AdoConnectionResult =
  | { ok: true; displayName: string }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Claude usage - sidebar panel showing Claude Code's own rate-limit usage
// ---------------------------------------------------------------------------

/** One rate-limit window's usage, as reported by Claude Code's own statusline JSON. */
export interface ClaudeUsageWindow {
  /** 0-100 integer percent of the window already used. */
  usedPercent: number
  /** Epoch seconds the window resets at. */
  resetsAt: number
}

/**
 * Claude Code's rate-limit usage for the signed-in user, captured from the statusline JSON Claude
 * Code feeds the app-managed statusline command on every render. A window is null when the user
 * is not on a Pro/Max subscription (Claude Code's statusline omits `rate_limits` entirely) or no
 * snapshot has been captured yet. `capturedAt` is the local epoch-ms time the snapshot was
 * written, for the sidebar's "as of HH:mm" staleness hint.
 */
export interface ClaudeUsage {
  fiveHour: ClaudeUsageWindow | null
  sevenDay: ClaudeUsageWindow | null
  capturedAt: number
}
