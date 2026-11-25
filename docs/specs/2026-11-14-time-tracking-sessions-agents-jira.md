# Time Tracking 2 - sessions, agenti a upload do Jiry

Specifikace pro vývojové agenty. Datum: 2026-11-14. Status: rozhodnutí vlastníka uzavřená
(interview 2026-11-14), čeká na rozdělení do GitHub issues.

Navazuje na `docs/specs/2026-07-06-time-tracking-design.md`. Kde se liší, platí tento dokument.

## 1. Cíl

1. Každá Claude Code session se trackuje automaticky. Karta ukazuje popis práce, issue klíč, čas
   a Resume, dokud je transcript čitelný. Název session, složka a git branch zůstávají uložené pro
   Haiku, ale na kartě se nezobrazují. Haiku doplní krátké shrnutí a určí, jestli šlo o pracovní věc.
2. Vlastník jednoduše upraví a seskupí karty v Intersectu.
3. Claude a Codex agenti čtou a zapisují záznamy přes CLI `intersect-time`.
4. Tlačítko nahraje jeden den do Jiry jako worklogy.
5. Zápis do Jiry je technicky omezený jen na worklogy. Nic jiného v Jiře měnit nejde.

## 2. Analýza současného stavu

### Co existuje

| Oblast | Stav | Soubory |
|---|---|---|
| Auto karty | Odvozené při každém čtení ze `SessionIndex` (`~/.claude/projects/<dir>/<id>.jsonl`, jedna úroveň, takže subagent transcripty se nepočítají). Pokrývá i sessions z desktop app a VS Code, ne jen terminály Intersectu. | `src/core/timeTracking/timeTracking.ts`, `src/core/sessions/sessionIndex.ts` |
| Čas karty | `activeDurationMs`: součet mezer mezi zprávami, mezera nad 10 min se počítá jako 10 min. | `src/core/sessions/sessionParse.ts` |
| Den karty | Lokální den `lastTimestamp`. Celá session padne na poslední den aktivity. Víkend se vynechá. | `timeTracking.ts:getWeek` |
| Popis | `autoDescription`: AI title nebo první prompt, očištěný od XML a ANSI, max 140 znaků. Žádný model. | `src/core/timeTracking/worklogDescription.ts` |
| Issue klíč | Regex z git branch. | `src/core/timeTracking/issueKey.ts` |
| Úložiště | Jen `time_entry_manual`, `time_entry_override` (editace a tombstone auto karty podle session id) a `running_timer`. O session samotné se nic neukládá. | `src/core/db/timeTrackingRepo.ts`, `src/core/db/migrations.ts` |
| Editace | Popis, issue klíč a čas inline na každé kartě, mazání, ruční karta, timer. | `src/renderer/src/features/timeTracking/` |
| Export | Týden jako TSV nebo CSV do schránky. | `weekExport.ts` |
| Agent runtime | Oddělená evidence z hooků, jen pro sessions spuštěné v Intersectu. Umí aktivní minuty po dnech. | `src/core/agentRuntime/` |
| Jira | Jen čtení, by construction. SSO cookies z `~/.claude/jira/storageState.json`, host v konstantě `JIRA_HOST`. Žádný worklog. | `src/core/myWork/jiraClient.ts`, `jiraSession.ts` |
| Lokální MCP a socket vzor | `draftServer`, `otoReportServer`, `jiraReportServer` posílají data do core přes Unix socket. | `src/core/prInbox/`, `src/core/oneOnOne/`, `src/core/myWork/` |
| Headless `claude` vzor | `jiraSpawn` spouští `claude -p` se `--strict-mcp-config` a omezeným MCP. | `src/core/myWork/jiraSpawn.ts` |

### Mezery a chyby

1. **Ztráta historie.** Auto karta žije jen, dokud existuje `.jsonl`. Claude Code maže staré
   transcripty (`cleanupPeriodDays`, výchozí hodnota podle dokumentace Claude Code 30 dní, ověřit).
   `refreshWeek` pak volá `overrides.pruneAbsent` a smaže i uživatelovy editace. Starší týdny
   tiše ztrácí čas. Pro upload do Jiry je to neakceptovatelné.
