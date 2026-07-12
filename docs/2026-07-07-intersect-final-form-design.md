# Intersect - finální podoba: Personal Work OS

Vysokoúrovňová produktová specifikace cílové podoby celé aplikace. Datum: 2026-07-07.
Status: **schváleno** (původní interview + Lavish review; 2026-07-11 doplněno schváleným
Watchtower copy/inspiration review a aktualizovanou roadmapou).

Vychází z: implementovaného stavu (workspaces + terminály, command palette, attention notifikace,
session search, PR Inbox, My Work, time tracking), otevřených issues #4 #5 #7 #8, analýzy 6 měsíců
Claude Code historie uživatele (6 237 promptů, 326 spuštění CLI) a výzkumu 25+ nástrojů v kategoriích
agent orchestrace a osobních work hubů.

## 1. Identita a cíl

**Intersect je Personal Work OS** - jedna aplikace pro celý pracovní den jednoho člověka:
Claude Code (a další) agenti, Azure DevOps PRka, Jira, osobní TODO, lidé a 1:1, čas i náklady.
Všechny oblasti jsou první třídy a navzájem se znají: session ↔ větev ↔ PR ↔ ticket ↔ osoba ↔ čas
tvoří jeden propojený graf. Terminály zůstávají srdcem appky, ale přestávají být domovem - domovem
je dashboard toho, co uživatele právě teď potřebuje.

**Proč tahle sázka:** kategorie čistých Claude Code session managerů v roce 2026 zanikla
(Crystal, Vibe Kanban, Terragon) a Anthropic tu vrstvu pokryl first-party (desktop redesign,
Remote Control, worktrees, Agent View). Nikdo ale nenabízí vrstvu nad ní - osobní plochu, kde se
agenti potkávají s PRky, Jirou, lidmi a časem. Přesně tam Intersect už organicky směřuje a jako
osobní aplikace nenese business-model riziko, které tu kategorii zabilo.

## 2. Zafixovaná rozhodnutí (z interview a review)

