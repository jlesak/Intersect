# Intersect - finální podoba: Personal Work OS

Vysokoúrovňová produktová specifikace cílové podoby celé aplikace. Datum: 2026-07-07.
Status: **schváleno** (interview + Lavish review; otevřené otázky rozhodnuty, roadmap schválena beze změn).

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

## 3. Feature pilíře

Legenda: **[existuje]** implementováno · **[spec]** schválená spec čeká na implementaci ·
**[evoluce]** rozšíření existujícího · **[nové]** nová oblast.

### 3.1 Dashboard [nové]

Domovská obrazovka = "co mě teď potřebuje", ne přehled všeho. Čtyři sekce:

- **Sessions:** typované attention stavy - *čeká na odpověď* / *chce nebezpečné povolení*
  (vizuálně alarmující, jiná třída notifikace) / *doběhla* / *spadla* / *osiřelý proces* - s cenou
  a projektem. Schválení destruktivní akce vypadá jinak než "kterou variantu chceš?".
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
  Jira filtr (např. `project = FID2507`), ADO repo(s), Toggl projekt.
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
- Přesun do *Review* → diff seskupený podle logických celků (ne abecedně podle souborů),
  **inline komentáře putují zpět agentovi** bez zastavení jeho práce.
- **Sync do živého checkoutu**: otestovat změny agenta z worktree v reálném prostředí
  (dev server, .env, node_modules) bez merge.
- Session ↔ větev ↔ PR ↔ ticket ↔ čas = jeden provázaný, dohledatelný objekt. Merge PR
  session auto-archivuje a zapíše do digestu.
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

## 4. UX shell

- **Ikonový rail vlevo:** Dashboard nahoře, piny projektů (se status tečkou agregující jejich
  sessions), pak globální sekce Lidé / TODO / Čas, Settings dole.
- **Projektový kontext** po kliknutí na pin: terminály (taby, splity - dnešní UX) + Kanban /
  PRka / Worktrees / Přehled.
- **Klávesnice první**, myš druhá. Globální capture zkratka funguje celosystémově.
- **Notifikace:** typované attention stavy + presence suppression; nastavení drží jednoduchost
  "při dokončení" / "při potřebě akce" (+ per stav, dle Settings spec).
- Mockup schválen v Lavish review: `.lavish/intersect-final-form.html`, sekce 04.

## 5. Architektura a tech stack

- **Zůstává:** Electron + React 19 + TypeScript + Zustand + node-pty + node:sqlite,
  vertical slices s ESLint hranicemi. Žádný přepis na Tauri - u osobní appky se RAM platí jen
  sobě a přepis by zahodil investici.
- **Mění se:** jádro (PTY manager, DB, integrace, notifikace/digest, orchestrátor, sjednocený
  index, AI router) se vytáhne z Electron main procesu do **headless core** - samostatného Node
  procesu s typovaným API (IPC pro renderer, WebSocket pro companion relay). Electron UI
  i mobilní companion jsou jen dva klienti téhož jádra; core běží i se zavřeným oknem,
  takže push funguje dál.
- **AI router:** jedno místo rozhoduje lokální (LM Studio / OpenAI-kompatibilní API) vs. cloud
  (Claude) podle typu úlohy; embeddingy a klasifikace vždy lokálně.
- **Integrace:** Azure DevOps (PAT), Jira/Confluence (browser-session SSO mechanismus převzatý
  z existujících skillů, stav připojení viditelný v Settings), Notion, Slack, M365 kalendář, Toggl.
- Architektonický diagram schválen v Lavish review: `.lavish/intersect-final-form.html`, sekce 05.

## 6. Roadmap (schváleno beze změn)

| Fáze | Obsah | Hodnota po dokončení |
|---|---|---|
| **F0** | Dokončit schválené specky: TODO (#4), Settings (#8), PR Inbox v2 (#7), 1:1 workflows (#5, bez Person Pages) | Uzavřené issues, stavební kameny (TODO pro capture, Settings pro konfiguraci) |
| **F1** | Projekty + nový shell: deštníková entita, vazby, auto-přiřazování, ikonový rail, projektové kontexty, migrace workspaces | Pojivo pro všechno další |
| **F2** | Dashboard + digest + cost meter: čtyři sekce, typované attention stavy, snooze, presence suppression, tokeny/cena per session; digest = první lokální LLM use-case | Nový domov appky |
| **F3** | Orchestrace: spuštění z karty (hlavní checkout default, worktree opt-in), diff review s komentáři zpět, sync do živého checkoutu, provázání session↔PR↔ticket, auto-archiv po merge | Karta = agent |
| **F4** | Lidé + quick capture: Person Pages, auto-Briefy, navázání 1:1 na osoby, globální capture zkratka | Manažerská vrstva |
| **F5** | Čas: pasivní timeline + end-of-day reconcile do Togglu, plán vs. realita | Konec ručního timesheetu |
| **F6** | Headless core + AI asistent: extrakce jádra, typované API, sjednocený index s embeddingy, konverzační asistent, multi-agent adaptery (OpenCode) | Základ pro companion, paměť nad prací |
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
