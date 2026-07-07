# TODO list — lehký osobní seznam úkolů

Byznys/produktová specifikace nové vertical slice v Intersectu. Datum: 2026-07-06.
Status: **schváleno k implementaci** (interview + Lavish UI/UX review, schváleno beze změn).

## 1. Problém a cíl

Uživatel dnes používá Todoist pro správu úkolů, ale chce mít v Intersectu lehký, nezávislý seznam
pro drobné osobní úkoly bez Jira ticketu — věci, které si potřebuje zapsat, aby na ně nezapomněl
("zeptat se Marka na X", "zkontrolovat logy po deploy"), a které nestojí za založení Jira issue.
Není náhrada Todoistu ani napojená na něj — jde o rychlý capture uvnitř nástroje, kde uživatel
stejně tráví většinu dne.

## 2. Rozsah

**Uvnitř:**
- Nová sidebar sekce "TODO".
- Přidání úkolu (text), volitelný termín (due date).
- Odškrtnutí jako hotové → automaticky zmizí z hlavního seznamu do skryté sekce "Hotové",
  dostupné přes odkaz/tlačítko nahoře.
- Ruční řazení (drag & drop).
- Smazání úkolu.

**Mimo scope (vědomě):**
- Žádná integrace/sync s Todoistem.
- Žádné projekty/štítky/kategorie, žádné opakující se úkoly, žádné notifikace/připomínky.
- Žádná vazba na workspace nebo Jira issue — je to čistě globální osobní seznam.

## 3. Zafixovaná rozhodnutí (z interview)

| Rozhodnutí | Volba |
|---|---|
| Účel | Drobné osobní úkoly bez Jira ticketu (ne inbox na nápady, ne checklist per workspace) |
| Umístění v UI | Samostatná nová sidebar sekce "TODO" |
| Vztah k Jira issues | Žádný — úplně oddělený model od My Work/Jira |
| Vztah k Todoistu | Žádná integrace/sync — zcela samostatný, lehký capture nástroj |
| Struktura záznamu | Text + checkbox + volitelný termín |
| Řazení | Ruční (drag & drop), žádné automatické řazení podle termínu/priority |
| Hotové úkoly | Po odškrtnutí automaticky zmizí z hlavního seznamu do skryté sekce "Hotové", přístupné přes odkaz/toggle |

## 4. UX

Mockup: `.lavish/todo-mockup.html` (schváleno beze změn).

- Vstupní pole nahoře pro přidání nového úkolu (Enter = přidat), tlačítko pro nastavení termínu.
- Plochý seznam úkolů: drag handle, checkbox, text, volitelný termín (červeně pokud po termínu),
  smazat na hover.
- Odkaz "Zobrazit hotové (N)" nahoře rozbalí/schová sekci s odškrtnutými úkoly.

## 5. Akceptační kritéria

1. Sidebar obsahuje sekci "TODO".
2. Přidání úkolu s textem a volitelným termínem funguje přes vstupní pole nahoře.
3. Odškrtnutí úkolu ho přesune do skryté sekce "Hotové" (nezůstává v hlavním seznamu).
4. Sekce "Hotové" je dostupná přes toggle/odkaz, výchozí stav skrytý.
5. Úkoly lze přeuspořádat drag & drop.
6. Úkol lze smazat (v hlavním i v sekci Hotové).
7. Úkol po termínu je vizuálně odlišený (např. červený termín).