2. **Session přes více dní.** Session obnovená další den (`claude --resume`) přesune celou kartu na
   nový den. Včerejší den se zpětně změní.
3. **Žádný snapshot kontextu.** Karta nezobrazuje složku ani branch, i když je `SessionSummary` má.
4. **Popis není shrnutí.** První prompt často neříká, co se v session udělalo.
5. **Žádné API pro agenty.** Zápis jde jen z renderer IPC.
6. **Žádný zápis do Jiry** a žádná evidence, co bylo odesláno.
7. **Žádné seskupení karet**, žádný filtr krátkých nebo automatizačních sessions. Do boardu padají
   i sessions, které spouští sám Intersect (PR review worktrees, skryté běhy).
8. **`docs/agents/product.md`** má mezi zamítnutými položkami "automatic worklogs". Tento dokument
   to mění: auto karty a upload tlačítkem jsou schválené. Upload sám od sebe (bez kliknutí) zůstává
   zamítnutý. Issue 1 product.md upraví.

Mimo scope, ale k nahlášení: `src/core/myWork/jiraMapping.ts` má v public repu hostname firemní
Jiry. Nový kód nesmí přidat další výskyt. Host se bere jen z `JIRA_HOST`.

## 3. Rozhodnutí vlastníka

| # | Téma | Rozhodnutí |
|---|---|---|
| D1 | Jira API | Standardní worklog: `POST/PUT/DELETE /rest/api/2/issue/{key}/worklog[/{id}]`. Žádné Tempo. |
| D2 | Granularita uploadu | 1 karta = 1 worklog. Skupina karet = 1 worklog. |
| D3 | Karta bez issue klíče | Blokuje upload dne. Vlastník ji přiřadí k issue, nebo označí "neodesílat". |
| D4 | Změna po uploadu | Re-sync. Karta má stav "změněno po uploadu". Další upload volá PUT nebo DELETE jen na worklog ID, které Intersect sám vytvořil. |
| D5 | Seskupení | Ruční skupina karet jednoho dne. Čas = součet, popis = spojené popisy, obojí jde přepsat. Skupina jde rozdělit. Akce "Seskupit den podle issue" jedním klikem. |
| D6 | Haiku | Headless `claude -p --model haiku` na předplatném vlastníka. Žádný API klíč. |
| D7 | Kdy shrnout | Background scan každých 10 min. Shrnout session a den bez aktivity 30+ min, bez shrnutí nebo s novou aktivitou od posledního shrnutí. Fronta, max 1 běh najednou. Tlačítko "Přegenerovat". |
| D8 | Vyloučení | Vždy vynechat sessions, které spouští Intersect sám. V nastavení seznam prefixů cest k vynechání. Subagent transcripty se nepočítají. |
| D9 | Krátké sessions | Session a den s aktivním časem pod 5 min nedostane kartu vůbec. Platí jen pro auto karty. |
| D10 | Agent rozhraní | Jen CLI `intersect-time`. Žádné MCP. |
| D11 | Práva CLI | list, add, edit, group, ungroup, delete. Každý zápis nese aktéra a jde do audit logu. CLI neumí upload do Jiry. Agent nemění karty, které už jsou v Jiře. |
| D12 | Pracovní / nepracovní | Haiku klasifikuje. Nepracovní karta má pill a flag. Upload ji vynechá. Vlastník ji smaže nebo označí "Je pracovní" (flag zmizí a Haiku ho znovu nenastaví). |
| D13 | Zaokrouhlení | Při uploadu: pod 15 min na 15 min, jinak nahoru na násobek 30 min. Board ukazuje přesný čas. |
| D14 | Komentář worklogu | Jen popis karty. Název session, složka a branch zůstávají lokálně. |
| D15 | Jazyk shrnutí | Čeština, jedna věta, max 140 znaků, děj. Žádné cesty, tokeny ani jména lidí. |
| D16 | Session přes více dní | Karta za session a den. Aktivní čas se dělí podle dnů. Haiku shrnuje jen práci daného dne. Nahraný den se zpětně nemění. |

