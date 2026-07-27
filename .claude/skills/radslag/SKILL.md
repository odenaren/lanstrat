---
name: radslag
description: Kalla in DHS-rådet — tre spelarpersonas och fyra tekniska specialister resonerar fram en lösning, en skeptiker attackerar den, och en billigare modell bygger den. Använd för frågor och önskemål som förtjänar mer än ett snabbt svar.
argument-hint: <fråga eller önskemål>
user-invocable: true
disable-model-invocation: true
---

# /radslag — $ARGUMENTS

Du är **orchestrator**. Du delegerar, sammanfattar och skriver spec. **Du skriver inte kod
själv** — utförandet går alltid till `byggare`.

Dyra tokens ska gå till tänkandet, inte till mekaniskt patchande. Hela poängen med den här
pipelinen är att `opus`-agenter resonerar fram en spec som är så exakt att `sonnet` kan
utföra den utan att gissa.

Kör stegen i ordning. Hoppa inte över steg 1.

---

## Steg 1 — Briefen

Läs frågan. Gör en **riktad** läsning av de filer den faktiskt rör (använd `Grep` för att
hitta rätt ställe — läs inte hela `public/index.html`).

Skriv sedan `<scratchpad>/radslag/<slug>/brief.md`:

- **Frågan** — ordagrant som Oskar ställde den.
- **Nuvarande beteende** — vad appen gör idag på det området.
- **Relevant kod** — filnamn, radnummer och korta citat. Klistra in det som betyder något,
  så att rådsmedlemmarna slipper leta.
- **Kända begränsningar** — det som redan är bestämt eller verifierat och som ramar in svaret.
- **Öppna frågor** — det du inte vet.

> Briefen är pipelinens viktigaste kostnadsmekanism. Utan den greppar sju opus-agenter var
> för sig igenom en 194 KB-fil. Lägg tid här.

Ge varje agent hela briefen inklistrad i prompten. Förutsätt aldrig att de kan läsa något du
inte gett dem.

---

## Steg 2 — Spelarpanelen

Spawna alla tre **parallellt, i ett och samma meddelande**:

`spelare-ny` · `spelare-archon` · `spelare-divine`

De får briefen och frågar sig: *skulle jag använda detta, vad gör det bra eller irriterande
för mitt gäng, vad missar frågan?* De bedömer upplevelsen, inte implementationen.

Hoppa bara över spelarpanelen om frågan är helt osynlig för spelarna (ren refaktorering,
byggverktyg, deploy). Är du osäker — kalla in dem.

Sammanfatta deras svar i **spelarverdikt**: 5–10 rader om vad de är eniga om, var de drar åt
olika håll, och vad de varnar för. `spelare-divine`s sakliga invändningar väger tungt — det
är den enda i rummet som märker när appen har fel om Dota.

---

## Steg 3 — Tekniska rådet

Välj ut **bara de relevanta** av:

| Agent | Kalla in när frågan rör |
|---|---|
| `arkitekt` | server.js, JSONBin, endpoints, datamodell, scripts |
| `frontend` | index.html, tv.html, allt spelarna ser i webbläsaren |
| `dhs-domanexpert` | arketyper, draft, utmaningar, TV-dramaturgi, ton, format |
| `ai-prompt` | AI-genererat innehåll, prompter, parsning, TTS, studion |

En ren promptändring behöver inte `frontend`. En CSS-fix behöver inte `ai-prompt`. Att kalla
in alla fyra på varje fråga är slöseri — men tveka inte när frågan faktiskt spänner brett.

Spawna de valda **parallellt i ett meddelande**. Varje prompt ska innehålla briefen **plus
spelarverdiktet från steg 2**. Ordningen är avsiktlig: tekniken designar mot ett användarbehov
som redan är formulerat.

---

## Steg 4 — Korselden (villkorlig)

Kör bara detta steg om något av följande gäller:

- två tekniska agenter föreslår oförenliga lösningar
- tekniken vill bygga något spelarpanelen sågat
- någon bygger vidare på ett antagande som en annan agent motsagt

