# TESTPLAN — DHS Playbook

Metod för att systematiskt hitta buggar/kvalitetsproblem i en app utan tester och utan CI.
Skriven 2026-07-27 efter en session där tre metoder — data-arkeologi, levande genomkörning i
webbläsaren, och spelarpanelen (`/radslag`) — hittade betydligt mer än ren kodläsning gjorde
(bl.a. 15 skadade matcher, en dubbel-skärm-bugg i tv.html, och okalibrerade utmaningströsklar
som ingen kodgranskning hade fångat).

**Princip:** kodläsning hittar det som ser fel ut. De här tre metoderna hittar det som ser
*rätt ut i koden men fel ut i verkligheten* — vilket historiskt varit den farligare kategorin
här. Kör dem som ett komplement till, inte ersättning för, vanlig granskning.

Ingen av metoderna kräver ny tooling. Allt görs med verktyg som redan finns i den här sessionen.

---

## 1. Data-arkeologi

Hämta riktig data från dev-JSONBin (`JSONBIN_MATCHES_ID`/`JSONBIN_PLAYERS_ID`/`JSONBIN_DRAFTPOOLS_ID`
i `.env`) och leta mönster över *hela* säsongen, inte bara senaste matchen. Mönstret som
fungerade: para ihop två fält som BORDE stämma överens (t.ex. `strategy` vs `currentStrategy`,
där det ena är "original" och det andra "original + tillägg") och leta efter fall där det andra
är *kortare* än det första — ett tecken på att något skrivit över istället för att lägga till.

**Kör en runda när:** ny funktion har landat som skriver till matchdata, eller minst en gång
per säsonghalva.

**Konkreta par/checkar att köra nästa gång, inte gjorda än:**
- `currentDraft` vs `draft` — samma typ av "ska bara växa/uppdateras, aldrig krympa
  oväntat"-relation som `currentStrategy`/`strategy` hade. Finns matcher där `currentDraft`
  saknar spelare som `draft` har?
- **Arketyp-gissningar gjorda under "13 arketyper"-buggen** (fixad 2026-07-27, commit i denna
  session) — alla matcher med `archetypeGuessed:true` och `createdAt` före den fixen gissades
  av en AI som fick en prompt som sa "13" men listade 21. Är gissningarna systematiskt sneda
  (klumpar de ihop mot ett fåtal arketyper)? Värt en ny körning av `analyzeArchetypes()`-logiken
  mot bara de gamla gissningarna för att se om resultatet ändras.
- **Itemtips-kvalitet över säsongen** — samma typ av "läs 4-5 riktiga exempel i sin helhet"
  som gjordes för strategitext. Har `match.items` samma klass av dolda skador (trunkering,
  tomt fält, AI-förvirring sparad som innehåll)?
- **`challengeResults` vs faktiskt OpenDota-utfall** — stickprov: öppna 3-4 länkade matcher,
  jämför appens `passed`/`level`-fält mot att manuellt räkna ut samma sak från rådatan. Fångar
  fel i `evalChallenge`-logiken som annars aldrig syns förrän någon ifrågasätter ett utfall.
- **Olänkade matcher** — hur många av 48 saknar `openDotaMatchId` trots att de borde gå att
  länka (matchen spelades, OpenDota har datan)? Om många: `findOpenDotaCandidates`-heuristiken
  kanske missar mer än den borde.

**Verktyg:** `curl` mot JSONBin med `X-Access-Key` (finns redan i `.env`) + ett litet
`node -e "..."`-script per fråga. Fem minuter per check. Spara alltid en lokal kopia av rådatan
i scratchpad innan analys — den blir gratis backup om något behöver rullas tillbaka.

---

## 2. Levande genomkörning i webbläsaren

Starta en lokal statisk server för `public/` (ingen backend behövs för ren UI-granskning; för
flöden som pratar med API:t, peka mot `dhs27.up.railway.app` med `SITE_PASSWORD` i `.env`) och
klicka igenom faktiska flöden i Browser-verktyget — inte bara läs koden som ska rendera dem.

**Varför det hittar saker kodläsning inte gör:** `tv.html`s dubbel-skärm-bugg (§ denna sessions
fynd) var *logiskt* korrekt kod (`show()`-funktionen gjorde rätt sak) — felet var ett CSS-defaultvärde
som bara syns om man faktiskt laddar sidan och tittar. `getComputedStyle()` i webbläsaren
avslöjade det på sekunder; det hade kunnat missas för alltid i en ren kodgranskning.

**Flöden att köra igenom, prioritetsordning:**
1. **Hela draft→match-kedjan i `/tv`:** hero reveal → hype → briefing → utmaningsskärm →
   (simulera matchslut) → Eftersnack/studio. Kör hela vägen minst en gång per större
   `tv.html`-ändring. Kolla särskilt övergångar mellan skärmar (där dubbel-skärm-buggen satt).
