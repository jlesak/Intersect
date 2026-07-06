# Session Search — prohledávání ukončených Claude Code sessions

Design/spec pro novou vertical slice v Intersectu. Datum: 2026-07-06. Statut: schváleno k implementaci
(interview + Lavish review; jediná anotace = přidat délku trvání session, zapracováno).

## 1. Cíl

Najít starou Claude Code session podle útržku (název nebo něco, co jsem tehdy napsal), přečíst si
její transkript přímo v Intersectu a jedním klikem ji obnovit (`claude --resume <id>`) v terminálovém
tabu. Filtrovat podle časového rozsahu a podle složek, kde sessions běžely.

## 2. Data na disku (reverse-engineered)

- Sessions: `~/.claude/projects/<zakódovaný-cwd>/<sessionId>.jsonl` (~226 souborů, ~39 složek).
- Název složky je `cwd` s `/`→`-` a je **ztrátový** - proto se `cwd` čte z **obsahu** souboru
  (pole `cwd` na řádcích typu `user`/`assistant`/`system`), nikdy z názvu složky.
- Relevantní řádky (`.jsonl`, jeden JSON objekt na řádek):
  - `type:"ai-title"` → `aiTitle` (lidský název; ~183/226 souborů ho má).
  - `type:"user"` s `message.content` (string, nebo pole partů s `type:"text"`), `isMeta` může být true
    (přeskočit), `timestamp`, `cwd`, `gitBranch`.
  - `type:"assistant"` s `message.content` (pole partů: `text`, `tool_use`), `timestamp`.
  - Ostatní typy (`system`, `attachment`, `file-history-snapshot`, `queue-operation`, …) se pro účely
    indexu a transkriptu ignorují, kromě čtení `cwd`/`gitBranch`/`timestamp` když chybí jinde.
- První user zpráva bývá slash-command wrapper (`<command-name>/model</command-name>…`). Pro title
  fallback i pro searchable text se tyto wrappery **strippnou** (regex na `<command-name>` bloky) a
  pokud po stripu nezbyde text, řádek se pro title fallback přeskočí.

## 3. Zafixovaná rozhodnutí (z interview)

| Rozhodnutí | Volba |
|---|---|
| Hlavní akce | Číst transkript **a** Resume |
| Rozsah hledání | `aiTitle` + všechny **user** prompty (ne odpovědi asistenta) |
| Časový filtr | Date range picker (od–do), podle **poslední aktivity** session |
| Rozsah + složka | **Všechny** složky z `~/.claude/projects`, filtr = **multi-select** checkboxy složek, default vše |
| Resume + workspace | Najdi workspace dle `cwd`; když neexistuje, **automaticky** ho založ, pak otevři Claude tab s resume |
| Transkript | User + assistant text, **markdown**; tool calls shrnuté na jeden řádek |
| Data/výkon | **In-memory cache v mainu**; build při otevření sekce + manuální Refresh; renderer filtruje lokálně |
| Délka trvání | `lastTimestamp - firstTimestamp`, zobrazit v řádku i v detailu |
| Živá vs ukončená | Nerozlišovat (detekce nespolehlivá) - zobrazit všechny soubory jako historii |
| Resume persistence | **Persistovat** `resumeSessionId` na tabu (přežije restart appky) |

## 4. Datový tok

```
~/.claude/projects/*/*.jsonl
      → sessionIndex (main): glob + parse (jednou, cache v paměti)
      → sessions.list() přes IPC → useSessionsStore (zustand)
      → SessionsView filtruje lokálně (text + date range + složky)
      → výběr → sessions.getTranscript(id) → TranscriptViewer (markdown)
      → Resume → app-level koordinátor: najdi/založ workspace dle cwd
               → tab (preset 'claude', resumeSessionId) → terminal spawn `claude --resume <id>`
```

## 5. Kontrakt (`src/common`)

### 5.1 domain.ts — nové typy

```ts
/** Lehký indexový záznam jedné session (bez plného transkriptu). */
export interface SessionSummary {
  id: string            // Claude session UUID (= název .jsonl souboru bez přípony)
  filePath: string      // absolutní cesta k .jsonl (jak ho main najde pro transkript)
  cwd: string           // pracovní složka, čtená z obsahu
  folderName: string    // basename(cwd) pro zobrazení a folder filtr
  title: string         // aiTitle, nebo fallback z prvního ne-meta user promptu, nebo folderName
  gitBranch: string | null
  firstTimestamp: number   // ms epoch
  lastTimestamp: number    // ms epoch (poslední aktivita = klíč pro date filtr i řazení)
  durationMs: number       // lastTimestamp - firstTimestamp
  messageCount: number     // počet user+assistant zpráv
  userPrompts: string[]    // všechny user prompty (stripnuté od command wrapperů) - searchable text
}

/** Jeden vykreslitelný záznam transkriptu. */
export interface TranscriptEntry {
  role: 'user' | 'assistant'
  text: string                 // markdown text (spojený z textových partů); '' když jen tool volání
  timestamp: number
  tools: string[]              // jednořádkové souhrny tool volání, např. "Read src/foo.ts", "Bash: npm test"
}

export interface SessionTranscript {
  id: string
  title: string
  cwd: string
  entries: TranscriptEntry[]
}
```

