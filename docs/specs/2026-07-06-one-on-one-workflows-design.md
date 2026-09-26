# 1:1 — Claude Code workflows pro zpracování a přípravu 1:1 schůzek

Byznys/produktová specifikace nové vertical slice v Intersectu. Datum: 2026-07-06.
Status: **schváleno k implementaci** (interview + Lavish UI/UX review, schváleno beze změn).

## 1. Problém a cíl

Uživatel má existující Claude Code skill `1to1`, který zpracuje VTT nahrávku 1:1 schůzky do Notion
poznámky + Slack souhrnu, ale dnes ho musí spouštět ručně v terminálu. Zároveň chybí úplně nový
workflow — příprava na nadcházející 1:1, která by shrnula kontext (minulé poznámky, otevřené TODO
body týkající se té osoby, Slack aktivitu) do jednoho přehledu před schůzkou.

Tato slice dává oběma workflow místo v Intersectu: spuštění bez nutnosti pamatovat si CLI příkaz,
sledování průběhu, a historii běhů s výsledky.

**PR review přes Claude Code** (guardrailed review v isolated worktree) už existuje jako součást
PR Inbox slice — pro tuto specifikaci není potřeba nic nového, jen poznámka, že stejný obecný vzor
(spustit Claude Code na pozadí/v terminálu, sledovat výsledek) se v aplikaci opakuje potřetí.

## 2. Rozsah

**Uvnitř:**
- Nová sidebar sekce "1:1".
- Workflow "Zpracovat nahrávku 1:1": vstup = jméno osoby + VTT soubor (drag&drop nebo výběr).
  Spustí existující `1to1` skill na pozadí (interaktivní Claude Code session, ne headless `-p`,
  stejný SSO/skill mechanismus jako u My Work). Skill sám vytvoří Notion stránku a Slack souhrn —
  Intersect nic z toho neupravuje ani neschvaluje, jen po doběhnutí zobrazí odkazy na výsledek.
- Workflow "Připravit se na 1:1": vstup = jméno osoby. Spustí Claude Code session, která:
  - shrne poslední poznámky/závěry z předchozích 1:1 s tou osobou (z Notion, kam skill `1to1` ukládá),
  - fulltextově prohledá TODO list uživatele na zmínky jména té osoby,
  - projde Slack (přes Slack MCP connector) na aktivitu té osoby za poslední období.
  Výsledek se zobrazí přímo v appce jako renderovaný markdown (žádný nový Notion záznam).
- Historie běhů obou typů workflow s výsledky, viditelná i po zavření/znovuotevření sekce.

**Mimo scope (vědomě):**
- Žádný trvalý seznam osob/lidí — jméno se zadává manuálně při každém spuštění.
- Žádná úprava TODO listu (žádné tagování osob) — prep workflow jen čte existující text úkolů.
- Žádné schvalování/editace výstupu v Intersectu — skill si publikuje výsledky sám, stejně jako dnes
  v CLI.
- Žádná nová PR review funkcionalita — využívá se to, co už PR Inbox nabízí.

## 3. Zafixovaná rozhodnutí (z interview)

| Rozhodnutí | Volba |
|---|---|
| Trigger zpracování nahrávky | Výběr/drag&drop VTT souboru v Intersectu, běh na pozadí, sledování průběhu |
| Obsah přípravy na 1:1 | Poslední poznámky z minulého 1:1 (Notion) + fulltextové zmínky jména v TODO listu + Slack aktivita osoby (MCP) |
| Vazba na TODO list | Žádná změna TODO featury — jen fulltextové prohledání textu úkolů |
| Výběr osoby | Bez trvalého seznamu lidí — jméno se zadává ručně při každém běhu |
| Umístění v UI | Nová sidebar sekce "1:1" s historií běhů (ne command palette/toast-only) |
| Publikace výstupu zpracování | Skill dělá vše sám (Notion + Slack) jako dnes v CLI; Intersect jen zobrazí hotové odkazy — žádné draft/approve UI jako u PR Inbox |
| Zobrazení výstupu přípravy | Přímo v appce jako markdown (stejný vzor jako Session Search transcript viewer) |

## 4. UX

Mockup: `.lavish/one-on-one-mockup.html` (schváleno beze změn).

- Tlačítko "+ Nový" nahoře otevře formulář: typ workflow (select), osoba (text), VTT soubor
  (jen pro "Zpracovat nahrávku", skryté pole pro "Připravit se").
- Historie běhů pod formulářem: karta s typem (barevně odlišený badge), osobou, časem, stavem
  (běží na pozadí / hotovo), a výsledkem — odkazy (Notion, Slack) pro zpracování, nebo přímo
  vyrenderovaný markdown pro přípravu.

## 5. Akceptační kritéria

1. Sidebar obsahuje sekci "1:1".
2. Formulář umožní spustit oba typy workflow se správnými vstupními poli.
3. Zpracování nahrávky běží na pozadí (skrytá interaktivní Claude Code session, žádný PAT token,
   žádný headless `-p`), po doběhnutí se zobrazí odkaz na Notion stránku a informace o Slack
   souhrnu.
4. Příprava na 1:1 vrátí markdown shrnutí (minulé poznámky + TODO zmínky + Slack aktivita)
   vyrenderované přímo v sekci.
5. Historie běhů zůstává dostupná po opětovném otevření sekce.