### Rozhodnutí implementace (agent může změnit, musí to uvést v PR)

- `started` worklogu: auto karta = první aktivita session v daném dni. Ruční karta a skupina =
  09:00 lokálního času, nebo nejdřívější `started` členů skupiny.
- CLI bez běžící aplikace skončí chybou (exit 3). Žádná offline fronta.
- CLI se do `PATH` dostane jen tlačítkem v Settings, které vytvoří shim `~/.local/bin/intersect-time`.
  Aplikace nic neinstaluje sama.
- Aktér v CLI: povinný `--actor claude|codex|user`.

## 4. Datový model

Nové tabulky v jedné migraci na issue, které je potřebuje. Názvy jsou návrh.

**`tracked_session_day`** - snapshot auto karty. Zdroj pravdy pro auto karty místo odvození při čtení.

| Sloupec | Význam |
|---|---|
| `session_id`, `day` | PK. Jedna karta za session a den (D16). |
| `title`, `cwd`, `git_branch` | Snapshot ze `SessionSummary` při posledním scanu. |
| `first_activity_at`, `last_activity_at` | Epoch ms, v rámci dne. |
| `active_ms` | Aktivní čas dne (pravidlo mezery 10 min, počítané po dnech jako `activeMinutesByDate`, ale v ms). |
| `summary`, `summary_status` | Haiku věta. Status `pending`, `done`, `failed`. |
| `summarized_through` | `last_activity_at`, ke kterému shrnutí platí. Novější aktivita = nové shrnutí. |
| `is_work` | `1`, `0`, nebo NULL (ještě neklasifikováno). |
| `work_confirmed` | `1`, když vlastník klikl "Je pracovní". Haiku pak `is_work` nemění. |

Pravidla:
- Scan řádky vkládá a aktualizuje, nikdy nemaže, když transcript zmizí. `pruneAbsent` se pro
  overrides ruší.
- Session a den pod 5 min aktivního času (D9) se neuloží. Když později přeroste 5 min, uloží se.
- Vyloučené sessions (D8) se neuloží.
- `time_entry_override` dostane klíč `(session_id, day)`. Migrace převede existující řádky na den
  podle `lastTimestamp`.

**`time_entry_group`** a **`time_entry_group_member`**
- Skupina: `id`, `day`, `description`, `issue_key`, `duration_override_ms` (NULL = součet členů),
  `created_at`.
- Člen: `group_id`, `entry_kind` (`auto`, `manual`), `entry_id`. UNIQUE na `(entry_kind, entry_id)`:
  karta je max v jedné skupině.
- Invarianty: všichni členové mají stejný den jako skupina. Skupina má aspoň 2 členy. Rozdělení
  smaže skupinu, členové se vrátí jako samostatné karty.

**`time_entry_upload_flag`** - per karta nebo skupina: `do_not_upload` (D3).

**`jira_worklog_ledger`** - co Intersect v Jiře vytvořil.

| Sloupec | Význam |
|---|---|
| `id` | Lokální PK. |
| `entry_kind`, `entry_id` | `auto`, `manual`, `group`. |
| `day`, `issue_key` | Kam worklog patří. |
| `worklog_id` | ID z Jiry. NULL, dokud je stav `pending`. |
| `state` | `pending` (záměr zapsán před requestem), `synced`, `deleted`, `failed`. |
| `sent_seconds`, `sent_comment`, `sent_started` | Přesně to, co bylo odesláno. |
| `updated_at`, `last_error` | Diagnostika. |

**`time_entry_audit`** - `ts`, `actor` (`ui`, `claude`, `codex`, `user-cli`, `haiku`, `jira-upload`),
`action`, `entry_ref`, `before_json`, `after_json`. Jen pro zápis, žádné UI v tomto rozsahu.

