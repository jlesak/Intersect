# Global keyboard shortcuts and native macOS application menu

Design for GitHub issue #44. Approved 2026-07-25.

## Goal

Give Intersect an app-wide keyboard layer and a native macOS menu bar. Today the only app-wide
shortcut is `Cmd+K`, implemented as a `window` keydown listener inside `CommandPalette`, and no
`Menu` exists in the main process at all - so there are no accelerators and nothing discoverable in
the menu bar. In a terminal-first tool, opening, closing and switching tabs is mouse-only.

## Architecture

One map, two consumers, one dispatch target.

```
src/common/shortcuts.ts  (SHORTCUT_ACTIONS)
        |                         |
        v                         v
 main/menu.ts              commandPalette
 appMenuTemplate()         (renders the kbd hint)
        |                         |
        v                         |
 main/index.ts                    |
 Menu.buildFromTemplate           |
        |                         |
        | click -> sendToRenderer |
        |   Channel.shortcutInvoked { id }
        v                         |
 app/shortcutWiring.ts            |
        |                         |
        +----------> commandRegistry <-----+
                            |
                            v
                     feature stores
```

### Why accelerators live in the native menu

xterm.js owns keyboard focus for most of this app's life, so a renderer `keydown` listener is at the
mercy of the terminal. macOS menu accelerators are handled by the application menu before web
contents see the key, so they work with a terminal focused.

### Why dispatch lands in the command registry

The menu carries no behaviour - it sends an id. The renderer resolves that id through the existing
`commandRegistry`, so one registration yields both a menu accelerator and a palette entry. A
shortcut cannot exist without its palette command.

### Testability

`appMenuTemplate()` is a pure function returning `MenuItemConstructorOptions[]` and never touches the
`electron` runtime, so it unit-tests under the existing `node` vitest project - the same shape as
`activateAction` in `main/lifecycle.ts`. Only `main/index.ts` calls `Menu.buildFromTemplate`. Every
menu item carries `id: action.id`, which is what lets an e2e test click it programmatically.

## The shortcut map

| Accelerator | Command id | Menu | Behaviour |
| --- | --- | --- | --- |
| `CmdOrCtrl+T` | `tabs.new` | File | New tab with the last-used preset (defaults to `shell`) |
| `CmdOrCtrl+Shift+T` | `tabs.newWithPreset` | File | Opens the `PresetPicker` popover |
| `CmdOrCtrl+W` | `tabs.close` | File | Close active tab; no-op when none is open |
| `Control+Tab` | `tabs.next` | Window | Cycle to next tab, wrapping |
| `CmdOrCtrl+1`..`9` | `tabs.jump.1`..`tabs.jump.9` | Window submenu | Jump to tab N; N beyond the count selects the last tab. Hidden from the palette |
| `CmdOrCtrl+B` | `shell.toggleSidebar` | View | Existing `shellStore.toggleSidebar()` |
| `CmdOrCtrl+Shift+P` | `projects.next` | View | Cycle to next active project pin, wrapping |
| `CmdOrCtrl+Shift+A` | `attention.jumpOldestWaiting` | View | Focus the session waiting longest |
| `CmdOrCtrl+K` | `palette.open` | View | Toggle the command palette. Hidden from the palette itself, where running it would close and immediately reopen it |

`Cmd+F` and `Cmd+=`/`-`/`0` are out of scope - the issue assigns them to the terminal issue #46.

## Menu structure

- **Intersect** - `role: 'appMenu'`.
- **File** - New Tab, New Tab with Preset..., separator, Close Tab.
- **Edit** - native `undo`, `redo`, `cut`, `copy`, `paste`, `selectAll` roles. Not decoration: without
  them, clipboard shortcuts stop working inside text inputs in a packaged mac build, and this app has
  many inputs (PR comment composers, the TODO field, Settings).