### 5.2 domain.ts — rozšíření Tab

```ts
export interface Tab {
  id: string
  workspaceId: string
  title: string
  preset: Preset
  paneSlot: number | null
  sortOrder: number
  /** Claude session UUID k obnovení (claude --resume). null pro běžný tab. Persistováno. */
  resumeSessionId: string | null
}
```

### 5.3 ipc.ts — IpcApi

```ts
sessions: {
  list(): Promise<SessionSummary[]>       // z cache; build při prvním volání
  refresh(): Promise<SessionSummary[]>    // vynutí re-parse a vrátí čerstvý seznam
  getTranscript(id: string): Promise<SessionTranscript>
}
```

Změny existujících podpisů (resume plumbing):
- `tabs.create(workspaceId, preset, resumeSessionId?: string | null): Promise<Tab>`
- `terminal.spawn(sessionId, preset, cwd, cols, rows, resumeSessionId?: string | null): Promise<{ok}>`

Nové kanály: `sessionsList: 'sessions:list'`, `sessionsRefresh: 'sessions:refresh'`,
`sessionsGetTranscript: 'sessions:getTranscript'`.

## 6. Main — nová složka `src/main/sessions/`

### 6.1 sessionParse.ts (pure, unit-testovatelné)
- `parseSummary(filePath: string, lines: string[]): SessionSummary` - z řádků jednoho souboru poskládá
  summary. Defenzivní: neplatný JSON řádek se přeskočí, chybějící pole → fallback, funkce nikdy nehodí.
- `parseTranscript(id, title, cwd, lines): SessionTranscript` - poskládá vykreslitelné entries;
  assistant tool_use party → `tools` souhrny (`toolSummary(name, input)`), text party → `text`.
- Helpery: `stripCommandWrappers(text)`, `extractText(content)`, `toolSummary(name, input)`.

### 6.2 sessionIndex.ts
- `createSessionIndex({ projectsDir?, readDir?, readFile? })` - `projectsDir` default
  `~/.claude/projects` (respektuj env override `INTERSECT_CLAUDE_PROJECTS_DIR` pro E2E fixture);
  fs čtení injektované, aby šlo testovat bez skutečného disku.
- `list()`: pokud cache prázdná, `build()`; jinak vrať cache.
- `refresh()`/`build()`: glob `*/*.jsonl`, pro každý soubor `parseSummary`, seřaď dle `lastTimestamp` desc.
- `getTranscript(id)`: najdi `filePath` v cache (build když třeba), přečti a `parseTranscript`.
- Robustní vůči souboru, který zmizel mezi listem a čtením (vyhoď message-only Error).

### 6.3 ipc/sessions.ipc.ts
- `createSessionHandlers({ index })` → `{ list, refresh, getTranscript }` (pure, dle vzoru prInbox.ipc).
- `registerSessionHandlers(ipcMain, handlers)` binduje 3 kanály.

## 7. Renderer — nová slice `src/renderer/src/features/sessions/`

- `ipc.ts` - thin wrappery `list/refresh/getTranscript` přes `ipc().sessions`.
- `store.ts` - `useSessionsStore`: `status`, `all: SessionSummary[]`, filtry
  (`query`, `from: number|null`, `to: number|null`, `folders: Set<string>|null`=null znamená vše),
  `transcript`, `selectedId`. Selektor `selectFiltered(state)` aplikuje: text match
  (case-insensitive substring přes `title` + `userPrompts`), date range přes `lastTimestamp`,
  folder membership přes `cwd`. Akce: `hydrate()`, `refresh()`, `setQuery/setRange/toggleFolder`,
  `select(id)` (načte transkript), `resume(id)`.
- `components/`:
  - `SessionsView.tsx` - main region: `SessionFilters` + `SessionList` + `TranscriptViewer`.
  - `SessionFilters.tsx` - search input, date range (dva `<input type="date">`), folder multiselect
    (dropdown s checkboxy odvozený z distinct `folderName`), Refresh + počet.
  - `SessionList.tsx` / `SessionRow.tsx` - řádek: title, when (lastTimestamp), meta (folderName,
    gitBranch, messageCount, `⏱ durationMs` přes `formatDuration`), snippet s matchnutým promptem.
  - `TranscriptViewer.tsx` - hlava (title, rozsah + délka, Resume tlačítko), bubliny user/assistant
    přes `react-markdown` + `remark-gfm`, tool řádky jako mono `› …`.
  - `SidebarSessions.tsx` - malý sidebar rail obsah (nebo reuse jednoduchého seznamu; sidebar
    `component` může být lehký "Sessions" popisek/hint - hlavní obsah je `mainComponent`).
