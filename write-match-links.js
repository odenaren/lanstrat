// write-match-links.js — lankar OpenDota-matcher till strategier i historik-binen
// pa riktigt: skriver openDotaMatchId, matchResult, matchConfidence per
// strategi. Samma matchningslogik som link-matches.js, men skriver istallet
// for att bara rapportera. Manuell fallback for fall som den automatiska
// bakgrundslankningen i server.js inte var sakert nog pa (se TODO.md).
//
// Anvandning:
//   node write-match-links.js <bin_id>                    <- DRY RUN
//   node write-match-links.js <bin_id> --apply             <- skriver pa riktigt
//   node write-match-links.js <bin_id> <id1> <id2> --apply  <- egna match-ID:n
//
// bin_id kan ocksa anges via .env som DEV_HISTORY_BIN_ID (eller JSONBIN_MATCHES_ID).
//
// Kraver i .env: JSONBIN_API_KEY, JSONBIN_PLAYERS_ID (spelar-binet ar delat
// mellan dev och prod, sa Steam-ID:n satta pa Hero Pool-sidan racker — samma
// monster som link-matches.js, ingen lokal player-accounts.json behovs langre).

const fs = require("fs");
const path = require("path");

try {
  const env = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  env.split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
} catch {}

if (!process.env.JSONBIN_API_KEY || !process.env.JSONBIN_PLAYERS_ID) {
  console.error("JSONBIN_API_KEY och JSONBIN_PLAYERS_ID kravs i .env (samma spelar-bin som servern anvander).");
  process.exit(1);
}

const TIME_WINDOW_BEFORE_MS = 45 * 60 * 1000; // matchen startade inom 45 min efter genererad strategi

const DEFAULT_MATCHES = [
  "8882037346", "8881971796", "8881521996", "8881401750", "8881308559",
  "8881157887", "8881063783", "8880962213", "8880765419", "8880678889",
];

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const positional = args.filter(a => a !== "--apply");
const BIN_ID = positional[0] || process.env.DEV_HISTORY_BIN_ID || process.env.JSONBIN_MATCHES_ID;
const matchIds = positional.slice(1).length ? positional.slice(1) : DEFAULT_MATCHES;

if (!BIN_ID) {
  console.error("Ange historik-binets ID: node write-match-links.js <bin_id> [match-id...] [--apply]");
  process.exit(1);
}

// Samma X-Access-Key-header som servern (server.js jsonbinRequest) — X-Master-Key
// gav tidigare 401 pa den har binens nyckeltyp, se CLAUDE.md.
const jsonbinHeaders = { "Content-Type": "application/json", "X-Access-Key": process.env.JSONBIN_API_KEY };

async function fetchMatch(matchId) {
  const res = await fetch(`https://api.opendota.com/api/matches/${matchId}`);
  if (!res.ok) throw new Error("OpenDota HTTP " + res.status);
  return res.json();
}

async function fetchPlayers() {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${process.env.JSONBIN_PLAYERS_ID}/latest`, {
    headers: { "X-Access-Key": process.env.JSONBIN_API_KEY }
  });
  if (!res.ok) throw new Error("JSONBin (spelare) HTTP " + res.status);
  const json = await res.json();
  const rec = json.record;
  return Array.isArray(rec) ? rec : (rec && rec.data) || [];
}

// Bygger account_id -> alias fran spelarnas steamId (satt pa Hero Pool-sidan).
function buildAccountToAlias(players) {
  const accountToAlias = {};
  const missing = [];
  for (const p of players) {
    if (p.steamId) accountToAlias[String(p.steamId)] = p.name;
    else missing.push(p.name);
  }
  return { accountToAlias, missing };
}

async function getBin(id) {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${id}`, { headers: jsonbinHeaders });
  if (!res.ok) throw new Error("JSONBin GET HTTP " + res.status);
  const json = await res.json();
  const candidates = [json, json.record, json.record?.matches, json.record?.games, json.record?.data, json.data];
  for (const c of candidates) if (Array.isArray(c)) return c;
  throw new Error("Kunde inte hitta en array i JSONBin-svaret");
}