## 5. Funkce

### 5.1 Auto tracking a snapshot (issue 1)

- Scan `SessionIndex` při startu, při `refreshWeek` a každých 10 min na pozadí.
- Pro každou session spočítat aktivní čas po dnech z časových značek zpráv. Uložit `tracked_session_day`.
- Vyloučit:
  - cwd pod adresářem dat Intersectu (`app.getPath('userData')` předané z main, nebo ekvivalent v core),
  - sessions, které Intersect spustil headless (PR review, Jira fetch, 1:1, Haiku). Haiku běhy mají
    `--no-session-persistence`, takže transcript nevznikne,
  - prefixy cest ze Settings (nový klíč `timeTracking.excludedPathPrefixes`, pole stringů).
- Víkend: data se ukládají, board je dál nezobrazuje (beze změny pravidla Po-Pá).
- Karta zobrazí: jednořádkové shrnutí (nebo `autoDescription`, dokud shrnutí není), issue klíč,
  čas a Resume, dokud je transcript čitelný. Název session, `folderName`, branch a `cwd` zůstávají
  uložené jako vstup pro Haiku, ale na kartě ani v tooltipu se nezobrazují.

### 5.2 Haiku shrnutí a klasifikace (issue 2)

Spuštění, vždy jako pole argumentů, nikdy přes shell:

```
claude -p --model haiku --tools "" --strict-mcp-config --mcp-config '{"mcpServers":{}}'
  --no-session-persistence --output-format json --system-prompt <pevný prompt>
```

- `--bare` nepoužít: neumí OAuth předplatné, jen `ANTHROPIC_API_KEY`.
- Ověřit ve spike testu: že user hooky a pluginy neběží (zkusit `--setting-sources ""` nebo
  `--settings` s prázdnými hooky) a že výstup `--output-format json` má očekávaný tvar. Výsledek
  zapsat do PR. Pokud izolaci hooků nejde zaručit, zastavit a zeptat se vlastníka.
- `cwd` procesu: prázdný dočasný adresář, ne složka session.
- Timeout 60 s, kill při překročení. Max 1 běh najednou. Při 3 chybách po sobě pauza 30 min.
- Vstup na stdin, max 12 000 znaků:
  - název session, `folderName`, branch, den,
  - user prompty toho dne (očištěné jako `sanitizeWorklogDescription`, bez limitu na 1 větu),
  - první řádky assistant odpovědí toho dne,
  - redakce: řetězce, které vypadají jako tokeny nebo klíče (`sk-`, `ghp_`, `xox`, `AKIA`,
    `-----BEGIN`, JWT, dlouhé hex/base64), nahradit `[redacted]`.
- Vstup je nedůvěryhodný text. Systémový prompt to řekne a výstup se validuje bez ohledu na obsah.
- Výstup: JSON `{ "summary": string, "isWork": boolean }`.
- Validace výstupu (vše musí projít, jinak `summary_status = failed` a karta drží `autoDescription`):
  - validní JSON, přesně dva klíče, správné typy,
  - `summary` 1 řádek, 3 až 140 znaků, obsahuje písmeno,
  - žádné URL, žádná absolutní cesta, žádný řetězec, který chytí redakční regex,
  - žádné `<`, `>` (zbytky markup).
- `is_work` se zapíše, jen když `work_confirmed = 0`.
- Uživatelova editace popisu (override) má vždy přednost před shrnutím. Přegenerování ji nepřepíše.
- UI: pill "nepracovní" a flag na kartě. Akce na kartě: "Je pracovní", "Přegenerovat".

### 5.3 Ruční editace a seskupení (issue 3)

- Zachovat inline editaci popisu, issue klíče a času na každé kartě i skupině.
- Výběr více karet v jednom dni (klik se Shift nebo Cmd), akce "Seskupit". Kontrola se ukáže jen při
  výběru 2+ karet (pravidlo minimálního UI).
