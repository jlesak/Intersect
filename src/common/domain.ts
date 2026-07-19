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
  /**
   * How `projectId` was assigned: 'auto' means inferred from the folder path and re-resolved
   * whenever project bindings change; 'manual' means the user placed it and inference never
   * touches it again until the user switches it back to automatic.
   */
  projectSource: ProjectAssignmentSource
}

/** How a workspace's project assignment came to be; manual placement always wins over inference. */
export const PROJECT_ASSIGNMENT_SOURCES = ['auto', 'manual'] as const
export type ProjectAssignmentSource = (typeof PROJECT_ASSIGNMENT_SOURCES)[number]

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

/** External content kinds that can carry a manual project-assignment override. */
export const PROJECT_OVERRIDE_KINDS = ['pr', 'jira'] as const
export type ProjectOverrideKind = (typeof PROJECT_OVERRIDE_KINDS)[number]

/**
 * A durable manual assignment of one external item (a PR or a Jira issue) to a project. It always
 * wins over binding-based inference; deleting the target project drops the override so the item
 * falls back to inference. `projectId` null pins the item to the virtual Other bucket. `key` is
 * the item's stable external identity: `${repositoryId}:${prId}` for PRs, the issue key for Jira.
 */
export interface ProjectOverride {
  kind: ProjectOverrideKind
  key: string
  projectId: string | null
}

/** One git worktree discovered under a project's repository binding. */
export interface WorktreeInfo {
  path: string
  /** Checked-out branch ref short name, or null for a detached HEAD. */
  branch: string | null
  head: string
}

/**
 * The worktrees of one repository binding of a project. A binding whose folder is not a usable
 * git repository reports an error instead of failing the whole listing.
 */
export interface RepoWorktrees {
  repoPath: string
  worktrees: WorktreeInfo[]
  error: string | null
}

// ---------------------------------------------------------------------------
// Work items - see docs/2026-07-07-intersect-final-form-design.md §9.8
// ---------------------------------------------------------------------------

/**
 * Where a work item lives. The discriminator is deliberately open-ended: a future adapter adds
 * its value here (plus its state/search rules) without changing the ref's shape.
 */
export const WORK_ITEM_SOURCES = ['jira', 'todo', 'ado-pr'] as const
export type WorkItemSource = (typeof WORK_ITEM_SOURCES)[number]

/**
 * The display identity of a work item, captured at assignment time and kept verbatim so a
 * session's history stays readable even after the remote item disappears from every sync.
 * `key` is the short label shown on chips (issue key, 'TODO', '!<prId>'); `type` names the
 * item kind in the source's own vocabulary ('issue', 'task', 'pull-request').
 */
export interface WorkItemSnapshot {
  key: string
  title: string
  type: string
}

/**
 * How the ref's referent looks right now, computed on every read and never stored: 'linked'
 * means the item still resolves in its source's cache; 'stale' means the source last reported
 * it gone but the evidence is weak (an absent-flagged Jira row, a PR aged out of the
 * replace-on-sync cache); 'missing' means the item is positively gone (a hard-deleted TODO,
 * a Jira issue no cache knows). Neither state ever deletes the ref or its history.
 */
export const WORK_ITEM_STATES = ['linked', 'stale', 'missing'] as const
export type WorkItemState = (typeof WORK_ITEM_STATES)[number]

/**
 * The one durable primary work item of a session (= a workspace tab): a polymorphic link to a
 * Jira issue, TODO task, or ADO pull request. `externalKey` is the item's stable identity in
 * its source (issue key / task id / `${repositoryId}:${prId}`); `projectId` is the project the
 * item belonged to when assigned (null = Other). The user may rename the tab freely - the ref
 * never depends on the title.
 */
export interface WorkItemRef {
  tabId: string
  source: WorkItemSource
  externalKey: string
  projectId: string | null
  snapshot: WorkItemSnapshot
  state: WorkItemState
  assignedAt: number
}

/** The fields a caller supplies to assign a primary work item; the rest are set on write. */
export type NewWorkItemRef = Pick<WorkItemRef, 'source' | 'externalKey' | 'projectId' | 'snapshot'>