- **View** - Command Palette, separator, Toggle Sidebar, Switch Project, Jump to Waiting Session,
  separator, `togglefullscreen`, plus `reload` and `toggleDevTools` outside a packaged build.
  Installing any menu displaces Electron's default one, which is where full screen, reload and the
  inspector came from; nothing else in the app provides them, so leaving them out would silently
  remove the only way to open DevTools in development.
- **Window** - Next Tab, a `Go to Tab` submenu holding the nine jumps, separator, `minimize`, `zoom`,
  `front` roles.

The Window menu must **not** include `role: 'close'`. Electron's close role claims `Cmd+W` by
default, which would shadow Close Tab.

## Decisions

**`Cmd+Shift+P` cycles to the next active project pin, wrapping.** No new UI, deterministic,
unit-testable, and no overlap with #45, which owns the dynamic palette picker.

**`Cmd+W` is a no-op when no tab is open, and the File item stays enabled.** Greying it would mean
rebuilding the native menu on every tab-count change - real machinery for a cosmetic gain.

**Attention entries widen from `SessionStatus` to `{ status, since }`.** "Oldest waiting" is not
derivable today. Insertion order would be silently wrong: re-marking a session does not move its key,
so a long-waiting session could hide behind a fresh one. The store is renderer-only and never
persisted, so there is no migration.

`since` is stamped **only when the status actually changes**. The core repeats a status for as long
as the condition holds - `sessionNotifier.ts` broadcasts on every detected marker chunk *"regardless
of viewing/dedup"*, and broadcasts `'working'` on every user input before its own dedup check - so
refreshing on every repeat would reset a session that has genuinely been waiting for minutes and make
"waiting longest" meaningless. A repeat also returns state unchanged, preserving object identity so
it wakes no subscriber. Leaving `waiting` and returning is a new episode and does restart the clock.

**`Command` is left unchanged; the palette derives both the hint and visibility from the map.**
An earlier draft added `shortcut?` and `hidden?` to the `Command` interface. Both are already
derivable from `SHORTCUT_ACTIONS` by command id, so carrying them on the command as well would
duplicate exactly what the single-source-of-truth map exists to prevent. `shortcutActionFor(id)`
gives the palette the accelerator to render and the `hidden` flag to filter on, and
`commandRegistry.ts` needs no change - which also leaves less for #45 to unpick. `hidden` keeps the
nine positional tab jumps out of the palette, where "Go to Tab 4" is noise nobody would type.

Because the map holds the label and the registry holds the command title, `shortcutCommands.test.ts`
pins them to each other: every mapped shortcut must resolve to a registered command whose title
equals the menu label. Without it, a mapped id with no command would be a menu item that silently
does nothing.

**`Cmd+K` moves to the menu accelerator and the renderer `keydown` is deleted.** Keeping both
handlers risks a double-toggle if Electron ever delivers the key to both, which would make `Cmd+K`
appear dead. One mechanism for all nine shortcuts is worth more than preserving one test's trigger
method.

**Palette open state moves out of `useState` into `commandPalette/store.ts`.** The menu must be able
to open the palette from outside the component; local state cannot be reached.

**Commands needing app-layer state live in `app/shellCommands.ts`.** `shell.toggleSidebar`,
`projects.next` and `attention.jumpOldestWaiting` all need `shellStore` or `navigateToSession`, both
app-layer. ESLint forbids a feature importing `@renderer/app`, so these belong to the app.
`navigateToSession` gets exported from `app/attentionWiring.ts`.

## Cross-process contract: adding a channel is not just `Channel`

`Channel.shortcutInvoked` must also be declared in `RENDERER_PUSH_CHANNELS` in
`src/common/coreBridge.ts`, sourced `'main'`. `CORE_INVOKE_CHANNELS` is derived **by exclusion** from
the other three sets, so an undeclared channel is silently classified as a core-routed
request/response - and `assertRoutesCoverBridge` in `src/core/wire.ts` then finds no core handler for
it and throws at boot. The result is a completely bricked app: every window opens straight into the
`ix-core-failure` overlay and no IPC works.