- "Seskupit den podle issue": jeden klik v hlavičce dne. Spojí karty se stejným issue klíčem, které
  ještě nejsou ve skupině. Karty bez klíče a nepracovní karty nechá být.
- Skupina: čas = součet členů, dokud ho vlastník nepřepíše. Popis = unikátní popisy členů spojené
  "; ", zkrácené na 255 znaků. Issue klíč = společný klíč, jinak prázdný.
- Rozbalení skupiny ukáže členy jen pro čtení. "Rozdělit" skupinu zruší.
- Smazání člena skupiny ho ze skupiny odebere. Skupina s 1 členem se rozpustí.
- Denní a týdenní součty počítají skupinu jednou, ne členy navíc.
- Nepracovní karty se do denního součtu počítají, ale vizuálně odlišeně. Upload je vynechá (D12).

### 5.4 CLI `intersect-time` (issue 4)

Transport:
- Core otevře Unix socket v adresáři dat aplikace. Adresář `0700`, socket `0600`.
- Token: náhodných 32 bytů, soubor `0600` vedle socketu, nový při každém startu aplikace.
- CLI přečte token ze souboru a pošle ho v každém požadavku. Bez tokenu nebo se špatným: odmítnout.
- Protokol: jeden JSON požadavek na spojení, max 16 KB, timeout 2 s.
- Routovací tabulka socketu obsahuje jen příkazy níže. Žádný příkaz pro Jiru, settings, transcripty
  ani timer.
- CLI je bundlovaný skript (`out/main/timeCli.js`), spouštěný přes `ELECTRON_RUN_AS_NODE=1` jako
  `hookHelper`. Shim v `~/.local/bin` vytvoří jen tlačítko v Settings.

Příkazy:

```
intersect-time list   --day YYYY-MM-DD [--json]
intersect-time add    --actor A --day YYYY-MM-DD --duration 1h30m --description "..." [--issue KEY]
intersect-time edit   --actor A <ref> [--duration ..] [--description ..] [--issue KEY|--no-issue]
intersect-time delete --actor A <ref>
intersect-time group  --actor A <ref> <ref>... [--description ..] [--issue KEY]
intersect-time ungroup --actor A <group-ref>
```

- `<ref>` = `auto:<sessionId>:<day>`, `manual:<id>`, `group:<id>`. `list --json` je vrací.
- Validace na serveru (core), ne jen v CLI:
  - den `YYYY-MM-DD`, platné datum, max 31 dní zpět, ne v budoucnosti,
  - délka 1 min až 12 h, formát `1h30m`, `45m`, `2h`,
  - popis 1 až 255 znaků po trim, bez řídicích znaků,
  - issue klíč `^[A-Z][A-Z0-9]+-[1-9][0-9]*$` po převodu na velká písmena,
  - aktér z enumu,
  - max 60 zápisů za minutu, pak odmítnout.
- Karta nebo skupina se stavem `synced` v ledgeru: edit, delete, group a ungroup z CLI skončí exit 4.
- Exit kódy: 0 ok, 2 validace, 3 aplikace neběží, 4 zakázáno, 1 jiná chyba. Chyby na stderr,
  jedna věta.
- Každý zápis jde do `time_entry_audit` s aktérem.
- Renderer se po zápisu z CLI obnoví. Time tracking dnes žádný broadcast nemá, přidat nový kanál
  podle vzoru `sourced: 'core'` v `src/common/coreBridge.ts`.
- Dokumentace pro agenty: krátká sekce v README nebo `intersect-time --help` s příklady.

### 5.5 Upload dne do Jiry (issue 5)

