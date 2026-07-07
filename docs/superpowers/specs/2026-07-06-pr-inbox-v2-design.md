# PR Inbox v2 — hlasování na PR

Byznys/produktová specifikace rozšíření existující PR Inbox vertical slice. Datum: 2026-07-06.
Status: **schváleno k implementaci** (interview + Lavish UI/UX review).

## 1. Problém a cíl

PR Inbox dnes umí PR číst, procházet diff a psát/publikovat komentáře (draft comments), ale
schválení/zamítnutí PR musí uživatel stále dokončit v ADO webu. Cíl: umožnit hlasování přímo
z Intersectu, aby review nikdy nevyžadovalo přechod jinam.

Z původních non-goals PR Inboxu (background polling, multi-repo config, batch review) je do scope
vědomě zařazeno **jen hlasování** — zbytek zůstává mimo scope i nadále.

## 2. Rozsah

**Uvnitř:**
- Hlasovací tlačítka v hlavičce PR detailu (stejné místo jako title/refs, kde je dnes diff viewer).
- Tři vote opce: **Approve**, **Approve with suggestions**, **Wait for author** (Reject vědomě
  vynechán — uživatel ho nepoužívá).
- Klik na vote je okamžitá akce (žádné potvrzovací okno), stejně jako v ADO webu.
- Aktuální hlas uživatele je vizuálně zvýrazněný (aktivní tlačítko).

**Mimo scope (vědomě, zůstává jako v původním PR Inboxu):**
- Background polling/webhooky na nové PR.
- Multi-repo/org konfigurace.
- Batch review napříč více PR.
- Reject vote opce.
- **Guardrail zachován:** AI guardrailed review nikdy nenavrhuje ani nenastavuje vote — hlasování
  je vždy čistě ruční krok uživatele, nezávislý na tom, jestli PR review proběhlo manuálně nebo
  pomocí AI.

## 3. Zafixovaná rozhodnutí (z interview)

| Rozhodnutí | Volba |
|---|---|
| Rozšíření scope | Jen approve/vote — background polling, multi-repo, batch review zůstávají mimo scope |
| Umístění | Tlačítka v hlavičce PR detailu (ne v řádku seznamu) |
| Vote opce | Approve / Approve with suggestions / Wait for author (bez Reject, bez No vote) |
| AI a vote | Vote je vždy jen ruční krok uživatele, AI guardrailed review se ho nikdy nedotýká |
| Potvrzení akce | Žádné — okamžitý klik, stejně jako ADO web |

## 4. UX

Mockup: `.lavish/pr-vote-mockup.html` (schváleno, Reject odstraněn dle zpětné vazby).

- Segmentovaná skupina 3 tlačítek v `ix-pr-header`, vpravo od title/refs.
- Aktivní hlas zvýrazněný barevně (reuse existujících `--pr-vote` barevných konvencí z `app.css`:
  zelená pro approved, tyrkysová pro approved-with-suggestions, amber pro waiting).

## 5. Akceptační kritéria

1. PR detail header zobrazuje 3 vote tlačítka (Approve / Approve with suggestions / Wait for author).
2. Klik na tlačítko okamžitě odešle hlas do ADO a vizuálně zvýrazní aktivní stav.
3. Aktuální hlas se správně zobrazuje při otevření PR (reflektuje stav z ADO).
4. Guardrailed AI review flow zůstává nezměněný — nikde nenabízí ani needituje vote.
