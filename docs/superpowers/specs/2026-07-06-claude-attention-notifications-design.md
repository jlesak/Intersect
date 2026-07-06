# Claude Code attention notifications - design

## Goal

When a Claude Code session running in an Intersect terminal tab needs the user's
input (it finished its turn and is waiting, or it is asking for a permission),
Intersect must:

1. Raise a **native macOS notification**. Clicking it brings the app to the
   foreground and navigates to that exact session (workspace + tab).
2. **Color** that tab (and its workspace row in the sidebar, so background
   workspaces are visible too) by its current status - see "Session status
   model" below - until the user views the session.

Non-goals: batching/history of notifications, sound design, Windows/Linux
parity, detecting arbitrary CLI activity (only Claude Code's explicit signals).

## The detection signal (decided)

Intersect launches the `claude` preset with an **injected settings layer** it
owns, without touching the user's own settings files:

```
claude --settings '<userData>/intersect-claude-notif.json'
```

`--settings` sits above `~/.claude/settings.json` in precedence and its hooks run
*alongside* the user's own hooks (they are merged, not replaced - confirmed
against the Claude Code CLI/settings/hooks docs). The injected file defines two
`Notification` hooks that emit distinct, app-private OSC 9 markers via
`terminalSequence`:

| Matcher             | Emitted into the PTY stream          | Meaning                       |
|---------------------|--------------------------------------|-------------------------------|
| `idle_prompt`       | `ESC ] 9 ; INTERSECT_IDLE BEL`       | Turn ended, waiting for input |
| `permission_prompt` | `ESC ] 9 ; INTERSECT_PERMISSION BEL` | Needs a permission decision   |

The hook command needs no `jq` and produces valid JSON:

```
printf '%s' '{"terminalSequence":"]9;INTERSECT_IDLE"}'
```

Detection is then a substring match for the **full OSC 9 sequence**
(`ESC ] 9 ; INTERSECT_IDLE BEL`, not the bare token) in the raw PTY byte stream -
deterministic, independent of the user's `preferredNotifChannel`, and immune to
Claude's own notification text changing. Requiring the escape wrapper means the
token appearing as plain text (grep output, this file's own source) never fires.

## Session status model

A Claude tab shows one of three colors, or none (neutral - a shell tab, or a
Claude tab that hasn't sent its first prompt yet):

| Status | Color | Trigger | Notifies? |
|---|---|---|---|
| `working` | Blue `#5b9dd9`, steady | user submits a prompt (Enter, `\r`) into a claude-preset session's PTY input | no |
| `waiting` | Amber/gold `#f0c53d`, pulsing | `permission_prompt` marker | yes |
| `done` | Green `#5fd68a`, pulsing | `idle_prompt` marker | yes |

`working` is inferred renderer-input-side, not from a hook: main wraps the
terminal `write` IPC handler and, for a session recorded as the `claude` preset,
treats any chunk containing `\r` as "the user submitted a prompt". This is
deliberately **not** driven by PTY *output* activity (Claude's own trailing
redraw bytes after printing a marker would otherwise flip the tab back to
"working" immediately after it reports done/waiting - a flicker). Submitting a
new prompt also drops any stale unacknowledged `waiting`/`done` alert for that
session, since it no longer describes the current state.

`working` is broadcast unconditionally (no suppress/dedup/notify) since it never
raises a native notification and is idempotent on the renderer. `waiting`/`done`
keep the original suppress-when-viewing and dedup-until-acknowledged rules, plus
escalation (a pending `done` is superseded by a `waiting` for the same session).
Viewing a session (`acknowledge`) clears `waiting`/`done` back to neutral but
leaves `working` alone - looking at a tab does not stop Claude from working.

## Architecture

Every byte of every PTY's output already passes through one point in main:
`sessionManager` -> `deps.send.data({ sessionId, data })`. Rather than modify the
session manager, the composition root (`main/index.ts`) **decorates the sender**:
`send.data` also feeds the attention pipeline; `send.exit` clears its per-session
state. No change to `sessionManager.ts`.

```
PTY output ──▶ send.data (decorated in main/index.ts)
                 ├─▶ renderer (unchanged terminal:data)
                 └─▶ sessionNotifier.onChunk(sessionId, data)
                        │  detector.push -> AttentionKind | null
                        │  suppress if (window focused && session is active)
                        │  dedup if already pending (unacknowledged)
                        ├─▶ Notification (main) ──click──▶ focus window
                        │                                  + terminal:notificationClicked
                        └─▶ terminal:needsAttention broadcast
                                   │
                                   ▼
                        renderer attention store (keyed by sessionId)
                        ├─▶ TabBar: .ix-tab--pulse
                        └─▶ WorkspaceList: .ix-ws--pulse
```

### Acknowledgement / clearing

The renderer reports its currently-active session to main
(`terminal:reportActiveSession`, fire-and-forget) whenever the active section,
selected workspace, or active tab changes. The active session is:

```
section === 'workspaces' && selectedWorkspaceId && tabs ready for it
  ? makeSessionId(selectedWorkspaceId, activeTabId)
  : null
```

- Main uses `(windowFocused && sessionId === activeSessionId)` to **suppress**
  both the notification and the pulse for a session the user is already viewing.
- Main keeps a `pending` set for **dedup** (one alert per unacknowledged signal);
  reporting a session as active removes it from `pending`.
- The renderer clears the pulse locally when a session becomes active.

## Components

New (mostly isolated) units:

- `common/ipc.ts`: `AttentionKind`, `TerminalAttentionEvent`; channels
  `terminalReportActive`, `terminalNeedsAttention`, `terminalNotificationClicked`;
  `parseSessionId()`; three additions to `IpcApi.terminal`.
- `main/pty/attentionMarkers.ts`: shared marker constants + `AttentionKind`.
- `main/pty/attentionDetector.ts` (+ test): stateful, split-chunk-safe substring
  detector keyed by sessionId.
- `main/pty/notifSettings.ts` (+ test): builds and writes the `--settings` JSON.
- `main/pty/shell.ts`: append `--settings '<path>'` to the claude initial command.
- `main/sessionNotifier.ts` (+ test): the suppress/dedup state machine, pure via
  injected `notify`/`broadcast`/`detect`/`isFocused`/`describeSession`.
- `main/index.ts`: write the settings file at boot; decorate the sender; build the
  notifier; native `Notification` + click-to-focus; register a `reportActive`
  handler.
- `preload/index.ts`, `renderer/features/terminal/{ipc,index}.ts`: expose the
  three new channels.
- `renderer/features/attention/` (store + selectors + barrel + test): per-session
  attention flags, surviving workspace switches.
- `renderer/app/attentionWiring.ts`: app-level glue - broadcasts -> store,
  store changes -> reportActive, notification click -> navigate.
- `renderer/features/tabs/components/TabBar.tsx`,
  `renderer/features/workspaces/components/WorkspaceList.tsx`,
  `shared/ui/app.css`: the minimalist pulse.

## Testing

- Unit: detector (marker detection incl. split across chunks, no false
  positives), notifSettings (valid JSON + exact markers), sessionNotifier
  (suppress-when-focused-active, dedup, clear-on-report, exit clears), attention
  store (mark/clear/selectors).
- E2E (Playwright): open a Shell tab, `printf` the OSC 9 marker, assert
  `.ix-tab--pulse` appears; assert it clears when the tab is (re)activated.
  Native OS notifications cannot be asserted via DOM (and do not render in
  unsigned dev builds), so the native path is covered by the notifier unit test
  plus manual UAT by the user.