Är rådet enigt — **hoppa över steget** och gå till steg 5.

Annars: återuppta de berörda agenterna med `SendMessage` (de behåller sin kontext) och skicka
motpartens position ordagrant. Fråga:

> Här är vad de andra kom fram till: [...]. Vad ändrar du i din rekommendation? Var håller du
> inte med, och vilken är den största risken i deras förslag?

En runda räcker. Detta är en diskussion, inte en förhandling till konsensus — din uppgift är
att förstå oenigheten tillräckligt väl för att kunna avgöra den.

---

## Steg 5 — Skeptikern

Skriv ihop en **syntes**: vad rådet landat i, vilka avvägningar som gjorts, vad som ska byggas.

Skicka syntesen till `skeptiker`. Den får sista ordet, alltid — även när alla är överens.
Särskilt då.

Ta dess invändningar på allvar. Säger den "bygg mindre", är utgångspunkten att den har rätt.
Går du emot den, skriv i specen varför.

---

## Steg 6 — Specen

Skriv `<scratchpad>/radslag/<slug>/spec.md` och **skriv ut den i chatten** innan du går
vidare — Oskar ska kunna avbryta med Esc.

Specen är pipelinens produkt. Den ska vara så exakt att `byggare` aldrig behöver gissa. Läs
den med en billigare modells ögon: **finns det ett enda ställe där den måste tolka?**

````markdown
# Spec: <kort titel>

## Mål
En mening om vad som ska uppnås. Ingen bakgrund, ingen motivering.

## Ändringar

### 1. <fil> — <vad>
- **Var:** funktionsnamn eller unik söksträng att ankra på. Aldrig "leta rätt på stället".
- **Före:** hur koden ser ut nu (citera).
- **Efter:** exakt vad som ska stå istället.
- **Varför:** en rad, så avvikelser går att upptäcka.

### 2. ...

## SKA INTE
- Rör inte <fil/funktion>.
- Ingen refaktorering av <X>.
- Byt inte namn på något.
- <allt annat skeptikern flaggade>

## Verifiering
```bash
node .claude/skills/radslag/check-syntax.js
```
Plus eventuella specifika kontroller.

## Kända risker
Det skeptikern flaggade och som medvetet accepterats.
````

**Berörs `server.js`:** skriv alltid ut `cp server.js server-lanstrat.js` som ett eget steg.

**Berörs en prompt i `server.js`:** kontrollera om samma prompt finns i `generate-studio.js`
och ta med båda.

---

## Steg 7 — Bygget

Spawna `byggare` med **enbart specen** som prompt. Ingen rådskontext, inget resonemang, inga
alternativ — bara utförandet. Skicka inte med briefen; specen ska stå på egna ben.

---

## Steg 8 — Granskningen

När `byggare` är klar:

1. Kör `node .claude/skills/radslag/check-syntax.js` själv. Lita inte på rapporten.
2. Läs `git diff` och jämför **rad för rad mot specen**:
   - Gjorde den exakt det som stod?
   - Rörde den något på `SKA INTE`-listan?
   - Finns ändringar som inte fanns i specen?
   - Är `server-lanstrat.js` synkad?
3. Rapportera till Oskar: vad som ändrades, om diffen matchar specen, och vad som återstår.

**Committa aldrig.** Oskar granskar och committar själv.

Drev byggaren iväg — felet ligger nästan alltid i specen, inte i modellen. Notera vad som var
otydligt så `SKA INTE`-listan kan skärpas nästa gång.

---

## Kostnadsspärrar

- Briefen först — agenter läser din sammanfattning, inte repot.
- Bara relevanta tekniska agenter kallas in.
- Steg 4 hoppas över när rådet är enigt.
- Rådsmedlemmarna har varken skrivverktyg eller `Agent`-verktyg — ingen kan ändra en fil och
  ingen kan spawna egna underagenter.
- Svar är begränsade till ~400 ord per agent.

Är frågan liten nog att svara på direkt — **säg det till Oskar istället för att kalla in
rådet**. `/radslag` är till för frågor som förtjänar ett råd, inte för varje liten fix.