This was caught only by running the app. Typecheck and lint both pass with the channel missing, and
`wire.test.ts`'s "every renderer channel belongs to exactly one direction" does **not** catch it,
because exclusion-derived membership still reports exactly one. The signal is `bootstrap.test.ts`,
which builds a real runtime in `beforeEach` and so fails wholesale - a reason never to wave that file
off as environmental without reading the actual error.

## Conventions this must follow

- Feature-boundary ESLint rule: import another feature only through `@renderer/features/<name>`,
  never its internals.
- Explicit return types on exported functions. `import type` for type-only imports. No default
  exports. `void promise` for fire-and-forget. Always `<button type="button">`.
- Doc comments describe business meaning. No issue or ticket numbers in code comments.
- Selectors that derive a fresh array or object need `useShallow` at the call site.
- Store tests: `vi.mock('./ipc')` + `vi.mocked(api)`, reset via `setState(shape, false)` in
  `beforeEach`, assert through `getState()`.
- Component tests: seed with `useStore.setState`, reset in `afterEach`, fake the bridge by assigning
  `window.intersect`, wrap `render` in `await act(async () => ...)`.
- Vitest globals are off - import `describe`/`expect`/`test`/`vi` from `vitest`. No `jest-dom`.
- e2e specs select by CSS class, launch the built app from `out/main/index.js`, use a fresh
  `mkdtempSync` profile and `INTERSECT_E2E=1`, and end with `await app.close()`.

## Test plan

| Level | File | Pins down |
| --- | --- | --- |
| unit | `src/common/shortcuts.test.ts` | No duplicate ids; **no duplicate accelerators**; every action names a real menu bucket |
| unit | `src/main/menu.test.ts` | Every action present with the right accelerator and `id`; Edit roles present; **no `close` role**; clicking an item calls `invoke` with its id |
| unit | `app/shortcutWiring.test.ts` | A dispatched id runs the registered handler; an unknown id is ignored without throwing |
| unit | `features/attention/store.test.ts` | `since` stamped on mark; `oldestWaitingSession` returns the longest-waiting and ignores working/done; re-marking refreshes `since` |
| unit | `features/tabs/store.test.ts` | `lastPreset` updates on create and survives `hydrate()`; `nextTab` wraps; `jumpToTab(9)` clamps to the last tab |
| unit | `app/shellCommands.test.ts` | `projects.next` wraps across pins; no-op with zero or one project |
| e2e | `e2e/shortcuts.spec.ts` (new) | Clicks real menu items via `app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById(id).click())` and asserts the effect |
| e2e | `e2e/palette.spec.ts` (edit) | Its `Meta+k` press and `toHaveCount(12)` both stop holding |

### Known coverage limit

No Playwright test can assert that a real OS key press reaches the app - CDP key events do not fire
native menu accelerators. This is true of all nine shortcuts and is a harness limitation, not a
design flaw. What stays covered is everything after the keystroke: menu wiring, IPC, dispatch,
handler. The keystroke-to-accelerator binding is covered by assertions in `menu.test.ts` and
confirmed once by hand.

## Risks

- **`Control+Tab` is a real terminal key.** Claiming it app-wide takes it from anything running in a
  terminal that uses it. The issue specifies it, so it ships; reversing it is one line in one file.
- **Attention store shape change** touches three read sites and their tests. Renderer-only and never
  persisted, so no migration; TypeScript finds every site.
- **Palette grows** from 12 to roughly 19 visible commands. Grouping and MRU ordering are #45's job.

## Out of scope

#45's full `Command` schema (`keywords`, `group`, `enabled()`), MRU ordering, dynamic palette
entries, quick-capture syntax. #46's terminal keys. A Settings `Cmd+,` item, since the approved map
does not list one.
