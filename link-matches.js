// link-matches.js — foreslar koppling mellan OpenDota-matcher och genererade
// strategier i historik-binen. Skriver INGENTING — bara en rapport att
// verifiera mot verkligheten (dry run enligt projektets etablerade monster).
//
// Matchningslogik:
//   1. Hamta match fran OpenDota -> start_time, spelarnas account_id + hero_id
//   2. Identifiera vilka av vara 9 alias som spelade (via steamId i spelar-binet)
//   3. Filtrera strategier vars createdAt ligger i ett tidsfonster runt start_time
//   4. Poangsatt varje kandidat: hur manga matchade alias + hur manga hjaltar
//      (currentDraft foredras over draft) stammer mot faktiska hero_id
//   5. Basta kandidat = forslag. Nara/oklara fall flaggas for manuell koll.
//
// Anvandning: node link-matches.js [match_id1 match_id2 ...]
// Utan argument: kor mot de 10 kanda matcherna.
//
// Kraver i .env: JSONBIN_API_KEY, JSONBIN_PLAYERS_ID (spelar-binet ar delat
// mellan dev och prod, sa Steam-ID:n satta pa Hero Pool-sidan racker)

const fs = require("fs");
const path = require("path");

// ---- .env (samma monster som ovriga skript) ----
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

const HISTORY_BIN_ID = "6a3c3d6bda38895dfef96973"; // prod-historiken (inte dhs27/dev)
const TIME_WINDOW_BEFORE_MS = 45 * 60 * 1000; // matchen startade inom 45 min efter genererad strategi

const DEFAULT_MATCHES = [
  "8882037346", "8881971796", "8881521996", "8881401750", "8881308559",
  "8881157887", "8881063783", "8880962213", "8880765419", "8880678889",
];

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
// Returnerar ocksa vilka alias som saknar Steam-ID, sa man kan flagga dem.
function buildAccountToAlias(players) {
  const accountToAlias = {};
  const missing = [];
  for (const p of players) {
    if (p.steamId) accountToAlias[String(p.steamId)] = p.name;
    else missing.push(p.name);
  }
  return { accountToAlias, missing };
}

// ---- hjaltenamn -> hero_id via dotaconstants ----
let heroNameToId = {};
try {
  const heroes = require("dotaconstants").heroes; // { "1": { localized_name: "Anti-Mage", ... }, ... }
  for (const [id, h] of Object.entries(heroes)) {
    heroNameToId[h.localized_name.toLowerCase()] = Number(id);
  }
} catch (e) {
  console.error("VARNING: kunde inte lasa dotaconstants heroes — hjaltematchning hoppas over.", e.message);
}

async function fetchMatch(matchId) {
  const res = await fetch(`https://api.opendota.com/api/matches/${matchId}`);
  if (!res.ok) throw new Error("OpenDota HTTP " + res.status);
  return res.json();
}

async function fetchHistory() {
  const headers = {};
  if (process.env.JSONBIN_API_KEY) headers["X-Master-Key"] = process.env.JSONBIN_API_KEY;
  const res = await fetch(`https://api.jsonbin.io/v3/b/${HISTORY_BIN_ID}`, { headers });
  if (!res.ok) throw new Error("JSONBin HTTP " + res.status);
  const json = await res.json();

  // Prova kanda JSONBin-former (v3 wrappar oftast i "record", men vi tar inget for givet)
  const candidates = [json, json.record, json.record?.matches, json.record?.games, json.record?.data, json.data];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }

  // Inget av det stamde — skriv ut strukturen sa vi kan se den faktiska formen
  console.error("Kunde inte hitta en array i JSONBin-svaret.");
  console.error("Topplavel-nycklar:", Object.keys(json));
  if (json.record && typeof json.record === "object" && !Array.isArray(json.record)) {
    console.error("record-nycklar:", Object.keys(json.record));
  }
  fs.writeFileSync(path.join(__dirname, "history-raw-debug.json"), JSON.stringify(json, null, 2));
  console.error("Fullstandigt svar sparat i history-raw-debug.json — oppna den och visa strukturen.");
  throw new Error("Okant format pa historik-binen, se diagnostik ovan");
}

function draftHeroIds(entry) {
  const draft = entry.currentDraft ?? entry.draft ?? {};
  const ids = {};
  for (const [alias, heroName] of Object.entries(draft)) {
    const id = heroNameToId[String(heroName).toLowerCase()];
    if (id != null) ids[alias] = id;
  }
  return ids;
}

