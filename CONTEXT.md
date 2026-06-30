# DHS Dreamhack Skyrup — Projektkontex

## Vad är detta?
Webbapplikation för Dota 2-draft och strategigenerering för ett årligt LAN-event kallat "Dreamhack Skyrup" (DHS). Byggd av Oskar (mekanikingenjör, inte mjukvaruutvecklare) tillsammans med Claude AI. Oskar jobbar primärt från telefon.

## Spelarna
Rutigaskjortan, Elsa, Pax, Jockwe, Flabben, Tobbe, Gojja, Robin Hood, Skiipa

---

## Teknisk stack
- **Server:** Node.js + Express (`laneight/server.js`)
- **Frontend:** Single-page HTML (`laneight/public/index.html`) — all CSS och JS inline i en fil
- **Hosting:** Railway (`lanstrat-production.up.railway.app`)
- **Repo:** `github.com/odenaren/lanstrat` (all kod i undermappen `laneight/`)
- **Data:** JSONBin.io (persistent lagring, överlever Railway-deploys)
- **AI:** Anthropic API (`claude-sonnet-4-6`)

## Railway-miljövariabler
```
ANTHROPIC_API_KEY
JSONBIN_API_KEY
JSONBIN_PLAYERS_ID
JSONBIN_MATCHES_ID
```

---

## Kritisk regel: Inga nestade backticks i JavaScript
Detta är det vanligaste felet i projektet. JavaScript kraschar om man har template literals inuti template literals:

```javascript
// FEL — kraschar hela sidan tyst
item.innerHTML = `${condition ? `<span>text</span>` : `<span>annat</span>`}`;

// RÄTT — använd alltid strängsammansättning för HTML-strängar
var html = condition ? '<span>text</span>' : '<span>annat</span>';
item.innerHTML = '<div>' + html + '</div>';

// RÄTT — använd DOM-element för komplex HTML
var el = document.createElement('div');
el.textContent = name;
parent.appendChild(el);
```

## Syntaxkontroll efter varje ändring
```bash
python3 -c "
content = open('laneight/public/index.html', encoding='utf-8').read()
s = content.index('<script>') + 8
e = content.rindex('</script>')
open('/tmp/check.js', 'w', encoding='utf-8').write(content[s:e])
"
node --check /tmp/check.js
```

---

## Datamodell

### Player (sparas i JSONBin PLAYERS_ID)
```json
{
  "name": "RUTIGASKJORTAN",
  "heroes": [1, 5, 28, 36, 88]
}
```

### Match (sparas i JSONBin MATCHES_ID)
```json
{
  "id": "1234567890",
  "createdAt": "2026-06-25T17:00:00Z",
  "name": "Fem man push mot torn",
  "briefing": "Kaptensbriefing max 4 meningar...",
  "captainNotes": "Valfri fritext från kaptenen",
  "strategy": "Original strategitext",
  "currentStrategy": "Uppdaterad strategi efter bans",
  "draft": { "RUTIGASKJORTAN": "Axe" },
  "currentDraft": { "RUTIGASKJORTAN": "Sven" },
  "wildcard": false,
  "style": "standard",
  "players": [{ "name": "RUTIGASKJORTAN", "heroes": [1,5,28] }],
  "enemies": ["Crystal Maiden", "Invoker"],
  "items": "Itemtips-text...",
  "result": "win",
  "banned": ["Axe"],
  "excludeFromMemory": false
}
```

---

## Server API (server.js)

| Metod | Endpoint | Beskrivning |
|-------|----------|-------------|
| GET | /api/players | Alla spelare |
| POST | /api/players | Lägg till `{name}` |
| PUT | /api/players/:name/heroes | `{heroes:[id,...]}` |
| PUT | /api/players/:name/rename | `{newName}` |
| DELETE | /api/players/:name | Ta bort spelare |
| GET | /api/matches | Alla matcher |
| POST | /api/matches | Spara ny match |
| GET | /api/matches/:id | Hämta match |
| PUT | /api/matches/:id/enemies | `{enemies:[]}` |
| PUT | /api/matches/:id/items | `{items:"..."}` |
| PUT | /api/matches/:id/result | `{result:"win"/"loss"/null}` |
| PUT | /api/matches/:id/memory | `{excludeFromMemory:bool}` |
| PUT | /api/matches/:id/banned | `{banned:[]}` |
| PUT | /api/matches/:id/strategy | `{strategy:"...", draft:{}}` |
| DELETE | /api/matches | Rensa all historik |
| DELETE | /api/matches/:id | Ta bort match |
| POST | /api/strategy | `{prompt, maxTokens?}` → `{text}` |
| POST | /api/items | `{prompt}` → `{text}` |

---

## Frontend (index.html)

### Sidor
- `page-home` — spelarlista
- `page-picker` — hero pool-väljare per spelare
- `page-match` — välj spelare + generera strategi
- `page-history` — matchhistorik
- `page-detail` — detaljvy för en match

### Viktiga globala variabler
```javascript
let players = [];
let currentPlayer = null;
let currentSelected = new Set();
let matchPlayers = new Set();
let ignorePlayerPools = new Set();
let currentMatchId = null;
let currentMatchData = null;
let currentBanned = new Set();
let currentEnemies = new Set();
let currentDraft = {};
```

### URL-parametrar
- `?mode=pool` — döljer Matchen och Historik, bara hero pool-väljaren visas (för utskick innan lanet)
- `?player=N` — öppnar direkt hero picker för spelare N

---

## Strategigenerering

### AI-promptens struktur
1. **Arketyp** (hemlig, slumpas) — styr spelstil, visas ALDRIG för spelarna
2. **Hero pools** per spelare + nyligen spelade hjältar (3 matcherscooldown)
3. **Laning-kontext** (3/4/5 spelare)
4. **Presentationsstil** (slumpas, 50% standard, 50% rolig stil)
5. **Kaptenens fritext-instruktioner**

### AI returnerar i detta exakta format
```
DRAFT_JSON_START
{"name":"Strateginamn på svenska","draft":{"SPELARNAMN":"Hjältnamn"}}
DRAFT_JSON_END

KAPTENSBRIEFING_START
Max 4 meningar. Kaptenen läser högt för laget.
KAPTENSBRIEFING_END

Strategitext med max 3 rubriker...
```

### 13 arketyper (osynliga för spelare)
Deathball, Early Snowball, Gank & Dominate, Teamfight, Pick-off, Poke & Siege, Late Game Scaling, Splitpush, Chaos & Disruption, Objective Control, Tower Dive Heavy, Global Presence, Magic Immune

### 8 presentationsstilar
Standard (50% chans), Militärbrief, Sportkommentator, Managerbrev, Spelarkort, Kriminaldrama, Telegram, Naturprogram

### Wild Card (~25% chans)
Slumpas oberoende av stilen. Ger AI:n friare tyglar. Markeras med 🎲 i UI.

---

## Hjältbilder
CDN: `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/{slug}.png`

Fyra hjältar har fel slug och har hardkodade overrides i `HERO_IMG_OVERRIDES`:
- ID 13: kunkka
- ID 35: undying  
- ID 90: enchantress
- ID 99: lion

---

## Git-workflow
- `main` — alltid stabil, live på Railway
- `dev` — all utveckling sker här
- Testa i dev, merga till main när det fungerar

## Kända förbättringsförslag (ej implementerat)
- Streaming av strategitext för realtids-progression
- PIN-skydd för Matchen/Historik-flikarna innan lanet
- Hjältporträtt i historiklistan fungerar delvis (mixad syntax)
