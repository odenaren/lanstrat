# DHS Dreamhack Skyrup — The Playbook

Webbapp för Dota 2-draft, strategigenerering och TV-produktion för ett årligt LAN ("Dreamhack Skyrup", DHS) med nio spelare. Byggd av Oskar (mekanikingenjör, inte utvecklare) tillsammans med Claude. Tänk "ESL-produktion för nio polare i en källare".

**Spelarna:** Rutigaskjortan, Elsa, Pax, Jockwe, Flabben, PUGGE (alias Tobbe/TOBBE), Gojja, Robin Hood, Skiipa. Oskar avslöjar inte vilken spelare han är — behandla alla nio neutralt i analys och genererat innehåll.

---

## ARBETSREGLER — läs detta först

1. **Minsta möjliga ändring.** Rör så få filer och rader som möjligt. Skriv aldrig om fungerande kod "för att städa". Över-patchning är projektets största återkommande frustration.
2. **Verifiera innan du bygger.** Anta aldrig hur ett API, en endpoint eller en datastruktur beter sig — kontrollera i koden, testa mot API:t, eller fråga. Gissa aldrig sannolikhets- eller urvalslogik: simulera med ett litet testscript innan implementation.
3. **Syntaxkontroll efter VARJE ändring** (se kommandon nedan). Detta är obligatoriskt före commit.
4. **Inga nestade backticks i JavaScript.** Template literals inuti template literals kraschar hela sidan TYST. Använd alltid strängkonkatenering eller DOM-element för HTML-strängar:
   ```javascript
   // FEL — kraschar tyst
   el.innerHTML = `${cond ? `<span>a</span>` : `<span>b</span>`}`;
   // RÄTT
   var html = cond ? '<span>a</span>' : '<span>b</span>';
   el.innerHTML = '<div>' + html + '</div>';
   ```
5. **`server.js` är entry point** (`package.json` → `node server.js`). `server-lanstrat.js` ska hållas som identisk kopia av `server.js` — patcha ALDRIG bara den ena. Vid ändring: patcha `server.js`, kopiera till `server-lanstrat.js`.
6. **Vid stora filändringar:** föredra hel-filsersättning över många små partiella patchar (funktioner har tidigare försvunnit i iterativ patchning). Verifiera med diff mot originalet att inget oavsiktligt försvunnit.
7. **Svenska i UI och genererat spelarinnehåll.** Engelska finns för Captain's Briefing (`briefingEn`), TV-announcer och studiopanelen. Kodkommentarer: svenska utan å/ä/ö går bra (etablerat mönster).
8. **Faktisk korrekthet före approximation** — hitta aldrig på data, siffror eller draft-detaljer.

## Git & deploy

- **`dev`** — all utveckling. Deployar automatiskt till `dhs27.up.railway.app`.
- **`main`** — stabil backup, prod (`lanstrat-production.up.railway.app`). Merga från dev först när det är verifierat i dev-miljön.
- All kod ligger i **repo-roten** (ingen undermapp).
- Committa med korta beskrivande meddelanden på svenska eller engelska. Pusha till `dev` — aldrig direkt till `main` utan att fråga.
- Railway är testmiljön; servern körs sällan lokalt. Statiska filer deployas dåligt på Railway — använd GitHub Pages/Netlify Drop för fristående statiskt.

## Syntaxkontroll (obligatorisk före commit)

```bash
# Serverfiler och scripts
node --check server.js

# Inline-JS i HTML-filer (index.html, tv.html, ...)
python3 -c "
content = open('public/index.html', encoding='utf-8').read()
s = content.index('<script>') + 8
e = content.rindex('</script>')
open('/tmp/check.js', 'w', encoding='utf-8').write(content[s:e])
"
node --check /tmp/check.js
```

Har filen flera `<script>`-block: extrahera varje block med `re.findall(r'<script>(.*?)</script>', content, re.S)` och kör `node --check` per block.

---

## Teknisk stack

- **Server:** Node.js + Express — `server.js`
- **Frontend:** Single-page HTML med inline CSS/JS — `public/index.html` (Playbook), `tv.html` (TV-läget), `pool.html` (hero pool-import)
- **Hosting:** Railway (dev: `dhs27.up.railway.app`, prod: `lanstrat-production.up.railway.app`)
- **Data:** JSONBin.io (Pro, 10MB-bins) — persistent över deploys. OBS: bins kan inte skapas med tomma arrayer, initiera med giltig struktur `{data: []}`.
- **AI:** Anthropic API, modell `claude-fable-5`
- **TTS:** ElevenLabs (`eleven_multilingual_v2`); `previous_text`/`next_text` används för prosodi i dialoger
- **Matchdata:** OpenDota API. Steam API är övergivet (`GetMatchDetails` ger kroniskt 500).