Tok:
1. Tlačítko "Nahrát do Jiry" v hlavičce dne.
2. Core spočítá plán (čistá funkce, bez sítě):
   - kandidáti = karty a skupiny dne, bez `do_not_upload`, bez `is_work = 0` (pokud není
     `work_confirmed`),
   - blokace: karta bez issue klíče a bez `do_not_upload` (D3). Plán se nevrátí, UI ukáže seznam.
   - čas podle D13,
   - diff proti ledgeru: nový kandidát = POST; změněný čas, komentář nebo `started` = PUT; jiný issue
     klíč = DELETE starého + POST nového; záznam v ledgeru bez kandidáta (smazaná, seskupená,
     vyřazená karta) = DELETE.
3. Náhled v dialogu: každá operace jedním řádkem (POST, PUT, DELETE, issue, čas, komentář), součet
   dne. Tlačítko "Odeslat" a "Zrušit".
4. Po potvrzení core provede operace postupně. Před každým POST zapíše řádek `pending`. Po úspěchu
   uloží `worklog_id` a `synced`. Chyba = `failed` + zpráva, zbytek pokračuje.
5. Výsledek v dialogu. Karty mají stav: nenahraná, nahraná, změněno po uploadu, chyba.

Obnova po pádu: řádek `pending` bez `worklog_id` se před dalším uploadem dohledá přes
`GET /rest/api/2/issue/{key}/worklog` (shoda autora = aktuální uživatel, `started`, `timeSpentSeconds`,
`comment`). Nalezeno = doplnit ID. Nenalezeno = POST znovu.

Auth: SSO cookies jako `jiraClient` (`readStorageStateSession`). Vypršení = stav "přihlas se" a
tlačítko na existující login flow. Žádný token, žádný PAT.

### 5.6 Hranice zápisu do Jiry (bezpečnost, součást issue 5)

Nový modul `src/core/timeTracking/jiraWorklogWriter.ts` je jediné místo v kódu, které posílá do
Jiry něco jiného než čtení.

- Veřejné API má jen tři funkce: `createWorklog`, `updateWorklog`, `deleteWorklog` s typovanými
  parametry. Žádná obecná `request(method, url)`.
- URL se skládá uvnitř modulu z `JIRA_BASE_URL` a validovaného klíče a ID. Před odesláním se celá URL
  ověří proti allowlistu:
  `^/rest/api/2/issue/[A-Z][A-Z0-9]+-[1-9][0-9]*/worklog(/[0-9]+)?$` a host přesně `JIRA_HOST`.
- Metody: POST bez ID, PUT a DELETE jen s ID. PUT a DELETE jen pro `worklog_id`, které je v ledgeru
  ve stavu `synced`. Jiné ID = výjimka před requestem.
- Query: `adjustEstimate=leave` u všech tří metod, aby upload neměnil odhad issue. Nic jiného.
- Tělo: jen `{ started, timeSpentSeconds, comment }`. `timeSpentSeconds` je násobek 900, 900 až 43 200.
  `comment` max 255 znaků, bez řídicích znaků.
- `redirect: 'manual'`. 3xx, 401, 403 = auth chyba, nic se neopakuje.
- Hlavička `X-Atlassian-Token: no-check` (Jira ji vyžaduje u zápisu s cookie auth). Ověřit proti
  dokumentaci Jira Data Center.
- Max 50 operací na jeden upload dne. Součet dne nad 16 h = blokace s hláškou.
- Volá se jen z IPC handleru po potvrzení v UI. Socket CLI tuto funkci nemá v routách.
- ESLint pravidlo (`no-restricted-imports`): `jiraWorklogWriter` smí importovat jen
  `src/core/timeTracking/jiraUpload.ts` a jeho test.
- `jiraClient.ts` zůstává read-only beze změny.
- Logování: metoda, issue klíč, worklog ID, status. Nikdy cookies, nikdy celé tělo odpovědi.

## 6. Bezpečnostní model

