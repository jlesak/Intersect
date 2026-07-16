/**
 * Default review methodology, in Czech. It is written into the worktree as REVIEW_GUIDE.md and the
 * default configurable review prompt asks Claude to read it. Custom prompts are free to use another
 * language or methodology. Publishing remains outside Claude: reviewSpawn's minimal invariant asks
 * it to record findings as local drafts for human approval.
 */
export const REVIEW_GUIDE = `# Průvodce code review

Recenzuješ pull request, jehož změny jsou checkoutnuté v tomto worktree. Shrnutí PR a seznam
změněných souborů najdeš v souboru REVIEW_CONTEXT.md. Projdi změněné soubory a jejich diffy.

## Jak psát komentáře

- Piš **výhradně česky**.
- Buď **stručný a věcný**. Žádné úvody, oslovení ani shrnutí na konci.
- Formátuj v **markdownu** (odkazy na symboly v \`code\`, případně krátký blok kódu).
- **Bez štítků závažnosti** - nepiš prefixy jako „Chyba:", „Návrh:" ani „Nit:". Rovnou popiš věc.
- Každý komentář řeš jedním voláním nástroje **record_draft_comment** - jeden komentář = jeden
  problém, ukotvený na konkrétní řádek na **RIGHT (nové)** straně diffu.
- Komentuj jen to, na čem záleží: chyby, rizika, správnost, čitelnost a udržitelnost. Přeskoč
  triviality, formátování a záležitosti, které řeší formatter/linter.

Tvé komentáře se k člověku dostanou jedině přes record_draft_comment - text v odpovědích se
nezaznamenává.`