### Miljövariabler (Railway + lokal `.env`)
`ANTHROPIC_API_KEY`, `JSONBIN_API_KEY`, `JSONBIN_PLAYERS_ID`, `JSONBIN_MATCHES_ID`, `JSONBIN_DRAFTPOOLS_ID`, `SITE_PASSWORD`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `GSI_TOKEN` (delad hemlighet mot Dota 2:s gamestate_integration-cfg, se `/api/gsi`), `PUBLIC_URL` (valfri — bas-URL som bakas in i de nedladdningsbara `/api/gsi-config`- och `/api/overlay-config/:alias`-filerna, faller tillbaka på `https://dhs27.up.railway.app` om ej satt)

Lokala scripts läser `.env` i repo-roten (skyddad av `.gitignore`). Prod-historikens bin-id: `6a3c3d6bda38895dfef96973` (hårdkodad i `link-matches.js`).

---

## Filkarta

| Fil | Roll |
|---|---|
| `server.js` | **Entry point.** Express, JSONBin-CRUD, strategi-/item-AI, hype-TTS, studio-generering (`/api/studio-generate/:id`), studio-play, replay, status-polling |
| `server-lanstrat.js` | Identisk kopia av server.js (hålls synkad, se arbetsregel 5) |
| `public/index.html` | Playbook: spelare, pools, strategigenerering, historik, detaljvy m. OpenDota-statistik + studiospelare |
| `public/tv.html` | Cinematisk TV: hero reveals m. TTS, hype, fight card, studiosändning ("Eftersnack"). Polling mot `/api/status` med `replayToken`/`studioToken` |
| `public/pool.html` | Hero pool-import (`/pool`, egen JSONBin-bin). **Används sannolikt inte längre** (2026-07-11) — Hero Pool Manager-sidan i `index.html` är den aktiva ytan för spelarnas hjältepooler. Bygg inte nya funktioner här utan att fråga först. |
| `generate-studio.js` | CLI: generera studioanalys per länkad match (samma logik finns i server.js — håll prompterna synkade) |
| `analyze-match.js` | Äldre trerosts-recap → fristående HTML m. inbäddad base64-audio |
| `link-matches.js` | Dry-run: föreslå koppling OpenDota-match ↔ strategi (45 min-fönster, strategi före match) |
| `bank-studio.js` / `.html` | Caster line bank-studio (localhost:4600) |
| `bank-config.json` | Röst-id:n: host, analytic (kvinnlig analytiker), analytic2 (manlig analytiker) |
| `recap-history.json` | Anti-repetition för studio/recaps (senaste vinklarna) |

**GSI/LAN-servern** ligger i det separata repot `laneight` (körs lokalt, port 3333/3334): Dota 2 GSI-events → Axis D4200-VE-strobe/ljud via VAPIX, live AI-caster, `caster-config.json`. Rör inte det repot från denna arbetsyta.

---

## Datamodell (JSONBin)

**Player:** `{ name, heroes: [heroId...], challengePool: [...], steamId: "32-bit OpenDota account_id eller null" }`

**Match** (viktigaste fälten):
```json
{
  "id": "…", "createdAt": "ISO", "gameNumber": 1, "name": "Strateginamn",
  "briefing": "sv", "briefingEn": "en", "captainNotes": "…",
  "strategy": "ORIGINAL — skriv aldrig över",
  "currentStrategy": "original + appendade draftändringar",
  "draft": { "ALIAS": "Hjälte" }, "currentDraft": { "ALIAS": "Hjälte" },
  "archetype": "deathball|…", "wildcard": false, "style": "standard",
  "hype": "…", "hypeSpoken": "…", "fightCard": {},
  "banned": [], "enemies": [], "items": "…",
  "result": "win|loss|null", "matchResult": "sätts vid OpenDota-länkning",
  "openDotaMatchId": "sätts av write-match-links",
  "studioBinId": "JSONBin-bin med studioanalysens manifest (text + per-replik binId:n), satt vid generering",
  "challenges": [{ "alias": "ALIAS", "text": "sv", "metric": "OpenDota-fält", "op": ">=|<=", "value": 8 }],
  "excludeFromMemory": false
}
```

Viktigt: `strategy` = originalet, bevaras alltid. Draftändringar efter bans **appendas** till `currentStrategy` som en `### Draftändring efter bans`-sektion — ersätt aldrig. Känd inkonsekvens: `result` (sätts manuellt) vs `matchResult` (sätts vid länkning) — kod som läser resultat ska prova båda.

## Strategigenerering (index.html)