- `register.ts` - `registerSessionsFeature()`: `registerSidebarSection({ id:'sessions', order:2,
  label:'Sessions', icon:IconSearch, component:SidebarSessions, mainComponent:SessionsView })` +
  command `sessions.refresh`.
- `index.ts` - barrel (store hook + register).
- Resume koordinace (v slice, přes veřejná API jiných slices - povoleno pouze skrz jejich barrel/
  store getState, žádný import interních modulů): najdi ve `useWorkspacesStore` workspace s
  `folderPath === cwd`; když není, `create(cwd)`; `select(ws.id)`; po přepnutí `useTabsStore
  .getState().createTab('claude', sessionId)`. (createTab přijímá resumeSessionId.)

Markdown dep: `react-markdown` + `remark-gfm` do `dependencies`.

## 8. Resume plumbing (existující slices - dělá orchestrátor, ne subagent)

- **migrations.ts v3**: `ALTER TABLE tabs ADD COLUMN resume_session_id TEXT` (transakční DDL, OK).
- **tabRepo.ts**: `TabRow.resume_session_id`; `toTab` → `resumeSessionId`; `create(workspaceId,
  preset, title?, resumeSessionId?)` INSERT včetně sloupce.
- **tabs.ipc.ts**: `create(workspaceId, preset, resumeSessionId?)` predá do repa; registrace kanálu
  čte 3. arg.
- **tabs/ipc.ts + store.ts**: `createTab(preset, resumeSessionId?)` protáhne dál.
- **terminal.ipc.ts + sessionManager.ts**: `spawn(...ics, resumeSessionId?)`;
  `buildSpec: (preset, resumeSessionId?) => SpawnSpec`.
- **shell.ts**: `BuildSpawnOptions.resumeSessionId?`; `resolveInitialCommand` pro claude přidá
  `--resume <singleQuote(id)>` (před `--settings`). Bez resume beze změny.
- **terminal/ipc.ts + terminalController.ts + TerminalPane.tsx + SplitStage.tsx**: protáhnout
  `resumeSessionId` z `Tab` do `ensureSession` → `ipc.spawn`.
- **preload/index.ts**: `tabs.create` + `terminal.spawn` + celý `sessions` objekt.
- **main/index.ts**: vytvoř `createSessionIndex()`, zaregistruj `registerSessionHandlers`; wrapper
  `terminalHandlers.spawn` a `presetsBySession` rozšířit o `resumeSessionId`; `buildSpec` predá
  `resumeSessionId` do `buildSpawn`.
- **registerFeatures.ts**: `registerSessionsFeature()`.

Poznámka: tabův `resumeSessionId` = Claude UUID, je odlišný od Intersect composite sessionId
(`workspaceId:tabId`) - žádná kolize.

## 9. Testy

**Vitest (TDD):**
- `sessionParse`: title (aiTitle → fallback → folderName), strip command wrapperů, first/last ts +
  duration, messageCount, userPrompts, transcript entries + tool souhrny, defenzivnost (rozbité řádky).
- `sessionIndex`: build/list/refresh přes injektované readDir/readFile, řazení desc, getTranscript,
  chybějící soubor.
- `sessions.ipc`: list/refresh/getTranscript delegace, error wrapping.
- store filtry: text, date range, folder multiselect, řazení.
- `tabRepo`/`tabs.ipc`: create s resumeSessionId round-trip.
- `shell.buildSpawn`: claude resume command `claude --resume '<id>' --settings '…'`; bez resume beze změny.

**Playwright (E2E):** Sessions sekce proti fixture `INTERSECT_CLAUDE_PROJECTS_DIR` → seznam;
search zúží; folder filtr; klik → transkript; Resume → vznikne/najde workspace a Claude tab.

## 10. Rizika

- `.jsonl` formát je nedokumentovaný a může se změnit - parser izolovaný a defenzivní.
- Test/prod node:sqlite fidelity (existující trade-off) - migrace v3 je jen `ALTER TABLE`.
- Resume po forku session: re-resume otevře původní stav - přijatý edge case.

## 11. Known limitations (z code-review)

- **Resume do smazané/přesunuté složky:** když `cwd` session už neexistuje, `sessionManager`
  spadne zpět na `$HOME` a `claude --resume <id>` se spustí tam. Pokud Claude Code resolvuje
  sessions per-cwd, resume tam sešn nenajde. Nízká pravděpodobnost (složka musela zmizet);
  ponecháno jako známé omezení, neřešeno spekulativní změnou chování.
- **Sidebar ikona:** použita `IconHistory` místo `IconSearch` z §7 - vědomá volba (lépe vystihuje
  "minulé sessions").