2. **LAN-reset-modalen** — beskrevs som föredömlig UX i en tidigare granskning men har inte
   testats igen sedan dess. Bekräfta att den fortfarande fungerar efter senare ändringar.
3. **Hero Pool Manager end-to-end** — välj hjältar, spara, ladda om sidan, bekräfta att det
   som sparades faktiskt är det som visas (autospar-buggen som redan är känd, se TODO.md,
   är ett bra exempel på vad den här sortens test hittar).
4. **Mobilvy** — HUD-reskinnet (TODO.md, "Designlaboration") har ett öppet "kvarstår: finlir
   mot rendern i mobil" som aldrig verifierats. `resize_window`-verktyget till `mobile`-preset,
   klicka igenom Nu/Strats/Säsong/Trupp.
5. **Nedladdningsbara konfigfiler** — `/api/overlay-config` och `/api/gsi-config` (bakom Basic
   Auth). Bekräfta att de faktiskt genererar giltig JS/`.cfg` efter serverändringar som rört
   `PUBLIC_URL` eller närliggande kod.

**Verktyg:** `mcp__Claude_Browser__*` (redan använt denna session). `preview_start` med en
enkel `node -e "http.createServer(...)"` för statisk `public/`-servering, eller `navigate`
direkt mot dhs27 för fulla API-flöden.

---

## 3. Spelarpanelen (`/radslag`) på fler ytor

Samma metod som gav utmaningskalibreringsfyndet: hämta RIKTIGT innehåll (aldrig påhittat,
arbetsregel 8), skriv en brief med konkreta citat, spawna `spelare-ny`/`spelare-archon`/
`spelare-divine` parallellt, låt dem reagera blint utan att veta vad du redan misstänker.

**Ytor som ännu inte fått den behandlingen:**
- **Itemtips i sin helhet** — bara strategitext och utmaningar har granskats än. Hämta 4-5
  riktiga `match.items`-texter, låt divine bedöma om tipsen faktiskt är vettig Dota (rätt
  items mot rätt hjältetyper, rimliga timing-fönster).
- **Studioanalysens repliker (Eftersnack)** — hämta ett riktigt studiomanifest (`GET
  /studio/:odId/manifest.json` mot en länkad match) och låt panelen bedöma tonen: känns
  panelen som neutrala broadcasters (CLAUDE.md-regeln), eller läcker den lagkänsla den inte
  ska ha? Håller kommentarerna vad statistiken faktiskt visar?
- **TV-dramaturgin som helhetsupplevelse** — inte buggar, utan känsla: känns tempot i
  hype→briefing→reveal→utmaningar rätt, eller drar det ut på tiden? Det här kräver panelen,
  inte kod, eftersom det är en smaksak ingen kodgranskning kan avgöra.
- **Personliga utmaningars TEXT (inte bara trösklarna)** — nu när kalibreringen är fixad,
  kör en ny runda specifikt på om utmaningstexterna känns kul/personliga eller mallmässiga
  över tid (samma typ av repetitions-risk som season-krokarna hade).
- **Säsong-sidans statistiksektioner** — hela sidan (per spelare-tabell, hjältevariation,
  utmaningsrekord, de nya studio/parsad-badgesen) har byggts och ändrats bit för bit över tid
  utan att panelen någonsin fått en brief om helheten. Upptäckt 2026-07-28 när tre sektioner
  (arketyp-reveal, presentationsstilar, match-reveal-tabellen) visade sig ge "liksom inte så
  mycket" och togs bort på Oskars eget omdöme, inte via panelen — precisionen hade varit högre
  om spelare-ny/archon/divine fått reagera på en skärmdump av hela sidan innan sektioner
  byggdes eller togs bort.

**Process:** samma pipeline som redan finns i `.claude/skills/radslag/SKILL.md` — brief med
riktiga citat, spelarpanel parallellt, teknisk rådgivning om något är byggbart, skeptiker
innan spec. Inget nytt att bygga här, bara att köra den befintliga processen på nya ytor.

---

## Vad som medvetet INTE är med i den här planen

- **Teknisk djupgranskning av OCR-flödet/pub-strategi** (Oskar avböjde detta fokus
  2026-07-27) — kvarstår som ett alternativ om intresse uppstår senare, men inte prioriterat nu.
- **Ny tooling/dashboard för att automatisera detta.** Tre manuella metoder som redan fungerar
  är bättre än ett fjärde system att underhålla, för en app utan CI och utan tester.
- **En fast cadence/schema.** Ingen anledning att tvinga in detta i ett veckoschema — kör en
  runda när det känns läge (efter en större ändring, inför ett LAN, eller när något känns
  "lite off" utan att man kan sätta fingret på varför).