- **21 hemliga arketyper** (visas ALDRIG för spelarna före match): Deathball, Early Snowball, Gank & Dominate, Teamfight, Pick-off, Poke & Siege, Late Game Scaling, Splitpush, Chaos & Disruption, Objective Control, Tower Dive Heavy, Global Presence, Magic Immune, Roshan & Aegis Timing, Vision & Info Warfare, Powerspike Rush, Counter-Draft Trap, Trilane Domination, Buyback Denial, Smoke Timing Chain, Role-Swap Draft. OBS: "Chaos & Disruption" ska ALLTID ha ett konkret vinstvillkor (kaoset är metoden, inte avsaknad av plan) — reviderad 2026-07-11 efter att arketypen visade sig vara den vanligaste (delvis pga att den fungerar som slasktratt i den retroaktiva AI-gissningen på statssidan för matcher utan sparad arketyp).
- **8 presentationsstilar** (Standard 50%, resten slumpas), **wildcard ~15%** oberoende av stil
- AI-svaret parsas via markörer: `DRAFT_JSON_START/END`, `KAPTENSBRIEFING_START/END` — ändra aldrig formatet utan att uppdatera parsern samtidigt

## Studioanalysen ("Eftersnack")

- Genereras via knapp i detaljvyn (`POST /api/studio-generate/:id`) eller CLI (`node generate-studio.js`)
- **Lagring:** VARJE replik får sin egen JSONBin-bin (bara `{audioBase64}`), plus en liten manifest-bin per match (text + varje repliks `binId`, inget ljud). Manifest-bin-id:t sparas som `studioBinId` på matchen i matches-binen. Servern (`server.js`) exponerar `/studio/:odId/manifest.json` och `/studio/:odId/:file` som dynamiska routes som slår upp matchen via `openDotaMatchId`, hämtar manifestet, letar upp rätt repliks bin och skickar tillbaka JSON/mp3 — Playbook och `/tv` pratar mot samma URL:er som förut, oförändrat på frontend.
- **Varför inte disk:** Railways filsystem är efemärt vid varje deploy (`public/studio/` skulle nollställas). JSONBin ligger utanför appens filsystem och överlever alltid.
- **Varför en bin per replik, inte en delad bin per match:** verifierat mot API:t (inte antaget) — JSONBins nginx-proxy svarar 413 på requests över exakt 1MiB (1 048 576 bytes), oavsett vad "10MB Pro-bin" faktiskt syftar på (troligen lagring, inte uppladdningsstorlek). En hel matchs ljud (flera MB) får aldrig plats i ett enda POST/PUT. `STUDIO_MAX_BIN_BYTES` i server.js sätter taket till 900KB per bin (marginal under 1MiB) — överskrids det kastas ett tydligt fel istället för 413 eller tyst korruption.
- Panelen är **neutrala broadcasters**: får aldrig säga "our team/we/us" — refererar till "the DHS squad", smeknamn etc. (regeln ligger i prompten i server.js OCH generate-studio.js — håll dem synkade)
- Ingen bakgrundsmusik under studiosändning på TV:n

## Personliga utmaningar

- Genereras i bakgrunden (server.js `generateChallengesForMatch`) när matchen sparas via `POST /api/matches` — sparas som `challenges` på matchen. AI väljer ur fast metric-meny (`CHALLENGE_METRICS`), anpassat efter roll/hjälte i strategin.
- Visas: TV:n (egen skärm efter briefingen — hämtar om matchen eftersom genereringen är asynkron), Playbook-detaljvyn (lila box; utfall i statistikkortet när matchen är länkad), och studiopanelens prompt får verifierade utfall (`personal_challenges` i MATCH DATA + `challengeResults` i manifestet).
- Verifiering: `evalChallenge` i server.js (och motsvarande klientlogik i index.html) — jämför OpenDota-fältet mot `op`/`value`. Ingen poängliga (beslut 2026-07-11): bara ära per match.
- GSI/caster-repot läser utmaningarna via `GET /api/matches/:id` (`challenges`-fältet) för live-kommentarer om progress — inget mer API behövs härifrån.

## Övriga fällor

- **Hjältebilder:** `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/{slug}.png` — fyra hardkodade slug-overrides i `HERO_IMG_OVERRIDES` (id 13 kunkka, 35 undying, 90 enchantress, 99 lion)
- **Statistik:** kills/guld i teamfights redovisas alltid **netto mot motståndarna**, inte bara vårt eget delta
- **PUGGE** har alias Tobbe/TOBBE — statssidan mergar dem; ta höjd för det i all aggregering
- **CSP** är satt i server.js — nya externa resurser (CDN, API) måste läggas till där, annars blockeras de tyst
- **JSONBin-headers:** servern använder `X-Access-Key`; vissa äldre scripts `X-Master-Key` — kontrollera vilket när ett script får 401
- **Lokal körning:** `server.js` läser aldrig `.env` själv (inget `dotenv`-anrop) — den förlitar sig på att Railway sätter miljövariablerna på plattformsnivå. Lokalt måste `.env` laddas in i skalmiljön manuellt innan `node server.js` körs, annars kraschar servern vid start (`initBins` försöker skapa nya JSONBin-bins istället för att läsa befintliga). Git Bash: `set -a; source .env; set +a; node server.js`.