/** What happened to a session's primary ref; every mutation appends exactly one event. */
export const WORK_ITEM_REF_ACTIONS = ['assign', 'change', 'clear'] as const
export type WorkItemRefAction = (typeof WORK_ITEM_REF_ACTIONS)[number]

/**
 * One audit entry of a session's primary-ref history. Events carry the identity and display
 * snapshot of the ref they recorded (the cleared ref for 'clear'), and deliberately have no
 * foreign key to tabs: history outlives the session it describes.
 */
export interface WorkItemRefEvent {
  id: number
  tabId: string
  action: WorkItemRefAction
  source: WorkItemSource | null
  externalKey: string | null
  snapshotKey: string | null
  snapshotTitle: string | null
  at: number
}

/**
 * One source's slice of a picker search: ready-to-assign refs, ranked with the current
 * workspace's project first. Grouping is by source so the picker renders labeled sections
 * without re-deriving anything.
 */
export interface WorkItemCandidateGroup {
  source: WorkItemSource
  candidates: NewWorkItemRef[]
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
 * One Jira issue as held in the read-model cache, fetched directly (read-only) from Jira. Extends
 * the board card shape with the raw remote fields, so the same record serves the kanban board,
 * project association, and durable session <-> ticket links. `updatedAt` (inherited) is Jira's
 * remote `updated` timestamp; `column` is the normalized bucket derived from `rawStatus` by
 * keyword matching, with unrecognized statuses falling back safely to To Do while `rawStatus`
 * keeps the exact remote name.
 */
export interface JiraIssueSnapshot extends JiraIssue {
  /** The remote description, trimmed; null when Jira reports none. */
  description: string | null
  /** The exact Jira workflow status name, preserved verbatim next to the normalized column. */
  rawStatus: string
  /** The exact Jira priority name; null when the issue has none. */
  rawPriority: string | null
  /** The assignee's display name; null when unassigned. */
  assignee: string | null
  /** The linked epic's issue key; null when the issue has no epic link. */
  epicKey: string | null
  /** The linked epic's summary; null when unknown (the enrichment lookup is best-effort). */
  epicSummary: string | null
  /** Jira's original time estimate in seconds; null when unestimated. */
  estimateSeconds: number | null
  /** The issue's component names, in Jira's order. */
  components: string[]
  /** When this issue was last seen in a fetch (epoch ms). */
  fetchedAt: number
  /**
   * True when the issue was missing from the latest fetch of its source. Absent issues are
   * marked, never deleted, so anything linked to the cached row keeps resolving.
   */
  absent: boolean
}

/**
 * Why a Jira source cannot serve fresh data: no query configured, an expired SSO session, the
 * network, the server, or anything else. Each renders differently, and only auth offers login.
 */
export const JIRA_SYNC_ERROR_KINDS = ['not-configured', 'auth', 'network', 'server', 'other'] as const
export type JiraSyncErrorKind = (typeof JIRA_SYNC_ERROR_KINDS)[number]

export interface JiraSyncError {
  kind: JiraSyncErrorKind
  message: string
}

/**
 * One Jira source's cached board plus its sync state, as served to the renderer. A failed sync
 * never clears the issues: the last-good board stays alongside the error so the UI keeps
 * rendering data while surfacing what went wrong. `fetchedAt` is the last successful fetch
 * (epoch ms); null means this source never fetched successfully. `partial` flags a result cut
 * short by the pagination ceiling.
 */
export interface JiraBoardSnapshot {
  sourceKey: string
  issues: JiraIssueSnapshot[]
  fetchedAt: number | null
  partial: boolean
  error: JiraSyncError | null
}

/** The source key of the global "assigned to me" board. */
export const GLOBAL_JIRA_SOURCE = 'global'

/** The source key of one project's own Jira board (its JQL filter or board URL). */
export function projectJiraSource(projectId: string): string {
  return `project:${projectId}`
}

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

// ---------------------------------------------------------------------------
// Agent Tooling - read-only browser of the effective Claude Code configuration,
// skills, and agents (global scope or one bound Project).
// ---------------------------------------------------------------------------

/**
 * Which tooling surface Agent Tooling browses. The adapter dimension exists so the same shell
 * can host non-Claude agent CLIs later; today Claude Code is the only value.
 */
export const AGENT_ADAPTERS = ['claude-code'] as const
export type AgentAdapter = (typeof AGENT_ADAPTERS)[number]

/**
 * The scope a browse request resolves against: the user-global Claude configuration, or one
 * bound Project (whose repository roots gate every project-level file access).
 */
export type AgentToolingScope = { kind: 'global' } | { kind: 'project'; projectId: string }

/**
 * Where an effective value came from, so the UI can label provenance on every row:
 *   - `global`        - `~/.claude/settings.json`
 *   - `global-local`  - `~/.claude/settings.local.json` (global scope only)
 *   - `project`       - `<repo>/.claude/settings.json`
 *   - `project-local` - `<repo>/.claude/settings.local.json`
 *   - `mcp-file`      - `<repo>/.mcp.json`
 *   - `default`       - no file provided it; Intersect's built-in fallback
 */
export type ConfigSource =
  | 'global'
  | 'global-local'
  | 'project'
  | 'project-local'
  | 'mcp-file'
  | 'default'

/** One settings layer's on-disk status, so the Overview can show what exists and what is broken. */
export interface ConfigFileState {
  source: ConfigSource
  /** The absolute path the layer resolves to (even when it does not exist). */
  path: string
  exists: boolean
  /**
   * A per-file diagnostic that degrades this layer alone: a JSON parse failure, or a containment
   * block when the path escapes its Project root. Null when the layer read cleanly (or is simply
   * absent). Other layers still resolve regardless.
   */
  error: string | null
}

/** One effective permission rule (an entry of the `permissions` allow/deny/ask lists). */
export interface PermissionEntry {
  list: 'allow' | 'deny' | 'ask'
  rule: string
  source: ConfigSource
}

/** One effective hook: a single command bound to a lifecycle event, with its optional matcher. */
export interface HookEntry {
  event: string
  matcher: string | null
  type: string
  command: string
  source: ConfigSource
}

/** One effective MCP server, summarized to its transport detail (command line or URL). */
export interface McpServerEntry {
  name: string
  /** `stdio`, `http`, `sse`, or whatever `type` the server declares (best-effort). */
  transport: string
  /** The command+args or the URL, whichever the server config carries. */
  detail: string
  source: ConfigSource
}

/** One effective advanced setting: any top-level key that is not permissions/hooks/mcpServers. */
export interface AdvancedEntry {
  key: string
  /** The value rendered as compact JSON (objects/arrays included). */
  value: string
  source: ConfigSource
}

/**
 * The fully resolved, read-only view of the effective Claude Code configuration for one scope,
 * with every leaf carrying its provenance. Malformed layers surface as per-file diagnostics in
 * `files` rather than failing the whole result.
 */
export interface EffectiveConfig {
  scope: AgentToolingScope
  adapter: AgentAdapter
  files: ConfigFileState[]
  permissions: PermissionEntry[]
  hooks: HookEntry[]
  mcpServers: McpServerEntry[]
  advanced: AdvancedEntry[]
}

/** Where a catalog item is owned, and how the UI must treat it (plugin items are read-only). */
export interface CatalogSource {
  kind: 'user' | 'project' | 'plugin'
  /** `User`, the Project name/label, or the plugin id (e.g. `superpowers@official`). */
  label: string
}

/** One discovered skill (`SKILL.md` in a `skills/<name>/` directory). */
export interface SkillCatalogItem {
  name: string
  source: CatalogSource
  /** Absolute path of the `SKILL.md` file (already containment-validated by the core). */
  path: string
  description: string
  /** True for plugin-managed items: external, read-only, never editable by Intersect. */
  external: boolean
}

/** One discovered agent (a flat `<name>.md` in an `agents/` directory). */
export interface AgentCatalogItem {
  name: string
  source: CatalogSource
  /** Absolute path of the agent `.md` file (already containment-validated by the core). */
  path: string
  description: string
  model: string
  tools: string
  external: boolean
}

// ---------------------------------------------------------------------------
// Agent Tooling - guarded mutation of the effective Claude Code configuration
// (preview, atomic save, one-shot undo). Every write is described as a
// structured edit against exactly one target file; the core applies it, so the
// edit logic and its validation live in one place behind the IPC boundary.
// ---------------------------------------------------------------------------

/**
 * A single structured change to one config file. The `raw` variant replaces the whole file with
 * user-supplied text (the guarded raw editor); every other variant names one slice to add, set,
 * or remove while every unknown key and sibling entry is preserved. The core turns the descriptor
 * into proposed content, so the renderer never has to reason about JSON preservation.
 */
export type ConfigEdit =
  | { kind: 'raw'; content: string }
  | { kind: 'permission'; op: 'add' | 'remove'; list: 'allow' | 'deny' | 'ask'; rule: string }
  | {
      kind: 'hook'
      op: 'add' | 'remove'
      event: string
      matcher: string | null
      hookType: string
      command: string
    }
  /** `server` is the server body as a JSON string (an object such as `{"command":"npx",...}`). */
  | { kind: 'mcp'; op: 'set' | 'remove'; name: string; server: string }
  /** `value` is the setting value as a JSON string (`"opus"`, `true`, `{"a":1}`, ...). */
  | { kind: 'advanced'; op: 'set' | 'remove'; key: string; value: string }

/** The renderer's request to preview or commit a mutation of one config file. */
export interface ConfigEditRequest {
  scope: AgentToolingScope
  source: ConfigSource
  edit: ConfigEdit
}

/** A commit request additionally carries the revision the preview was computed against. */
export interface ConfigSaveRequest extends ConfigEditRequest {
  /** The revision token the user reviewed; a mismatch on disk aborts the save. */
  revision: string
}

/**
 * The result of previewing a mutation: the exact bytes that would be replaced and written (both
 * pretty-printed), the revision guard the commit must echo, and any validation errors. Never
 * mutates or creates anything - a missing target still previews (as a create).
 */
export interface ConfigPreview {
  scope: AgentToolingScope
  source: ConfigSource
  /** The absolute target path the write would land on. */
  path: string
  /** A human one-line provenance: which scope and file this writes. */
  provenance: string
  /** Whether the target file exists today (false means the save would create it). */
  exists: boolean
  /** True for a global-scoped target (`~/.claude/...`), so the UI can demand stronger confirmation. */
  global: boolean
  currentContent: string
  proposedContent: string
  /** sha256 of the current on-disk bytes (a stable sentinel when the file is absent). */
  revision: string
  valid: boolean
  errors: string[]
}

/** The read-back of one target file for the raw editor: its current text and revision guard. */
export interface RawTargetView {
  scope: AgentToolingScope
  source: ConfigSource
  path: string
  exists: boolean
  global: boolean
  content: string
  revision: string
}

/** Why a save or undo was refused, so the UI can tailor its guidance. */
export type ConfigWriteFailure = 'invalid' | 'changed-externally' | 'blocked' | 'io'

/** The outcome of a commit: the backup path and new revision on success, a typed reason otherwise. */
export interface ConfigSaveResult {
  ok: boolean
  /** The absolute target path, so a successful save can be offered a one-shot Undo keyed on it. */
  path: string
  error?: string
  reason?: ConfigWriteFailure
  /** The timestamped backup of the prior bytes (absent when the target did not exist before). */
  backupPath?: string
  newRevision?: string
}

/** Why an undo was refused. */
export type ConfigUndoFailure = 'no-handle' | 'changed-since-save' | 'blocked' | 'io'

/** The outcome of a one-shot undo: it restores the exact prior bytes, or explains why it cannot. */
export interface ConfigUndoResult {
  ok: boolean
  error?: string
  reason?: ConfigUndoFailure
  restoredRevision?: string
}