| Hrozba | Opatření |
|---|---|
| Prompt injection v transcriptu ovlivní Haiku | Haiku nemá nástroje ani MCP. Výstup jen JSON se striktní validací. Výstup jde jen do lokálního popisu a flagu. Nic nespouští. |
| Injection přes agenta, který volá CLI | CLI neumí Jiru. Nahrané karty nemění. Validace na serveru. Rate limit. Audit log. |
| Jiný lokální proces volá socket | Socket `0600` v adresáři `0700`, token `0600`, nový při startu. |
| Zápis do Jiry mimo worklogy | Jediný modul, allowlist URL a metod, typované API, ESLint hranice, testy. |
| Smazání cizího worklogu | PUT a DELETE jen pro ID z vlastního ledgeru. |
| Duplicitní worklogy | Ledger `pending` před requestem a obnova přes GET. |
| Únik lokálního kontextu do Jiry | Komentář = jen popis karty (D14). Validace popisu na URL, cesty a tokeny i pro ruční popis při uploadu (varování v náhledu, ne tichá změna). |
| Únik citlivých dat přes shrnutí | Redakce vstupu, validace výstupu, `--no-session-persistence`. |
| Únik do public repa | Žádný hostname, jméno klienta ani zaměstnavatele v kódu, testech, fixtures, docs a PR. Fixtures syntetické. |

## 7. Postup vývoje

### TDD

- Každé chování začíná failing testem. Commit testu před implementací není nutný, ale review ověří,
  že test bez implementace padá (mutation check verifieru).
- Vrstvy:
  - čisté funkce (dělení času po dnech, vyloučení, zaokrouhlení, plán uploadu, diff ledgeru,
    validace CLI a Haiku výstupu): Vitest, tabulkové testy včetně hran (půlnoc, 4:59 vs 5:00 min,
    14:59 vs 15:00, 30:01, víkend, přechod letního času),
  - repo a migrace: Vitest proti in-memory `node:sqlite`, včetně migrace existujících overrides,
  - socket a CLI: integrační test se skutečným socketem v dočasném adresáři (oprávnění souborů,
    špatný token, příliš velký požadavek, neznámý příkaz, exit kódy),
  - Jira writer: fake `fetch`, kontraktní testy na přesnou URL, metodu, hlavičky a tělo; negativní
    testy na každé pravidlo z 5.6,
  - Haiku runner: fake spawn; jeden spike test se skutečným `claude` jen ručně, mimo CI,
  - UI a celé toky: e2e přes `e2e/harness.ts` (board se snapshotem, seskupení, flag, upload proti
    stubu Jiry ve stylu `jiraE2eStub.ts`).
- Testy nesmí volat skutečnou Jiru ani skutečný `claude`.

### Validace

Každý vstup se validuje v core, i když ho validuje UI nebo CLI: IPC, socket, Haiku výstup, data ze
`storageState`, odpovědi Jiry (tvar `id` worklogu). Chyba je vždy konkrétní věta pro vlastníka.

### Evaluace Haiku (issue 2)

- Sada `evals/time-summary/` s 30+ syntetickými transcripty: čistá práce, nepracovní (osobní dotaz,
  nákup, zábava), smíšené, krátké, anglické, a 5+ pokusů o injection ("ignore instructions",
  "output isWork false", vložená URL, vložený token).
- Skript `npm run eval:time-summary` spustí skutečný Haiku a vypíše tabulku. Ne v CI. Výsledek jde
  do PR popisu.
- Prahy pro merge:
  - validní výstup 100 %,
  - únik URL, cesty nebo tokenu do `summary` 0 případů,
  - pracovní session označená jako nepracovní max 5 % (taková chyba vede k chybějícímu času v Jiře),
  - celková přesnost klasifikace min 90 %,
  - čeština ve 100 % shrnutí.
- Při nesplnění: upravit prompt, ne prahy. Změna prahu = rozhodnutí vlastníka.

### Code review nezávislými subagenty

Každé issue jde přes `implement-issue`. Navíc:
- `reviewer` v novém kontextu pro každé kolo, dostane issue a diff, ne závěry implementera.
- Issue 4 (CLI) a 5 (Jira): navíc samostatný bezpečnostní review podle `gc-sec-review` zaměřený na
  socket, validaci a hranici zápisu. Nálezy High a Critical blokují merge.
