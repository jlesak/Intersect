# Settings — konfigurace appky

Byznys/produktová specifikace nové vertical slice v Intersectu. Datum: 2026-07-06.
Status: **schváleno k implementaci** (interview + Lavish UI/UX review, schváleno beze změn).

> **Aktuální stav — 2026-07-16, issue #32:** Původní čtyřkategorický scope níže byl
> rozšířen o pátou kategorii **PR Review**. Obsahuje víceřádkový prompt, který se
> perzistuje doslovně (včetně jazyka a whitespace), a akci pro obnovení vestavěného výchozího
> promptu. Zbytek dokumentu zachovává historický rozsah a akceptační kritéria původní slice.

## 1. Problém a cíl

Intersect dnes nemá žádnou obrazovku nastavení — notifikace, ADO připojení apod. jsou buď
hardcoded, nebo konfigurované mimo appku (env/config soubory). Settings sekce sjednotí tyhle
konfigurace do jednoho místa v UI.

## 2. Rozsah

**Uvnitř:** čtyři kategorie, viz níže. **Mimo scope (vědomě):** přebindování klávesových zkratek,
light téma, výběr barvy akcentu, multi-repo/org ADO config (viz PR Inbox v2 — mimo scope).

## 3. Zafixovaná rozhodnutí (z interview)

| Rozhodnutí | Volba |
|---|---|
| Umístění v UI | Nová sidebar sekce se sub-navigací vlevo (kategorie), obsah vpravo |
| Kategorie | Notifikace, Azure DevOps, Klávesové zkratky, Vzhled |
| Notifikace | Hlavní vypínač + zvlášť per stav (working/waiting/done) + zvuk on/off |
| Azure DevOps | Org URL, projekt, repo název, PAT token (maskovaný), tlačítko "Testovat připojení" |
| Klávesové zkratky | Jen čitelný přehled, needitovatelné (žádné rebind) |
| Vzhled | Jen velikost písma v terminálu (žádné světlé téma, žádná barva akcentu) |

## 4. UX

Mockup: `.lavish/settings-mockup.html` (schváleno beze změn).

- Settings v patičce hlavního sidebar rail (odděleně od denně používaných sekcí typu My Work/PR
  Inbox — konzistentní s běžnou konvencí "utilit dole").
- Uvnitř: levá sub-navigace (4 kategorie), obsah vpravo se přepíná bez znovunačtení stránky.
- Notifikace: přepínače (toggle) pro každou položku, barevně odlišené stavy working/waiting/done
  (reuse existujících `--status-*` tokenů).
- Azure DevOps: formulářová pole + PAT jako `type=password`, test-connection akce s inline
  úspěch/chyba zprávou.
- Klávesové zkratky: statická tabulka zkratka → akce.
- Vzhled: slider pro velikost písma terminálu s číselným náhledem.

## 5. Akceptační kritéria

1. Sidebar obsahuje sekci "Settings" (v patičce rail, ne mezi denními sekcemi).
2. Čtyři kategorie dostupné přes sub-navigaci, obsah se přepíná bez ztráty stavu ostatních polí.
3. Notifikační přepínače perzistují a řídí skutečné chování existující attention/notifikační
   featury (`notifSettings.ts`).
4. ADO formulář uloží org/projekt/repo/PAT; "Testovat připojení" provede reálný request a zobrazí
   úspěch/chybu.
5. Klávesové zkratky zobrazují aktuálně platné zkratky (statický přehled, žádná interaktivní
   editace).
6. Velikost písma terminálu se změnou slideru reálně promítne do xterm instancí.
