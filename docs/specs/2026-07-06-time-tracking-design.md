# Time Tracking — týdenní přehled odpracovaného času

Byznys/produktová specifikace nové vertical slice v Intersectu. Datum: 2026-07-06.
Status: **schváleno k implementaci** (interview + Lavish UI/UX review — vzor inspirovaný Jira Tempo
weekly worklog view, upravený a zjednodušený dle zpětné vazby).

## 1. Problém a cíl

Uživatel chce vědět, kolik času reálně strávil na jednotlivých Jira issues, aniž by musel čas ručně
zapisovat pokaždé znovu (jako v Jira Tempo). Většina vývojové práce se dnes odehrává v Claude Code
session uvnitř Intersectu — tenhle čas už evidujeme (Session Search počítá `durationMs` z první a
poslední zprávy session). Time Tracking tato data zpřístupní jako týdenní přehled a doplní možnost
ručně přidat čas, který se v Claude Code neodehrál (schůzky, práce mimo terminál).

Vědomě **nezávislé na Togglu** — i když má uživatel Toggl k dispozici (MCP integrace), tahle featura
vede vlastní záznamy v Intersectu, protože potřebuje přesné párování na konkrétní Claude Code session
kvůli automatickému trackingu.

## 2. Rozsah

**Uvnitř:**
- Nová sidebar sekce "Time Tracking", týdenní pohled (Po–Pá, navigace mezi týdny, "Dnes" zkratka).
- Automatické záznamy: jeden záznam za každou Claude Code session, čas = `durationMs` ze Session
  Search indexu, issue = Jira klíč odvozený z git branch workspace (stejný mechanismus jako u My Work).
- Ruční záznamy: tlačítko "+ Přidat záznam" na konci každého dne — text popisu, volitelný issue klíč
  (nemusí být vyplněný — např. schůzky, práce na neevidované issue), čas.
- Editace: čas i přiřazený issue klíč lze na jakékoliv kartě (auto i ruční) přímo přepsat; karty lze
  smazat.
- Denní součet nad každým sloupcem, týdenní součet v horní liště.

**Mimo scope (vědomě):**
- Žádná integrace/sync s Togglem.
- Žádné porovnání s očekávanou pracovní kapacitou (žádné "8h z 8h") — jen surový součet.
- Žádné agregování víc sessions do jedné karty — každá Claude Code session je vlastní karta (i za
  cenu víc karet při častém přepínání).
- Víkend (So/Ne) se v týdenním pohledu nezobrazuje.

## 3. Zafixovaná rozhodnutí (z interview)

| Rozhodnutí | Volba |
|---|---|
| Toggl vs. vlastní | Vlastní nezávislý systém v Intersectu (Toggl MCP není použit) |
| Přiřazení k issue | Automaticky podle workspace/branch → Jira klíč (stejný mechanismus jako My Work) |
| Co se měří automaticky | Jen běh Claude Code sessions (`durationMs`), žádné sledování focus/idle na shell tabech |
| Ruční úprava | Přímá editace číselné hodnoty na kartě (přepsání), ne "+/-" delta tlačítka |
| Granularita | Denní/týdenní rozpad + celkový součet (ne jen all-time total) |
| UI formát | Samostatná sidebar sekce, týdenní board inspirovaný Jira Tempo (sloupce = dny, karty = worklogy) |
| Granularita karet | Samostatná karta za každou Claude Code session (bez slučování za den/issue) |
| Ruční záznam bez issue | Povoleno — plain text worklog bez vazby na Jira issue (např. meeting) |
| Editace auto karet | Ano, čas i issue klíč lze na auto-tracked kartě přepsat/smazat |
| Checkbox/potvrzování | Žádné — jednodušší řešení, žádný stav "potvrzeno" |
| Denní kapacita/norma | Žádná — jen surový součet bez porovnání s očekávaným časem |
| Klik na auto kartu | Jen inline editace, žádné přepnutí do Session Search transkriptu |
| Víkend | Nezobrazuje se (Po–Pá) |

## 4. UX

Mockup: `.lavish/time-tracking-mockup.html` (schváleno beze změn v review).

- Horní lišta: název sekce, "Dnes" tlačítko, navigace šipkami mezi týdny s datumovým rozsahem,
  celkový součet týdne vpravo.
- 5 sloupců (Po–Pá), každý s hlavičkou (den, datum, denní součet) a seznamem karet.
- Karta: ikona zdroje (auto = trojúhelník / ruční = tečka), issue klíč nebo "bez issue" kurzívou,
  popis, editovatelné pole s časem, akce smazat (na hover).
- Na konci každého dne tlačítko "+ Přidat záznam", které otevře inline formulář (popis, volitelný
  issue klíč, čas, Uložit/Zrušit).

## 5. Akceptační kritéria

1. Sidebar obsahuje sekci "Time Tracking" (pořadí: My Work, Time Tracking, Workspaces, PR Inbox,
   Sessions).
2. Týdenní board zobrazuje Po–Pá s navigací mezi týdny a zkratkou "Dnes".
3. Každá Claude Code session z aktuálního týdne se zobrazí jako samostatná karta ve správném dni,
   s automaticky odvozeným issue klíčem (pokud lze z branch odvodit).
4. Uživatel může kdykoliv přepsat čas i issue klíč na libovolné kartě a kartu smazat.
5. Ruční přidání záznamu funguje i bez vyplněného issue klíče.
6. Denní a týdenní součty se počítají správně a aktualizují se při každé změně.