async function putBin(id, data) {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${id}`, {
    method: "PUT", headers: jsonbinHeaders, body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("JSONBin PUT HTTP " + res.status + ": " + (await res.text()).slice(0, 300));
  return res.json();
}

// ---- hjaltenamn -> hero_id via OpenDotas publika heroes-endpoint (inget dotaconstants-beroende) ----
async function heroNameToIdMap() {
  const res = await fetch("https://api.opendota.com/api/heroes");
  if (!res.ok) throw new Error("OpenDota heroes HTTP " + res.status);
  const heroes = await res.json();
  const map = {};
  heroes.forEach(h => { map[h.localized_name.toLowerCase()] = h.id; });
  return map;
}

function draftHeroIds(entry, heroNameToId) {
  const draft = entry.currentDraft ?? entry.draft ?? {};
  const ids = {};
  for (const [alias, heroName] of Object.entries(draft)) {
    const id = heroNameToId[String(heroName).toLowerCase()];
    if (id != null) ids[alias] = id;
  }
  return ids;
}

async function main() {
  console.log("Hamtar spelare (Steam-ID:n) ...");
  const players = await fetchPlayers();
  const { accountToAlias, missing } = buildAccountToAlias(players);
  console.log(Object.keys(accountToAlias).length + "/" + players.length + " spelare har Steam-ID satt.");
  if (missing.length) console.log("  Saknar Steam-ID: " + missing.join(", "));

  const heroNameToId = await heroNameToIdMap();

  console.log("\nHamtar historik (" + BIN_ID + ") ...");
  const history = await getBin(BIN_ID);
  console.log(history.length + " strategier.\n");

  const results = [];
  for (const matchId of matchIds) {
    let match;
    try { match = await fetchMatch(matchId); }
    catch (e) { results.push({ matchId, error: "kunde inte hamta match — " + e.message }); continue; }

    const startMs = match.start_time * 1000;
    const matchedPlayers = [];
    for (const p of match.players) {
      const alias = accountToAlias[p.account_id];
      if (alias) matchedPlayers.push({ alias, hero_id: p.hero_id, isRadiant: p.player_slot < 128 });
    }
    if (!matchedPlayers.length) {
      results.push({ matchId, startMs, error: "inga kanda alias synliga i denna match" }); continue;
    }
    const radiantCount = matchedPlayers.filter(p => p.isRadiant).length;
    const ourSideIsRadiant = radiantCount >= matchedPlayers.length / 2;
    const ourResult = ourSideIsRadiant === match.radiant_win ? "win" : "loss";

    // Redan lankad? Hoppa over sa vi aldrig skriver over en befintlig koppling av misstag.
    const alreadyLinked = history.find(entry => String(entry.openDotaMatchId) === String(matchId));
    if (alreadyLinked) {
      results.push({ matchId, startMs, matchedPlayers, ourResult, error: "redan lankad till spel #" + alreadyLinked.gameNumber });
      continue;
    }

    const candidates = history.filter(entry => {
      if (entry.openDotaMatchId) return false; // redan lankad till nagon annan match
      const t = new Date(entry.createdAt).getTime();
      if (isNaN(t)) return false;
      const gap = startMs - t;
      return gap >= 0 && gap <= TIME_WINDOW_BEFORE_MS;
    });
    if (!candidates.length) {
      results.push({ matchId, startMs, matchedPlayers, ourResult, error: "ingen olankad strategi inom tidsfönstret" }); continue;
    }

    const scored = candidates.map(entry => {
      const heroIds = draftHeroIds(entry, heroNameToId);
      let playerScore = 0, heroScore = 0;
      for (const mp of matchedPlayers) {
        if (heroIds[mp.alias] != null) {
          playerScore++;
          if (heroIds[mp.alias] === mp.hero_id) heroScore++;
        }
      }
      return { entry, playerScore, heroScore, total: playerScore + heroScore };
    }).sort((a, b) => b.total - a.total);

    const confidence =
      matchedPlayers.length >= 3 ? "HÖG" :
      matchedPlayers.length === 2 ? "MEDEL" : "LÅG";

    const gapMin = Math.round((startMs - new Date(scored[0].entry.createdAt).getTime()) / 60000);
    results.push({ matchId, startMs, matchedPlayers, ourResult, scored, confidence, gapMin });
  }

  // Kronologisk konsistenskontroll (samma som link-matches.js)
  const withCandidates = results.filter(r => r.scored && r.scored.length);
  withCandidates.sort((a, b) => a.startMs - b.startMs);
  let lastGameNumber = -Infinity;
  for (const r of withCandidates) {
    let chosen = r.scored.find(c => c.entry.gameNumber >= lastGameNumber);
    if (!chosen) chosen = r.scored[0];
    r.chosen = chosen;
    lastGameNumber = chosen.entry.gameNumber;
  }

  // ---- Rapport + forbered skrivning ----
  let toWrite = 0;
  for (const r of results) {
    console.log("=".repeat(70));
    console.log("MATCH " + r.matchId);
    if (r.error) { console.log("  " + r.error); continue; }

    const best = r.chosen;
    console.log(
      "  spel #" + best.entry.gameNumber + ' "' + best.entry.name + '" — ' +
      r.ourResult + " (konfidens: " + r.confidence + ", " + r.gapMin + " min gap)"
    );

    best.entry.openDotaMatchId = r.matchId;
    best.entry.matchResult = r.ourResult;
    best.entry.matchConfidence = r.confidence;
    best.entry.matchedPlayers = r.matchedPlayers.map(p => p.alias);
    toWrite++;
  }

  console.log("\n" + toWrite + " strategier skulle uppdateras med matchlänk.");

  if (!APPLY) {
    console.log("\nDRY RUN — inget skickat. Kör med --apply för att skriva till binen.");
    return;
  }

  const backupFile = path.join(__dirname, "dev-bin-backup-" + Date.now() + ".json");
  fs.writeFileSync(backupFile, JSON.stringify(history, null, 2));
  console.log("\nBackup sparad: " + backupFile);

  await putBin(BIN_ID, history);
  console.log("Klart. " + toWrite + " strategier uppdaterade.");
}

main().catch(e => { console.error("Fel:", e.message); process.exit(1); });