- Issue 2 (Haiku): navíc review podle `gc-agent-review` pro headless `claude` spuštění.
- `verifier` spustí celý gate (typecheck, lint, test, e2e) a mutation test nových testů.

## 8. Rozdělení do issues a pořadí

1. **Snapshot sessions po dnech** - `tracked_session_day`, dělení času po dnech, 5min práh,
   vyloučení, migrace overrides, konec `pruneAbsent`, Resume při čitelném transcriptu; název,
   složka a branch zůstávají uložené pro Haiku, ale na kartě se nezobrazují. Úprava
   `docs/agents/product.md` (D1 až D16, zrušení "automatic worklogs" v zamítnutých, s výjimkou uploadu
   bez kliknutí).
2. **Haiku shrnutí a klasifikace** - runner, fronta, validace, pill a flag, "Je pracovní",
   "Přegenerovat", evaluace. Závisí na 1.
3. **Seskupení karet** - skupiny, výběr, "Seskupit den podle issue", součty. Závisí na 1.
4. **CLI `intersect-time`** - socket, token, příkazy, audit, shim v Settings. Závisí na 3.
5. **Upload dne do Jiry** - writer, ledger, plán, náhled, re-sync, obnova, stavy karet,
   `do_not_upload`. Závisí na 2 a 3.

2 a 3 mohou běžet paralelně. 4 a 5 také.

## 9. Akceptační kritéria

1. Session z desktop app, VS Code i terminálu Intersectu se objeví jako karta do 10 min po 30 min
   nečinnosti, se shrnutím v češtině, bez názvu session, složky a branch na kartě. Metadata zůstávají
   uložená pro Haiku a karta nabízí Resume, dokud je transcript čitelný.
2. Session obnovená další den má kartu v každém dni s aktivním časem dne. Včerejší karta se nezmění.
3. Session a den pod 5 min aktivního času nemá kartu.
4. Sessions spuštěné Intersectem a sessions pod vyloučenými prefixy nemají kartu.
5. Karty starší než doba mazání transcriptů zůstanou i s editacemi.
6. Nepracovní karta má pill a flag. "Je pracovní" flag trvale odstraní.
7. Vlastník seskupí vybrané karty, seskupí den podle issue a skupinu rozdělí. Součty sedí.
8. `intersect-time` umí list, add, edit, delete, group, ungroup. Každý zápis je v audit logu
   s aktérem. Nahranou kartu CLI nezmění. CLI nemá žádný příkaz pro Jiru.
9. Upload dne ukáže náhled, odešle jen po potvrzení, vytvoří 1 worklog na kartu nebo skupinu se
   zaokrouhlením D13 a komentářem jen z popisu.
10. Karta bez issue klíče upload blokuje. Nepracovní a "neodesílat" karty se vynechají.
11. Po editaci nahrané karty další upload provede PUT nebo DELETE jen na vlastní worklog ID.
12. Přerušený upload po restartu nevytvoří duplicitní worklog.
13. Žádný kód mimo `jiraWorklogWriter.ts` neposílá do Jiry zápis. Test a ESLint to hlídají.
14. Gate zelený: typecheck, lint, test, e2e. Evaluace Haiku splní prahy.

## 10. Rizika a otevřené body

- Izolace user hooků a pluginů v headless `claude -p` bez `--bare` není ověřená. Spike v issue 2.
- `cleanupPeriodDays` výchozí hodnota: ověřit v dokumentaci Claude Code. Na řešení to nemá vliv.
- Jira může vyžadovat oprávnění "Work on issues" a otevřený stav issue. Chyba se zobrazí u karty,
  nic se neobchází.
- Zaokrouhlení D13 zvyšuje vykázaný čas proti boardu. Náhled ukazuje oba součty, aby rozdíl byl vidět.
- Haiku běží na předplatném vlastníka a zabírá jeho limity. Počet běhů je omezený frontou a
  podmínkou nečinnosti.