async function main() {
  const matchIds = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_MATCHES;

  console.log("Hamtar spelare (Steam-ID:n) ...");
  const players = await fetchPlayers();
  const { accountToAlias, missing } = buildAccountToAlias(players);
  console.log(Object.keys(accountToAlias).length + "/" + players.length + " spelare har Steam-ID satt.");
  if (missing.length) console.log("  Saknar Steam-ID (kan inte kannas igen i matchdata): " + missing.join(", "));
  console.log();

  console.log("Hamtar historik-bin ...");
  const history = await fetchHistory();
  console.log(history.length + " strategier i historiken.\n");

  // ---- Fas 1: hamta + poangsatt varje match, utan att skriva ut an ----
  const results = [];
  for (const matchId of matchIds) {
    let match;
    try {
      match = await fetchMatch(matchId);
    } catch (e) {
      results.push({ matchId, error: "kunde inte hamta match — " + e.message });
      continue;
    }
    const startMs = match.start_time * 1000;

    const matchedPlayers = [];
    for (const p of match.players) {
      const alias = accountToAlias[p.account_id];
      if (alias) matchedPlayers.push({ alias, hero_id: p.hero_id, isRadiant: p.player_slot < 128 });
    }
    if (!matchedPlayers.length) {
      results.push({ matchId, startMs, error: "inga kanda alias synliga i denna match (troligen privata profiler)" });
      continue;
    }
    const radiantCount = matchedPlayers.filter(p => p.isRadiant).length;
    const ourSideIsRadiant = radiantCount >= matchedPlayers.length / 2;
    const ourResult = ourSideIsRadiant === match.radiant_win ? "win" : "loss";

    const candidates = history.filter(entry => {
      const t = new Date(entry.createdAt).getTime();
      if (isNaN(t)) return false;
      const gap = startMs - t; // matchstart minus nar strategin genererades
      return gap >= 0 && gap <= TIME_WINDOW_BEFORE_MS; // strategin ska ligga fore matchen, inom fonstret
    });
    if (!candidates.length) {
      results.push({ matchId, startMs, matchedPlayers, ourResult, error: "ingen strategi inom tidsfönstret" });
      continue;
    }

    const scored = candidates.map(entry => {
      const heroIds = draftHeroIds(entry);
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
      matchedPlayers.length === 2 ? "MEDEL" : "LÅG (endast 1 känd spelare synlig)";

    results.push({ matchId, startMs, matchedPlayers, ourResult, scored, confidence });
  }

  // ---- Fas 2: kronologisk konsistenskontroll ----
  // Spelnummer ska stiga i takt med tiden. Om toppkandidaten bryter mot det,
  // valj basta kandidat som INTE bryter ordningen istallet.
  const withCandidates = results.filter(r => r.scored && r.scored.length);
  withCandidates.sort((a, b) => a.startMs - b.startMs);
  let lastGameNumber = -Infinity;
  for (const r of withCandidates) {
    let chosen = r.scored.find(c => c.entry.gameNumber >= lastGameNumber);
    if (!chosen) chosen = r.scored[0]; // inget respekterar ordningen — fall tillbaka pa basta gissning
    r.chosen = chosen;
    r.orderOverridden = chosen !== r.scored[0];
    lastGameNumber = chosen.entry.gameNumber;
  }

  // ---- Fas 3: skriv ut, i ursprunglig ordning ----
  for (const r of results) {
    console.log("=".repeat(70));
    console.log("MATCH " + r.matchId + (r.startMs ? "  (" + new Date(r.startMs).toLocaleString("sv-SE") + ")" : ""));
    if (r.error) {
      console.log("  " + r.error);
      continue;
    }
    console.log(
      "  Kända spelare (" + r.matchedPlayers.length + "/10, konfidens: " + r.confidence + "): " +
      r.matchedPlayers.map(p => p.alias).join(", ") +
      " — resultat: " + r.ourResult
    );
    const best = r.chosen;
    const runnerUp = r.scored[1];
    const ambiguousRaw = runnerUp && runnerUp.total === r.scored[0].total;
    const gapMin = Math.round((r.startMs - new Date(best.entry.createdAt).getTime()) / 60000);
    console.log(
      "  → Förslag: spel #" + best.entry.gameNumber + ' "' + best.entry.name + '" ' +
      "(spelarmatch " + best.playerScore + "/" + r.matchedPlayers.length +
      ", hjältematch " + best.heroScore + "/" + r.matchedPlayers.length + ")" +
      "  [genererad " + gapMin + " min före matchstart]"
    );
    if (r.orderOverridden) {
      console.log("  ↳ Justerat från topp-poäng pga kronologisk ordning (spel #" + r.scored[0].entry.gameNumber + " hade högre poäng men passar inte tidsordningen)");
    } else if (ambiguousRaw) {
      console.log("  ⚠ Flera kandidater hade samma poäng — valde den som stämmer med tidsordningen (spel #" + runnerUp.entry.gameNumber + " var alternativet)");
    }
    if (best.entry.result && best.entry.result !== r.ourResult) {
      console.log("  ⚠ AVVIKELSE: strategin har redan result=\"" + best.entry.result + "\", men matchdata säger \"" + r.ourResult + "\"");
    }
  }
}

main().catch(e => { console.error("Fel:", e.message); process.exit(1); });