| Rozhodnutí | Volba |
|---|---|
| Identita | Personal Work OS - všechny oblasti první třídy, sjednocené vrstvou "co mě teď potřebuje" |
| Domov | Dashboard: stav sessions + PR/Jira "needs me" + kalendář/čas + "while you were away" digest |
| Grupování | **Projekt** jako deštníková entita (repo složky + Jira filtr + ADO repo + Toggl projekt), vše ostatní se váže automaticky |
| Orchestrace | Plná: spuštění agenta z karty, diff review s komentáři zpět agentovi, sync do živého checkoutu |
| Výchozí režim spuštění z karty | Hlavní checkout default, worktree opt-in při spuštění |
| Lidé | Person Pages jako first-class objekt, auto-Brief před 1:1 |
| Čas + náklady | Pasivní timeline → end-of-day reconcile do Togglu; tokeny/cena per session |
| Capture | Globální systémová macOS zkratka s plovoucím capture boxem (@osoba, #projekt, termín) |
| Companion | Mobilní, minimální scope: push notifikace + odpovědi agentům; E2E šifrování, QR párování, hloupý relay |
| AI vrstva | Asistent nad sjednoceným indexem práce; lokální LLM preferované, cloud Claude jen kde je potřeba |
| Lokální LLM runtime | LM Studio (MLX engine); core mluví OpenAI-kompatibilním API, runtime vyměnitelný v Settings |
| Multi-agent | Adapter vrstva: Claude Code plně, OpenCode/PiCode a další postupně; terminálové presety konfigurovatelné |
| UI shell | Ikonový rail + kontexty: Dashboard / Projekty / Lidé / TODO / Čas, Settings dole |
| Tech stack | Electron + React zůstává; jádro se vytáhne do headless Node core s typovaným API |
| Pořadí extrakce core | Headless core vznikne po F1 a před Dashboardem/F2, aby všechny další background služby vznikaly rovnou mimo Electron main |

## 3. Feature pilíře

Legenda: **[existuje]** implementováno · **[spec]** schválená spec čeká na implementaci ·
**[evoluce]** rozšíření existujícího · **[nové]** nová oblast.

### 3.1 Dashboard [nové]

Domovská obrazovka = "co mě teď potřebuje", ne přehled všeho. Čtyři sekce:

- **Sessions:** typované attention stavy - *čeká na odpověď* / *chce nebezpečné povolení*
  (vizuálně alarmující, jiná třída notifikace) / *doběhla* / *spadla* / *osiřelý proces* - s cenou
  a projektem. Schválení destruktivní akce vypadá jinak než "kterou variantu chceš?". Pro Claude
  Code jsou autoritativním zdrojem hook události z explicitního stavového automatu; PTY heuristika
  zůstává fallbackem a základem pro adaptéry bez hooků.
- **Needs me:** PR čekající na moje review, moje PR vrácená k úpravám, Jira úkoly na dnešek,
  osobní TODO s termínem.
- **While you were away:** digest od posledního pohledu - co agenti dodělali, nové PR komentáře,
  změny v Jira. Shrnutí generuje lokální LLM.
- **Kalendář + čas:** dnešní schůzky (M365), nadcházející 1:1 s tlačítkem "Brief", plán vs. realita
  odpracovaného času.

Každá položka má jednoklávesový **snooze** (dnes / zítra / tento týden) a skok na zdroj. Snooze
sémantika je jednotná napříč typy položek (PR, Jira, TODO, session).

### 3.2 Projekty [nové]

Deštníková entita, pojivo celé appky:

- Projekt = 1+ repo složek (včetně worktrees; "SPOT + SPOT2/spot-backend je jeden projekt"),
  Jira filtr (např. `project = FID2507`) a volitelný board URL, ADO repo(s), Toggl projekt.
- Vše ostatní se přiřazuje **automaticky přes vazby**: session podle složky, PR podle repa,
  issue podle filtru, čas podle session/větve, worktree podle mateřského repa. Ruční override
  pro výjimky, nezařazené padá do "Ostatní".
- Projektový kontext = jeho terminály/taby/splity (zachovává dnešní workspace UX) + záložky
  Kanban / PRka / Worktrees / Přehled.
- Dashboard, digest, worklog i session search jsou filtrovatelné per projekt.
- Migrace: dnešní workspaces se stanou repo vazbami projektů, ne top-level pojmem.

### 3.3 Orchestrace agentů [evoluce]

"Karta = agent." Jeden klik, žádný wizard:

- Přetažení Jira karty / TODO do *In Progress* → tab + session pojmenovaná podle ticketu.
  **Default v hlavním checkoutu; worktree opt-in** při spuštění (pro paralelní práci).
- Přesun karty uvnitř Intersectu bez dalšího explicitního schválení nemění vzdálený Jira status;
  Jira synchronizace je read-only a spuštění agenta je lokální orchestrace.
- Přesun do *Review* → diff seskupený podle logických celků (ne abecedně podle souborů),
  **inline komentáře putují zpět agentovi** bez zastavení jeho práce.
- **Sync do živého checkoutu**: otestovat změny agenta z worktree v reálném prostředí
  (dev server, .env, node_modules) bez merge.
- Session ↔ větev ↔ PR ↔ ticket ↔ čas = jeden provázaný, dohledatelný objekt. Merge PR
  session auto-archivuje a zapíše do digestu.
- Každá session má nejvýše jednu **primární pracovní položku** (`WorkItemRef`: Jira / TODO / PR /
  další adapter). Spuštění z karty ji nastaví automaticky, ručně spuštěnou session lze připojit
  searchable pickerem a vazbu později změnit bez ztráty historického snapshotu.
- Soft-cap paralelismu s indikací zátěže stroje; překryvy souborů mezi paralelními větvemi
  se hlásí předem (semantic konflikty nikdo neřeší, ale jde je aspoň včas ukázat).

### 3.4 Lidé (Person Pages) [nové]

Trvalá stránka per člověk - pojivo pro 1:1 i spolupráci:

- Agregace: historie 1:1 poznámek (Notion), otevřené závazky obou stran, společné PR/Jira,
  zmínky v TODO (@osoba).
- **Auto-Brief před 1:1** z kalendáře: minulé závěry, co od nich/pro ně visí, Slack aktivita.
- Workflow "Zpracovat nahrávku 1:1" (existující `1to1` skill, viz spec 2026-07-06) se naváže
  na osobu; historie běhů per osoba.
- Nahrazuje původní rozhodnutí 1:1 spec "žádný trvalý seznam osob" - finální forma lidi povyšuje
  na first-class objekt; 1:1 spec (#5) se implementuje první a Person Pages na ni navazují.

### 3.5 TODO + Quick Capture [spec + nové]

- Lehký seznam dle schválené spec (#4): text, termín, drag&drop, skrytá sekce "Hotové".
- **Globální macOS zkratka** → plovoucí capture box i mimo Intersect: zápis do 2 sekund,
  syntaxe `@marek #spot pátek`. Enter a zpátky do práce.
- TODO zmínky osob a projektů se propisují do Person Pages a projektových pohledů.

### 3.6 Čas + náklady [evoluce]

- Pasivní zdroje: session index, git větve, kalendářní schůzky, aktivní workspace - žádný
  ruční start/stop timer.
- Čas má dvě oddělené veličiny: **lidský pracovní čas** je nepřekrývající timeline používaná pro
  reconcile a Toggl; **agent runtime** je per-session metrika, může se mezi paralelními agenty
  překrývat a nikdy se sama nevykazuje jako lidský worklog.
- **End-of-day reconcile (5 minut):** vizuální pás dne, bloky předvyplněné projektem/ticketem
  z kontextu, potvrzením se zapíšou do Togglu. Nic se neodesílá bez review.
- **Cost meter:** tokeny/cena per session živě na tabu, v dashboardu i digestu
  ("co mě stál agent, od kterého jsem odešel") - diferenciátor, který nikdo na trhu nemá,
  postavený na už existujícím parsování session logů.
- Plán vs. realita: kalendář + committed TODO vedle skutečné aktivity.

### 3.7 AI vrstva [nové]

Local-first asistent nad sjednoceným indexem vší práce:

- **Model routing:** lokální LLM přes LM Studio (MLX, OpenAI-kompatibilní API) pro shrnutí,
  klasifikace, embeddingy, digest, Briefy; cloud Claude pro guardrailed PR review a náročné úlohy.
  Routing pravidla a měsíční limit útraty konfigurovatelné v Settings, per-úloha fallback na cloud.
- Dotazy z palety/chatu: "Na čem jsem se zasekl minulý týden?", "Co čeká na Marka?",
  "Najdi session, kde jsme řešili migrace".
- Sjednocený index: sessions, PR, Jira, 1:1, TODO, čas - lokální embeddingy, fulltext +
  sémantické vyhledávání.
- **Guardrail trvá:** AI nikdy neschvaluje PR, nehlasuje, ani neodesílá nic ven bez ručního kroku.

### 3.8 Multi-agent adaptery [nové]

Claude Code first, ne Claude Code only:

- Adapter interface pro session sledování: attention stavy, index, resume, cost metering - per
  agentní CLI. Claude Code adapter plný (dnešní chování); OpenCode/PiCode s lokálními LLM postupně.
- Adaptery izolují křehkost formátů třetích stran: verzované parsery, degradace na "jen terminál"
  místo rozbití.
- Terminálové presety plně konfigurovatelné (libovolný příkaz + volitelný adapter).

### 3.9 Mobilní companion [nové]

Minimální a bezpečný - jen to, co dává na telefonu smysl:

- Push: session čeká / chce povolení / doběhla / spadla - s **presence suppression**
  (žádný push, když je tab fokusovaný a obrazovka odemčená).
- Odpověď agentovi / schválení povolení přímo z notifikace či mini-UI. Schválení destruktivní
  akce vždy s explicitním potvrzením.
- Bezpečnostní model po vzoru Happy Coder: E2E šifrování (klíče jen v zařízeních, QR výměna),
  relay jako hloupá trubka bez znalosti obsahu, krátkodobé odvolatelné credentials, outbound-only.
- Mimo scope companionu (vědomě): dashboard, diff review, PR akce, TODO - telefon slouží jen
  smyčce "agent mě potřebuje → odpovím".

### 3.10 PR Inbox [existuje + v2 spec]

- Hlasování Approve / Approve with suggestions / Wait for author dle spec (#7).
- Segmentace à la GitHub PR inbox: needs my review / vrácené mně / čeká na ostatní.
- PR navázané na projekt, session i ticket; merge = auto-archiv session + zápis do digestu.

### 3.11 Command palette [evoluce]

- Z navigace se stane "dělání": kontextové akce podle fokusu (v PR detailu vote/koment,
  na kartě spustit agenta, na položce snooze).
- Vstup do AI asistenta přímo z palety.
- Jednotný klávesový slovník napříč typy položek: stejné klávesy = stejná sémantika
  (Enter otevřít, S snooze, A odpovědět agentovi). Navigace G+D dashboard, G+1..9 projekty.

### 3.12 Settings [spec]

- Dle schválené spec (#8): notifikace, ADO připojení, přehled zkratek, vzhled.
- Nově: projekty (vazby), AI (lokální runtime, routing pravidla, limity útraty),
  companion (párování a revokace zařízení), notifikace rozšířené o presence suppression.
- **Agent tooling:** Claude Code global/project konfigurace, permissions, hooks, MCP, přehled skills
  a agents. Backend se převezme z Watchtoweru; celé UI/UX vznikne od nuly v design systému
  Intersectu a později se stejný shell rozšíří o další agentní adaptéry.

## 4. UX shell

- **Ikonový rail vlevo:** Dashboard nahoře, piny projektů (se status tečkou agregující jejich
  sessions), pak globální sekce Lidé / TODO / Čas, Settings dole.
- **Projektový kontext** po kliknutí na pin: terminály (taby, splity - dnešní UX) + Kanban /
  PRka / Worktrees / Přehled. Terminály zachovávají jednoduché layouty single / columns / rows /
  grid; dělicí poměry jsou uživatelsky nastavitelné a persistované per projekt.
- **Klávesnice první**, myš druhá. Globální capture zkratka funguje celosystémově.
- **Notifikace:** typované attention stavy + presence suppression; nastavení drží jednoduchost
  "při dokončení" / "při potřebě akce" (+ per stav, dle Settings spec).
- Mockup schválen v Lavish review: `.lavish/intersect-final-form.html`, sekce 04.

## 5. Architektura a tech stack

- **Zůstává:** Electron + React 19 + TypeScript + Zustand + node-pty + node:sqlite,
  vertical slices s ESLint hranicemi. Žádný přepis na Tauri - u osobní appky se RAM platí jen
  sobě a přepis by zahodil investici.
- **Mění se:** hned po F1 se jádro (PTY manager, DB, integrace, notifikace/digest, orchestrátor,
  sjednocený index, AI router) vytáhne z Electron main procesu do **headless core** - samostatného
  Node procesu s typovaným API (IPC pro renderer, zabezpečený transport pro companion relay). Electron UI
  i mobilní companion jsou jen dva klienti téhož jádra; core běží i se zavřeným oknem,
  takže push funguje dál.
- **Lifecycle:** core běží jako Electron `utilityProcess`; zavření posledního okna Electron
  neukončí a nové okno se otevře kliknutím na běžnou Dock ikonu. Intersect nemá macOS menu-bar
  ikonu ani tray menu; Dock badge ukazuje počet nevyřízených attention položek. `Cmd+Q` ukončí i
  core - samostatný LaunchAgent/daemon zatím není součástí rozhodnutí. Pád core vyvolá recovery
  banner a nejvýše tři automatické restarty
  během jedné minuty. Při potvrzeném `Cmd+Q` se živé Claude sessions označí `suspended` a při
  příštím startu obnoví z ověřeného transcript resume ID; shell/dev-server proces se zachovat nedá.
- **Procesní hranice:** core vlastní SQLite, PTY, session state, integrace, index, AI router a
  background joby. Electron main vlastní pouze okna/Dock lifecycle, systémové dialogy/notifikace,
  otevírání externích URL a další OS-only operace. Renderer nikdy nevolá core služby přímo.
- **AI router:** jedno místo rozhoduje lokální (LM Studio / OpenAI-kompatibilní API) vs. cloud
  (Claude) podle typu úlohy; embeddingy a klasifikace vždy lokálně.
- **Integrace:** Azure DevOps (PAT), Jira/Confluence (browser-session SSO mechanismus převzatý
  z existujících skillů, stav připojení viditelný v Settings), Notion, Slack, M365 kalendář, Toggl.
- Architektonický diagram schválen v Lavish review: `.lavish/intersect-final-form.html`, sekce 05.

## 6. Roadmap (aktualizováno po Watchtower review)

| Fáze | Obsah | Hodnota po dokončení |
|---|---|---|
| **F0** | Dokončit schválené specky: TODO (#4), Settings (#8), PR Inbox v2 (#7), 1:1 workflows (#5, bez Person Pages) | Uzavřené issues, stavební kameny (TODO pro capture, Settings pro konfiguraci) |
| **F1** | Projekty + nový shell: deštníková entita, vazby, auto-přiřazování, ikonový rail, projektové kontexty, migrace workspaces | Pojivo pro všechno další |
| **F1.5** | Headless core: přesun SQLite, PTY, sessions a attention pipeline do `utilityProcess`; typované MessagePort RPC, Electron-only routing, Dock/window lifecycle, crash recovery a terminal snapshot/reattach | Stabilní background základ pro všechny další fáze |
| **F2** | Dashboard + digest + cost meter: čtyři sekce, typované attention stavy, snooze, presence suppression, tokeny/cena per session; digest = první lokální LLM use-case | Nový domov appky |
| **F3** | Orchestrace: spuštění z karty (hlavní checkout default, worktree opt-in), diff review s komentáři zpět, sync do živého checkoutu, provázání session↔PR↔ticket, auto-archiv po merge | Karta = agent |
| **F4** | Lidé + quick capture: Person Pages, auto-Briefy, navázání 1:1 na osoby, globální capture zkratka | Manažerská vrstva |
| **F5** | Čas: pasivní timeline + end-of-day reconcile do Togglu, plán vs. realita | Konec ručního timesheetu |
| **F6** | AI asistent: sjednocený index s embeddingy, konverzační asistent, AI router a multi-agent adaptery (OpenCode) nad již existujícím headless core | Paměť a inteligentní vrstva nad prací |
| **F7** | Mobilní companion: E2E relay, QR párování, push, odpovědi agentům z telefonu | Smyčka "agent mě potřebuje" funguje odkudkoliv |

Každá fáze je samostatně hodnotná - po každé je appka kompletní a užitečnější než před ní.

## 7. Rizika a mitigace

| Riziko | Dopad | Mitigace |
|---|---|---|
| Anthropic sežere další vrstvu | Session management, remote control i worktrees už má first-party | Diferenciace je v propojení napříč nástroji (PR + Jira + lidé + čas), ne v session vrstvě; adapter vrstva drží nezávislost |
| Parsování session formátů | Claude Code / OpenCode mění JSONL formáty bez varování | Adaptery izolují formát, verzované parsery, degradace na "jen terminál" místo rozbití |
| SSO scraping Jira/Confluence | Křehké, session expiruje | Mechanismus už vyřešen existujícími skilly; core ho přebírá, stav připojení viditelný v Settings |
| Companion bezpečnost | Vzdálené schvalování nebezpečných povolení = citlivý kanál | E2E, žádný plaintext relay, destruktivní akce jen s explicitním potvrzením, revokace zařízení |
| Rozsah (solo projekt) | F0-F7 je hodně práce | Fáze jsou samostatně hodnotné, žádná nevyžaduje dokončení celku |
| Kvalita lokálních LLM | Shrnutí/asistent můžou být horší než cloud | AI router umí per-úloha fallback na Claude; ladí se v Settings, ne v kódu |

## 8. Mimo scope (vědomě)

- Multi-user / týmové funkce - Intersect je a zůstane single-user.
- Companion nad rámec push + odpovědí agentům (žádný mobilní dashboard, diff review, PR akce).
- Náhrada Todoistu, plnohodnotný kalendářní klient, e-mail.
- Background polling ADO nad rámec toho, co dashboard/digest potřebují.
- Automatické AI akce směrem ven (vote, publikace, odeslání) - vždy ruční krok.

## 9. Plánované převzetí z Watchtoweru

Tato sekce je implementační mapa pro části, které se mají převzít z lokálního checkoutu
`../Watchtower`. „Převzít“ znamená začít kopií uvedených produkčních souborů a jejich testů,
potom pouze přejmenovat veřejné typy/importy a napojit je na doménu Intersectu. Neznamená to
kopírovat celý Watchtower modul ani jeho historické technické dluhy.

### 9.1 Headless core a procesní lifecycle [schváleno]

**Co převzít:**

- `../Watchtower/electron/orchestratorHost.ts` - `utilityProcess.fork`, `MessageChannelMain`,
  recovery událost a ochrana proti crash-loopu (max. tři restarty za 60 sekund).
- `../Watchtower/packages/shared/src/messagePort.ts` - korelované request/response RPC přes
  MessagePort, pending-request mapa a push události core → Electron.
- `../Watchtower/electron/ipc.ts` spolu s `ELECTRON_ONLY_KINDS` v
  `../Watchtower/packages/shared/src/ipcContract.ts` - rozdělení OS-only požadavků a požadavků
  směrovaných do core.
- `../Watchtower/orchestrator/bootstrap.ts` - jediný bootstrap/shutdown vlastník DB a
  background služeb. Převzít strukturu lifecycle, nikoli Watchtower-specific Postgres,
  TimeTracker migraci ani nezabezpečený WS bridge.
- `../Watchtower/electron/main.ts` - pouze lifecycle (`window-all-closed` neukončuje aplikaci,
  Dock `activate` znovu vytvoří okno), potvrzení ukončení živých sessions a předání crash stavu
  rendereru. Watchtower tray wiring nepřebírat.
- Testy jako výchozí safety net: `../Watchtower/tests/shared/messagePort.test.ts`,
  `../Watchtower/tests/orchestrator/bootstrap.test.ts` a
  `../Watchtower/tests/orchestrator/bootstrap.wsBridge.test.ts` (z posledního převzít pouze
  transportně nezávislé routing scénáře, ne současné WS zabezpečení).

**Jak převzít do Intersectu:**

1. Vytvořit `src/core/` jako nový TypeScript build target a přesunout do něj v první vertikální
   migraci `src/main/db/`, `src/main/pty/`, session index a attention pipeline. DB smí po migraci
   otevírat pouze core; Electron main nesmí držet druhé spojení.
2. Zachovat existující Intersect vertical slices. Watchtowerův velký `OrchRequest` union rozdělit
   do slice-local request map a složit do jednoho diskriminovaného wire kontraktu; nekopírovat
   monolitický switch v `orchestrator/index.ts` jako cílovou strukturu.
3. Obalit existující `IpcApi` rendereru transportním klientem, aby se veřejné slice API
   (`todo.add`, `timeTracking.getWeek`, …) nemuselo přepisovat. PTY data a resize vést přes
   samostatnou rychlou push cestu a zachovat dnešní pause/resume backpressure.
4. V Electron main ponechat file picker, práci s okny/Dock lifecycle, `shell.openExternal` a nativní
   notifikace. Vše ostatní routovat do core; seznam Electron-only operací musí být explicitní a
   testovaný.
5. Převzít restart gate a recovery banner, ale při restartu znovu hydratovat stav z SQLite a
   označit nezachované shell procesy jako přerušené. Claude session lze znovu spustit přes její
   uložené resume ID; neslibovat pokračování libovolného procesu po pádu core.
6. Změnit macOS lifecycle tak, aby zavření okna ponechalo Electron + core aktivní a kliknutí na
   Dock ikonu vytvořilo nové okno; `Cmd+Q` provede koordinovaný shutdown. Nevytvářet menu-bar ikonu
   ani tray menu. Samostatný LaunchAgent odložit, dokud nebude požadavek na companion fungující i
   po úplném ukončení Electron aplikace.
7. Dock badge zachovat jako jediný systémový indikátor a nastavovat jej z canonical počtu
   nevyřízených attention položek v core. Nula badge zcela odstraní; nesmí existovat paralelní
   rendererový čítač, který se po reloadu rozchází.

**Co výslovně nekopírovat:**

- `../Watchtower/orchestrator/wsBridge.ts` jako finální companion transport - používá přímé
  `ws://` spojení a bearer token bez schváleného E2E modelu Intersectu.
- `../Watchtower/electron/tray.ts` a jeho session/token menu - Intersect menu-bar ikonu nechce.
- Watchtower-specific `better-sqlite3`, Postgres/Supabase sync a TimeTracker absorption bootstrap;
  Intersect zachová `node:sqlite` a vlastní migrace.
- Jeden centrální orchestrátorový handler pro všechny funkce; hranice vertical slices Intersectu
  zůstávají vynucené.

### 9.2 Hook-based session state machine [schváleno]

**Co převzít:**

- `../Watchtower/orchestrator/stateMachine.ts` - čistou přechodovou funkci a oddělení stavů
  `working`, `waiting-permission`, `waiting-input`, `idle-notify`, `finished` a `crashed`.
- `../Watchtower/helper/watchtower-hook.ts` - neblokující helper: krátké timeouty, localhost POST,
  bearer autentizace a pravidlo „každá chyba končí úspěšně, Claude se nesmí zablokovat“.
- `../Watchtower/orchestrator/hookListener.ts` - localhost listener s limitem těla, allowlistem
  známých eventů, autentizací a hledáním volného portu.
- `hookCwdMatches`, `projectSessionDir`, `sessionFileExists` a `resolveResumeTarget` z
  `../Watchtower/orchestrator/sessionResume.ts` - ochranu proti tomu, aby hook vnořeného agenta
  přepsal resume ID rodičovské spravované session.
- Datové typy z `../Watchtower/packages/shared/src/stateModel.ts` a události/výstupy z
  `../Watchtower/packages/shared/src/events.ts`; názvy a výsledný union upravit podle domény
  Intersectu.
- Testy: `../Watchtower/tests/orchestrator/stateMachine.test.ts`,
  `../Watchtower/tests/orchestrator/hookListener.test.ts`,
  `../Watchtower/tests/helper/watchtowerHook.test.ts` a
  `../Watchtower/tests/orchestrator/sessionResume.test.ts`.

**Jak převzít do Intersectu:**

1. Umístit listener, state machine a raw hook event repository do headless core. Každé spravované
   Claude session předat v prostředí stabilní Intersect instance ID; helper je posílá v hlavičce
   a listener podle něj event routuje.
2. Zachovat dnešní per-session `--settings` generované v `src/main/pty/notifSettings.ts`, ale
   místo PTY markerů v nich spouštět zkopírovaný helper. Neměnit automaticky globální
   `~/.claude/settings.json`; Watchtower `hookInstaller.ts` proto není součástí tohoto transplantu.
3. U každého hook eventu porovnat payload `cwd` s kanonickým cwd instance. Eventy zděděné
   subagentem, skillem nebo pomocnou Claude session z jiného cwd uložit nanejvýš diagnosticky,
   ale nesmí měnit stav ani `claudeSessionId` rodiče.
4. Přechody řídit čistou funkcí. `Notification` znamená žádost o permission, `Stop` přechod do
   `waiting-input`, `UserPromptSubmit` návrat do `working` a skutečný PTY exit jediný autoritativní
   přechod do `finished`/`crashed`. `SessionEnd` je no-op pro terminální stav, protože vzniká také
   při `/clear`, `/compact`, auto-compaction a `/resume`.
5. Nad Watchtower stav přidat Intersect klasifikaci permission požadavku na běžný a nebezpečný.
   Klasifikace nesmí měnit základní lifecycle stav; je to atribut attention události používaný
   dashboardem, notifikací a companion potvrzením.
6. Dnešní `attentionDetector.ts` zachovat jako fallback: aktivuje se, když spravovaná session
   neposlala očekávané hook eventy, a jako výchozí zdroj pro budoucí CLI adaptéry bez nativních
   hooků. Při konfliktu má pro Claude Code hook vyšší prioritu.
7. Raw payloady ukládat s časem a instance ID pro diagnostiku, digest a activity pings. Nastavit
   retenční úklid; payloady se nesmějí bez filtrace posílat do cloudového LLM ani companion relay.

**Akceptační hrany převzaté z Watchtoweru:**

- hook helper nikdy nezpomalí ani nerozbije Claude Code, i když core neběží;
- opožděný `SessionEnd` neukončí živou session;
- hook vnořeného agenta nezmění stav ani resume ID rodiče;
- opakovaný stejný event nevytváří duplicitní notifikaci;
- pád PTY s nenulovým exit code skončí jako `crashed`, nikoli jako `waiting-input`.

### 9.3 Headless terminal snapshots a reattach [schváleno]

**Co převzít:**

- `../Watchtower/orchestrator/terminalSnapshots.ts` - per-session `@xterm/headless` buffer,
  čistý textový snapshot, ANSI serializaci, resize a dispose lifecycle. Zachovat výchozí limit
  200 řádků scrollbacku.
- `../Watchtower/orchestrator/terminalAttach.ts` - attach odpověď obsahující ANSI snapshot a
  aktuální rozměry PTY.
- Napojení `feed`, `flush`, `resize` a `dispose` z
  `../Watchtower/orchestrator/ptyManager.ts`; přizpůsobit existujícímu Intersect
  `SessionManager`, zejména jeho pause/resume backpressure.
- Pro pozdějšího druhého klienta převzít princip vlastnictví rozměrů z
  `../Watchtower/orchestrator/ptySizeOwnership.ts`, nikoli jej aktivovat dřív, než existuje
  companion.
- Testy: `../Watchtower/tests/orchestrator/terminalSnapshots.test.ts`,
  `../Watchtower/tests/orchestrator/terminalSnapshots.serialize.test.ts`,
  `../Watchtower/tests/orchestrator/terminalAttach.test.ts` a později
  `../Watchtower/tests/orchestrator/ptySizeOwnership.test.ts`.

**Jak převzít do Intersectu:**

1. Přidat do headless core `@xterm/headless` a `@xterm/addon-serialize` ve verzi kompatibilní s
   rendererovým xtermem. Každý PTY chunk nejprve zapsat do headless terminálu a potom odeslat
   připojeným klientům.
2. Pro každý živý session ID držet nejvýše jeden headless terminál se scrollbackem 200 řádků.
   Resize PTY promítnout také do headless bufferu; při definitivním odstranění session zavolat
   `dispose`, aby se mapa a addon neuvolňovaly až s procesem.
3. Přidat explicitní `terminal:attach` operaci. Nový renderer po hydrataci živých sessions získá
   `{ data, cols, rows }`, založí viditelný xterm z ANSI snapshotu a teprve potom pokračuje živým
   streamem. Attach musí mít otestované pořadí, aby chunk vzniklý během připojení nebyl ztracen ani
   zobrazen dvakrát.
4. Při zavření/reloadu rendereru PTY ani snapshot nerušit. Znovuotevření okna obnoví obrazovku,
   barvy a omezený scrollback bez respawnu procesu. Po pádu samotného core snapshot zaniká; návrat
   Claude session přes resume ID je nový proces, nikoli reattach původního PTY.
5. `snapshot()` po `flush()` používat jako volitelný lokální kontext pro attention notifikaci a
   diagnostiku. Text před zobrazením oříznout na několik posledních relevantních řádků a filtrovat
   zjevné secrets/escape sekvence.
6. Snapshot se nesmí automaticky poslat do cloudového LLM, plaintext relaye ani logu. Companion
   jej smí získat až přes schválený E2E kanál a jen na explicitní attach/otevření session.
7. Zachovat dnešní rendererový write-buffer watermark. Headless parsování nesmí zrušit
   pause/resume PTY ani vytvořit druhou neomezenou frontu dat.

**Akceptační scénáře:**

- zavřít okno, nechat agenta vypsat výstup, znovu otevřít a vidět posledních 200 řádků bez
  restartu session;
- reload rendereru nezdvojí řádky a neztratí chunk vzniklý během attach;
- resize před odpojením se při attach vrátí jako aktuální rozměr;
- ukončení/odstranění session uvolní headless terminál;
- vysoký objem výstupu stále aktivuje existující backpressure.

### 9.4 Activity pings a oddělení lidského času od agent runtime [schváleno]

**Co převzít:**

- `activeMinutesByDate`, `localDateStr` a `IDLE_CAP_MS` z
  `../Watchtower/orchestrator/services/autoTimeLogger.ts` - seřazení activity pingů, omezení
  každé mezery na deset minut, seskupení podle lokálního dne a zaokrouhlení na minuty.
- Z téže služby převzít projektové přiřazení podle canonical cwd, fallback na projektový
  catch-all a idempotentní external ID ve tvaru `auto:<instanceId>:<date>`; v Intersectu jej
  přejmenovat podle vlastní source taxonomie.
- `../Watchtower/orchestrator/db/repositories/hookEvents.ts` jako vzor zdroje activity pingů a
  `findByExternalId`/upsert chování z
  `../Watchtower/orchestrator/db/repositories/worklogs.ts` jako vzor deduplikace přepočtu.
- Testy algoritmu a idempotence z
  `../Watchtower/tests/orchestrator/autoTimeLogger.service.test.ts` a
  `../Watchtower/tests/orchestrator/autoTimeLogger.test.ts`.

**Co proti Watchtoweru změnit:**

- Watchtower výsledek `AutoTimeLogger` zapisuje rovnou jako worklog. Intersect jej uloží jako
  **agent activity evidence/runtime**, nikdy jako potvrzený lidský worklog ani přímý Toggl zápis.
- Paralelní agent runtime se sčítá pouze v agentních metrikách („tři agenti běželi hodinu“ = tři
  agent-hours). Lidská timeline používá sjednocení nepřekrývajících intervalů a za jednu hodinu
  kalendářního času nikdy nevykáže více než 60 minut.

**Jak převzít do Intersectu:**

1. Hook eventy ze sekce 9.2 používat jako activity pings. Pro staré/importované sessions bez hooků
   zachovat dnešní JSONL výpočet jako fallback označený nižší confidence.
2. Zavést oddělený datový typ/tabulku pro `agent_runtime_evidence` s instance/session ID, projektem,
   volitelným ticketem, lokálním dnem, minutami, confidence/source a stabilním external ID. Tato
   tabulka není Toggl outbox.
3. Přepočet musí být idempotentní: opakovaný `SessionEnd`, později nalezené eventy nebo ruční
   refresh aktualizují stejný záznam. Desetiminutový cap je výchozí hodnota, ne důkaz skutečné
   lidské aktivity.
4. Projekt přiřadit podle Project → repo folder vazeb; ticket primárně podle explicitního tagu
   session, sekundárně podle větve/Jira klíče. Neznámé vazby ponechat jako nezařazené evidence,
   nevytvářet kvůli nim automaticky trvalý projekt nebo ticket.
5. Lidskou timeline sestavit z aktivního/fokusovaného projektu, kalendáře a dalších pasivních
   signálů jako nepřekrývající intervaly. Agent evidence pomáhá předvyplnit kontext projektu a
   ticketu, ale neurčuje sama délku vykázané práce.
6. End-of-day reconcile ukáže vedle lidského bloku podpůrný údaj typu „2 agenti · 1 h 34 min
   runtime“. Teprve uživatelem potvrzený lidský blok se zapíše do Togglu.

**Akceptační scénáře:**

- tři paralelní hodinové sessions vytvoří tři agent-hours, ale nejvýše jednu hodinu lidské
  timeline;
- patnáctiminutová mezera mezi hooky přidá nejvýše deset minut agent runtime;
- opakovaný přepočet nevytvoří duplicitní evidence;
- session přes půlnoc vytvoří záznamy pro správné lokální dny;
- žádný agent runtime se bez explicitního reconcile neodešle do Togglu.

### 9.5 Resizable poměry jednoduchých terminal layoutů [schváleno]

**Rozhodnutí:** Intersect zachová čtyři dnešní layouty (`single`, `columns`, `rows`, `grid`).
Rekurzivní split strom Watchtoweru, drag-to-split zóny a zobrazení více projektů v jednom stromu se
nepřebírají. Převzata bude pouze možnost měnit a persistovat poměry panelů.

**Co převzít / z čeho vyjít:**

- Použití `PanelGroup`, `Panel`, `PanelResizeHandle`, `defaultSize` a `minSize` z
  `../Watchtower/apps/desktop/src/components/instances/WorkspaceNodeView.tsx`.
- `setSizes` a normalizaci procent z `../Watchtower/packages/shared/src/workspaceTreeOps.ts` jako
  inspiraci pro čistou funkci nad plochým Intersect layoutem.
- Debounced persistenci po změně layoutu z
  `../Watchtower/apps/desktop/src/state/useWorkspaceLayout.ts`; v Intersectu zapisovat přes
  workspace/project repository, nikoli obecné stringové settings klíče.

**Jak převzít do Intersectu:**

1. Přidat `react-resizable-panels` a v `SplitStage.tsx` nahradit pouze CSS rozdělení columns/rows
   komponentami `PanelGroup`. `single` nemá poměr; `columns` a `rows` mají dva podíly; `grid` má
   jeden poměr sloupců a samostatné poměry řádků pro obě poloviny, případně jeden společný poměr
   řádků, pokud se při implementaci potvrdí jednodušší UX.
2. Persistovat normalizované procentní podíly v projektovém terminal layoutu. Zápis debounce 500 ms
   během tažení a explicitní flush při `pointerup`, blur a zavírání okna.
3. Nastavit minimální velikost panelu 10 % podle Watchtoweru. Při neplatných, chybějících nebo po
   migraci nekompatibilních hodnotách použít rovnoměrné podíly.
4. Změna velikosti nesmí remountovat xterm; existující imperativní terminal controller pouze zavolá
   fit/resize po změně rozměru panelu.
5. Poměry jsou per projekt, nikoli globální. Přepnutí layoutu zachová poslední validní poměry pro
   jednotlivé typy, aby návrat z `single` do `columns` nevracel vždy 50/50.

**Co nekopírovat:**

- `../Watchtower/apps/desktop/src/components/instances/SplitDropZones.tsx`, rekurzivní
  `WorkspaceNodeView` renderování a tree operace `splitLeaf`/`unmountLeaf`;
- MUI stylování Watchtoweru - použít existující Intersect UI/CSS;
- ukládání layoutu do obecných stringových settings hodnot bez doménové validace.

**Akceptační scénáře:**

- uživatel změní 50/50 na 70/30, restartuje aplikaci a projekt se otevře jako 70/30;
- resize neztratí scrollback ani nerestartuje PTY;
- poškozená persisted hodnota bezpečně spadne na rovnoměrné rozdělení;
- změna poměrů v jednom projektu neovlivní jiný projekt.

### 9.6 Přímý read-only Jira sync [schváleno]

**Rozhodnutí:** současné načítání My Work přes skrytou Claude Code session se nahradí přímým Jira
REST klientem v headless core. Interaktivní browser SSO login Intersectu zůstává zdrojem uložené
session. Synchronizace nic nezapisuje do Jira.

**Co převzít:**

- `../Watchtower/orchestrator/services/jiraBoard.ts` - stránkování Agile board API, parser board
  URL/quick filtru, status mapování, načítání epic/custom fields, auth-expiry rozpoznání, stabilní
  snapshot a chybové envelope místo výjimek unikajících přes IPC.
- `../Watchtower/orchestrator/services/jiraSync.ts` - nízkoúrovňový HTTP wrapper, načtení cookie,
  Jira worklog/date pomocné funkce a diagnostiku error-chain. Převzít jen read operace.
- Čisté směrovací pomocníky z `../Watchtower/orchestrator/services/jiraRouting.ts`, zejména
  detekci area code, epic shortcut a glob matching; v Intersectu je použít pouze pro odvození
  vazeb, ne pro automatickou tvorbu lokální hierarchie.
- Rendererový stale-while-revalidate vzor z `../Watchtower/apps/desktop/src/state/useBoard.ts` a
  read-only board prezentaci z `../Watchtower/apps/desktop/src/components/timetracker/BoardTab.tsx`;
  komponenty přestylovat do Intersect UI a projektového kontextu.
- Testy: `../Watchtower/tests/orchestrator/jiraBoard.test.ts`,
  `../Watchtower/tests/orchestrator/jiraRouting.test.ts` a
  `../Watchtower/tests/client/useBoard.test.ts`.

**Jak převzít do Intersectu:**

1. Vytvořit v core Jira adapter s injektovaným `fetch`, clockem a session providerem. Nepřebírat
   Watchtower env-only `JIRA_BASE_URL`/Keychain konfiguraci; načíst base URL a cookies ze stávajícího
   Intersect SSO `storageState.json` a projektovou konfiguraci ze Settings/Project entity.
2. Projekt podporuje kanonický JQL filtr a volitelný board URL. Je-li board URL dostupný, převzít
   Agile board endpoint a quick filter chování. Jinak použít Jira search endpoint s projektovým JQL.
   V obou případech musí být výsledný payload normalizovaný do stejného `JiraIssueSnapshot`.
3. Synchronizovat minimálně key, summary, description, raw + normalizovaný status, priority,
   assignee, epic key/summary, estimate, components a remote `updated`. Stránkování má hard ceiling
   a čitelné partial/failure výsledky.
4. Přidat samostatnou SQLite cache/read model pro Jira issues s `fetched_at` a remote `updated`.
   Cache poskytuje stabilní ID pro vazby session ↔ ticket ↔ projekt, ale není lokálním CRUD task
   systémem. Watchtower automatické vytváření `epics`/`tasks` a přesouvání issue mezi nimi
   nekopírovat.
5. UI nejprve vykreslí poslední snapshot. Je-li starší než pět minut, spustí na pozadí jeden
   sdílený refresh; souběžní čtenáři nesmějí založit více fetchů. Ruční refresh je vždy dostupný.
6. Rozlišit `not-configured`, `auth-expired`, `network`, `partial` a `server` chyby. Při expiraci
   session nabídnout existující Intersect login flow; neotvírat přihlašovací okno automaticky.
7. Jira adapter je striktně read-only: nepřidávat transition, edit ani worklog POST endpointy.
   Přetažení karty pouze spouští lokální session. Jakýkoli budoucí Jira write vyžaduje nové
   rozhodnutí, preview a explicitní potvrzení uživatele.
8. `src/main/myWork/jiraFetch.ts` (hidden Claude), jeho report socket a spawn skript ponechat jednu
   přechodnou verzi za diagnostickým feature flagem. Po ověření přímého syncu odstranit, aby se při
   běžném načtení nespotřebovávaly tokeny ani nevyžadoval Jira skill.

**Co nekopírovat:**

- automatickou tvorbu Watchtower epic/task hierarchie a mazání lokálních board položek, které
  zmizely z posledního Jira výsledku;
- Jira worklog upload a jakékoli POST/PUT operace;
- konfiguraci vázanou na konkrétní Jira base URL, customfield ID nebo Keychain account kolegy;
- Watchtower status mapu jako pevnou univerzální pravdu - raw status zachovat a normalizovanou mapu
  konfigurovat per Jira instance/projekt.

**Akceptační scénáře:**

- otevření Kanbanu okamžitě ukáže cache a právě jeden background refresh, pokud je starší než pět
  minut;
- expirovaná SSO session nesmaže cache a nabídne ruční přihlášení;
- board URL s quick filtrem i čistý projektový JQL skončí ve stejném doménovém tvaru;
- neznámý Jira status se zobrazí s raw názvem a bezpečnou fallback kategorií;
- žádná cesta této služby nemůže změnit Jira issue nebo zapsat worklog;
- běžný sync nespustí Claude Code a nespotřebuje tokeny.

### 9.7 Claude Code configuration backend; Intersect UI od nuly [schváleno]

**Rozhodnutí:** převzít filesystem služby, parsery, kontrakty a testy Watchtoweru. Nepřebírat jeho
Settings React/MUI komponenty, navigaci ani informační architekturu. Intersect vytvoří vlastní
přehledné a praktické UI/UX jako vertical slice `agentTooling`, připravenou pro více adapterů.

**Co převzít:**

- `../Watchtower/orchestrator/services/claudeSettings.ts` - rozlišení global/project scope,
  čtení/parsing JSON, vytvoření chybějícího projektového souboru a timestampované zálohy před
  přepsáním.
- `../Watchtower/orchestrator/services/claudeSkills.ts` - procházení uživatelských i pluginových
  skill adresářů, čtení `SKILL.md` frontmatter a označení zdroje.
- `../Watchtower/orchestrator/services/claudeAgents.ts` - procházení uživatelských i pluginových
  agentů a parsing frontmatter polí name/description/model/tools.
- Request kinds `claudeSettings:read/write`, `skills:list` a `agents:list` z
  `../Watchtower/packages/shared/src/messagePort.ts` a odpovídající handlery v
  `../Watchtower/orchestrator/index.ts`; převést do Intersect slice-local core kontraktu.
- Testy `../Watchtower/tests/orchestrator/claudeSettings.test.ts` a
  `../Watchtower/tests/orchestrator/claudeSkills.test.ts`; pro agents doplnit stejnou testovací
  matici, protože Watchtower samostatný ekvivalentní coverage soubor nemá.

**Watchtower UI pouze jako behavior inventář, ne zdroj kódu:**

- `../Watchtower/apps/desktop/src/components/settings/GeneralTab.tsx`, `PermissionsTab.tsx`,
  `HooksTab.tsx`, `McpTab.tsx`, `SkillsTab.tsx`, `AgentsTab.tsx` a `RawTab.tsx` projít při návrhu,
  aby se neztratila podporovaná funkce. Žádnou z těchto komponent nekopírovat.

**Jak převzít backend do Intersectu:**

1. Umístit služby do headless core pod Claude adapter. Povolit pouze známé kořeny
   `~/.claude/settings.json` a `<project>/.claude/settings.json`; projektová cesta musí projít
   canonical/path-containment kontrolou proti repo vazbám daného Intersect projektu.
2. Před zápisem vrátit preview s current/proposed obsahem a strukturovaným diffem. Save přijme hash
   nebo revision původního obsahu; pokud se soubor mezitím změnil mimo Intersect, zápis odmítnout a
   nabídnout reload/merge.
3. Watchtower backup convention zachovat (`.bak.<YYYYMMDD-HHMMSS>`), ale samotný zápis zpřísnit:
   temp soubor ve stejném adresáři, zachování file mode, fsync podle možností a atomický rename.
   Neznámé JSON klíče se při structured editaci musí zachovat.
4. Intersect-managed hooks označit a upravovat cíleně; save jiného formuláře nesmí přepsat nebo
   odstranit uživatelské/pluginové hooky. Totéž platí pro MCP a enabled plugins.
5. Skills a agents jsou v první verzi read-only katalog s cestou, zdrojem (user/plugin), stavem a
   možností otevřít soubor. Pluginové položky jasně označit jako externě spravované; Intersect je
   nepřepisuje ani nemaže.
6. Raw JSON editor ponechat jako pokročilou cestu se syntax/shape validací, diff preview a stejnou
   concurrency ochranou. Nikdy nezapisovat nevalidní JSON.

**UI/UX od nuly:**

1. Nová `Agent tooling` oblast ve Settings má adapter selector; první adapter je Claude Code.
2. Informační architektura: Overview / Permissions / Hooks / MCP / Skills / Agents / Advanced.
   Global/project scope je stále viditelný v hlavičce a UI jasně ukazuje, zda hodnota pochází z
   globálu, projektu nebo defaultu.
3. Běžné operace používají strukturované formuláře, searchable seznamy, empty/error stavy a
   kontextovou nápovědu. Raw editor není výchozí obrazovka.
4. Každý zápis ukáže diff a vyžádá potvrzení, zvlášť pro global scope. Úspěch zobrazí cestu zálohy
   a nabídne jednorázové Undo obnovením právě vytvořené zálohy.
5. UI implementovat v existujícím Intersect design systému/CSS bez MUI a bez importu Watchtower
   komponent. Dodržet renderer slice hranice a tenké IPC hooky/store.

**Akceptační scénáře:**

- projekt bez `.claude/settings.json` jej vytvoří až po potvrzeném save, nikoli při pouhém čtení;
- externí změna mezi preview a save není přepsána;
- structured edit jednoho permission pravidla zachová neznámé klíče, hooks a MCP;
- každý zápis vytvoří použitelnou zálohu a Undo obnoví přesný předchozí obsah;
- plugin skill/agent je dohledatelný, ale nelze jej omylem přepsat jako user-owned;
- žádná Watchtower MUI komponenta ani její UX struktura není součástí výsledné implementace.

### 9.8 Primární pracovní položka session [schváleno]

**Co převzít:**

- Persistovanou vazbu instance → task a metodu `setTask` z
  `../Watchtower/orchestrator/db/repositories/instances.ts` jako minimální repository vzor.
- Request `instances:setTask` z `../Watchtower/packages/shared/src/messagePort.ts`, handler v
  `../Watchtower/orchestrator/index.ts` a tenký klientský callback v
  `../Watchtower/apps/desktop/src/state/useInstances.ts`.
- Preselection projektu podle nejdelší odpovídající cwd z
  `../Watchtower/apps/desktop/src/components/instances/InstanceTaskPickerDialog.tsx`; výpočet
  přesunout do core/shared čisté funkce a rozšířit o více repo vazeb a worktree parent.
- Testy round-trip/set/clear z `../Watchtower/tests/orchestrator/instancesRepo.test.ts` a napojení
  na auto-time scénáře z `../Watchtower/tests/orchestrator/autoTimeLogger.service.test.ts`.

**Co proti Watchtoweru změnit:**

- Nepoužít úzký nullable integer `task_id`. Intersect zavede obecnou hodnotu `WorkItemRef` s
  `source`, stabilním externím ID, projektovým ID a snapshotem key/title/type. Zdroj může být
  `jira`, `todo`, `ado-pr` nebo budoucí adapter.
- Vazba je jedna primární pracovní položka; automaticky nalezená větev, PR a další vztahy jsou
  sekundární linky v pracovním grafu a primární položku samy nepřepisují.
- Watchtower picker komponentu nekopírovat přímo. Intersect použije vlastní rychlý searchable
  picker/command palette se společnými výsledky ze všech podporovaných zdrojů.

**Jak převzít do Intersectu:**

1. Přidat k persistované session primární work-item referenci. Preferovat normalizovanou link
   tabulku nebo serializovatelný polymorfní klíč s integritními pravidly; remote snapshot key/title
   uchovat, aby historie zůstala čitelná po smazání nebo zmizení položky ze syncu.
2. Spawn API přijímá volitelný `primaryWorkItem`. Launch z Jira/TODO/PR karty jej předá v téže
   transakci jako vznik session, aby nikdy nevznikla krátká nezařazená session kvůli race condition.
3. Ruční session nabídne neblokující picker dostupný z tabu i command palette. Výsledky seskupit
   podle projektu/zdroje, podporovat hledání key i title a předvybrat projekt podle canonical cwd,
   více repo vazeb a worktree parent.
4. `setPrimaryWorkItem` podporuje assign/change/clear a zapisuje audit/history event. Změna ovlivní
   budoucí agent evidence a návrhy reconcile; již potvrzené worklogy zpětně nepřepisuje.
5. Primární položka řídí výchozí název session, zobrazený chip, projekt/ticket kontext promptu,
   agent runtime evidence a předvyplnění end-of-day reconcile. Uživatel může název session změnit
   bez ztráty vazby.
6. Remote refresh aktualizuje zobrazovaný snapshot pouze pokud položka stále existuje. Not-found
   zachová poslední snapshot a označí referenci jako stale/missing; session ani historie se nemaže.

**Akceptační scénáře:**

- spuštění z Jira karty vytvoří session už s Jira referencí a správným projektem;
- ruční shell/Claude session lze připojit k TODO nebo PR a později vazbu změnit či zrušit;
- nalezené PR na stejné větvi nepřepíše explicitně zvolenou Jira položku;
- zmizení issue z Jira cache neznečitelnění historickou session;
- změna primární položky neupraví již potvrzené Toggl worklogy.

### 9.9 Suspend při ukončení a bezpečný resume při startu [schváleno]

**Co převzít:**

- Quit guard a výpis živých sessions z `../Watchtower/electron/main.ts` - zachycení
  `before-quit`, modal „Suspend & quit / Cancel“ a rozlišení živých stavů.
- `hookCwdMatches`, `projectSessionDir`, `sessionFileExists` a `resolveResumeTarget` z
  `../Watchtower/orchestrator/sessionResume.ts` - ověření, že stored Claude session skutečně
  existuje pod správným projektovým cwd, a bezpečný fallback.
- Persistované stavy/reasons `suspended`, `resuming`, `app-quit-suspend`, `resume-failed` a
  `no-session-id` z `../Watchtower/packages/shared/src/stateModel.ts`.
- Boot respawn orchestration z `../Watchtower/orchestrator/index.ts`; převzít sekvenci a ochrany,
  ne jeho centrální handler strukturu.
- Testy `../Watchtower/tests/orchestrator/sessionResume.test.ts`,
  `../Watchtower/tests/orchestrator/stateMachine.test.ts` a relevantní boot scénáře z
  `../Watchtower/tests/orchestrator/bootstrap.test.ts`.

**Jak převzít do Intersectu:**

1. `Cmd+Q` se živými sessions nejprve načte canonical seznam z core a nabídne „Pozastavit a
   ukončit“ / „Zrušit“. Potvrzený quit v jedné DB transakci označí živé Claude sessions jako
   `suspended` s termination reason; až potom koordinovaně ukončí PTY, služby, DB a core.
2. Zavření posledního okna tuto cestu nespouští: Electron + původní core/PTY zůstávají živé a
   okno se obnoví přes Dock `activate`. Menu-bar/tray ikona neexistuje.
3. Při bootu core vyhledá suspended Claude sessions. Stored resume ID použije pouze tehdy, když
   odpovídající JSONL existuje pod canonical project session adresářem daného cwd. Cizí ID
   zděděné z nested agenta se nesmí použít.
4. Respawn zachová Intersect session identitu, projekt, primární `WorkItemRef`, uživatelský název a
   další graph vazby, ale vytvoří nový OS/PTY proces. UI zobrazí „obnoveno po ukončení“, aby bylo
   zřejmé, že terminálový buffer/proces není původní.
5. Shell taby lze po startu znovu otevřít jako čistý login shell v původním cwd, nikdy však jako
   pokračování rozepsaného příkazu, dev serveru nebo jiné child process tree. Výchozí politika je
   automaticky nespouštět dřívější shell command.
6. Chybějící transcript, cwd nebo neúspěšný spawn skončí jako recoverable `resume-failed` s akcemi
   „spustit novou session“, „vybrat složku“ a „archivovat“. Nesmí vzniknout nekonečný boot loop.
7. Settings obsahuje přepínač automatického resume po potvrzeném suspend; při vypnutí boot pouze
   zobrazí suspended položky a uživatel je obnoví ručně.

**Akceptační scénáře:**

- zavření okna a jeho znovuotevření používá původní PTY; `Cmd+Q` + nový start používá nový PTY s
  Claude resume;
- nested-agent session ID z jiného cwd se nikdy nepoužije;
- primární pracovní položka a projekt přežijí suspend/resume;
- shell s běžícím dev serverem se po startu neprezentuje jako pokračující server;
- neplatné resume ID nevytváří crash loop a nabízí ruční recovery.
