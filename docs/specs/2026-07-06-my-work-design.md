# My Work / Today — agregovaný přehled práce

Byznys/produktová specifikace nové vertical slice v Intersectu. Datum: 2026-07-06.
Status: **schváleno k implementaci** (interview + Lavish UI/UX review, iterováno na kanban board dle
zpětné vazby).

## 1. Problém a cíl

Uživatel dnes musí ručně přepínat mezi Jirou (co mám přiřazeno), Azure DevOps (jaké PR čekají na
review) a Intersectem (kde fyzicky pracuji), aby zjistil "co mám dneska dělat". My Work je nová
sidebar sekce, první v pořadí, která tyhle dva zdroje agreguje na jedno místo jako ranní/průběžný
radar. Neřeší workflow uvnitř Jiry/ADO (žádné psaní komentářů, měnění stavů) — je to čistě přehled
s odkazy ven a do existujících sekcí Intersectu.

## 2. Rozsah

**Uvnitř:**
- Jira issues přiřazené aktuálnímu uživateli, nevyřešené, zobrazené jako kanban board.
- Azure DevOps PRs vyžadující akci (vlastní PRs čekající na merge, PRs čekající na review, PRs
  s novými změnami po mém review) — reuse dat, která už dnes existují v PR Inbox slice.
- Manuální refresh + refresh při otevření sekce.

**Mimo scope (vědomě, ne technický limit):**
- Žádná editace Jira issues (přesun mezi stavy, komentáře) z My Work — jen odkaz do Jiry v prohlížeči.
- Žádné real-time/background polling mimo otevřenou sekci (viz rozhodnutí níže).
- Žádné jiné zdroje práce (GitHub issues, e-maily, kalendář) — jen Jira + ADO PR.

## 3. Zafixovaná rozhodnutí (z interview)

| Rozhodnutí | Volba |
|---|---|
| Umístění v UI | Nová sidebar sekce, **první v pořadí** (před Workspaces) |
| Zdroje "práce" | Jira issues přiřazené mně + ADO PRs čekající na akci (ne attention status, ne staré workspaces) |
| Jira dotaz | Fixní: přiřazeno mně, nevyřešené — **žádné** vlastní JQL v první verzi |
| Jira layout | **Kanban board**, 5 sloupců: To Do / Progress / Waiting / Review / Test (sloupec Done vynechán — nevyřešené issues do něj nikdy nespadnou) |
| Klik na Jira kartu | Otevře issue v defaultním prohlížeči (žádná in-app navigace/detail) |
| Jira přístup | **Nesmí** používat PAT token (firemní omezení) — načítání běží přes skrytou pozadí Claude Code session, která využívá existující `jira` skill a jeho SSO browser session (stejný mechanismus jako dnes v Claude Code, ne headless `-p` režim) |
| Fetch UX | Neviditelně na pozadí (hidden PTY), uživatel vidí jen loading spinner/skeleton a výsledek |
| Refresh cadence | Manuální tlačítko + auto-build při otevření sekce (stejný vzor jako Session Search/PR Inbox); žádné pravidelné background polling |
| PR podskupiny | Tři: "Moje PRs čekající na merge", "Čekají na můj review", "Nové změny po mém review" — v tomto pořadí |
| Klik na PR kartu | Přejde do existující PR Inbox sekce a vybere daný PR (diff viewer) |
| Barvy | Reuse existujících design tokenů (`--status-working/--status-waiting/--status-done/--accent`) i přes vizuální překryv s Claude session attention barvami — vědomě akceptováno |
| Board šířka | Horizontální scroll při 5+ sloupcích je OK jako výchozí chování |

## 4. UX stavy (viz mockup)

- **Loaded** — kanban board se sloupci a kartami; PR sekce se třemi podskupinami.
- **Loading** — skeleton karty ve všech sloupcích + spinner s textem vysvětlujícím pozadí běžící
  Claude Code session.
- **Empty** — "Vše vyřízeno ✓" + krátký hint, žádné nevyřešené issues.
- **Error** — např. vypršelá SSO session: chybová zpráva + tlačítko "Zkusit znovu".

Mockup: `.lavish/my-work-mockup.html` (schváleno v Lavish review, iterace: flat list → kanban board →
finální 5sloupcová verze).

## 5. Otevřené otázky vyřešené v review

- Konflikt "nevyřešené" filtru vs. Done sloupec → Done sloupec vynechán.
- Kolize barev Jira sloupců s Claude attention barvami → akceptováno, žádná změna.
- Šířka boardu / scroll → akceptováno jako výchozí chování.

## 6. Akceptační kritéria (shrnuto, detail viz jednotlivé GitHub issues)

1. Sidebar má novou sekci "My Work" jako první položku.
2. Otevření sekce spustí (přes existující slice-registraci) build/refresh Jira i PR dat.
3. Jira board zobrazuje 5 sloupců se správným rozřazením podle stavu issue, řazeno dle poslední
   aktivity v rámci sloupce.
4. Klik na Jira kartu otevře issue URL v systémovém prohlížeči.
5. PR sekce zobrazuje tři podskupiny ve specifikovaném pořadí a správném filtru (viz §3).
6. Klik na PR kartu přepne do PR Inbox sekce s vybraným PR.
7. Loading/empty/error stavy odpovídají mockupu.
8. Refresh tlačítko vynutí nový fetch obou zdrojů.
