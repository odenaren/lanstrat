# Laneight Strategy

Dota 2 hero pool manager och draft-strategi för LAN-event.

## Deploy till Railway

### 1. Skapa GitHub-repo

```bash
cd laneight
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/DITTNAMN/laneight-strategy.git
git push -u origin main
```

### 2. Deploy på Railway

1. Gå till [railway.app](https://railway.app) och logga in med GitHub
2. Klicka **New Project → Deploy from GitHub repo**
3. Välj ditt `laneight-strategy`-repo
4. Railway känner automatiskt igen Node.js och kör `node server.js`
5. Klicka **Generate Domain** under Settings → Networking
6. Du får en URL typ `https://laneight-strategy.up.railway.app`

### 3. Dela med spelare

Skicka spelarnas individuella länkar:
- Spelare 0: `https://din-url.railway.app?player=0`
- Spelare 1: `https://din-url.railway.app?player=1`
- osv.

Eller skicka bara `https://din-url.railway.app` och låt dem navigera själva.

## Köra lokalt

```bash
npm install
npm start
```

Öppna `http://localhost:3000`

## API

| Metod | Endpoint | Beskrivning |
|-------|----------|-------------|
| GET | /api/players | Hämta alla spelare |
| POST | /api/players | Lägg till spelare `{ name }` |
| PUT | /api/players/:name/heroes | Uppdatera hero pool `{ heroes: [id, ...] }` |
| DELETE | /api/players/:name | Ta bort spelare |

## Datalagring

Spelarpooler sparas i `data/players.json` på servern. Railway-disken är persistent så länge projektet är aktivt.
