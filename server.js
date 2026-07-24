const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { identifyTopbarHeroes } = require('./topbar-match');
const { readBannedHeroes } = require('./ban-log-match');

const app = express();
const PORT = process.env.PORT || 3000;
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const JSONBIN_BASE = 'https://api.jsonbin.io/v3';

app.use(cors());
app.use(express.json({ limit: '8mb' })); // 8mb: /api/overlay-capture tar emot en base64-PNG-remsa (topbaren), stor pa 4K-skarmar
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; " +
    "img-src 'self' https://cdn.dota2.com https://cdn.cloudflare.steamstatic.com https://cdn.steamstatic.com https://steamcdn-a.akamaihd.net data:; " +
    "connect-src 'self' https://api.opendota.com; " +
    "media-src 'self'"
  );
  next();
});
const SITE_PASSWORD = process.env.SITE_PASSWORD;
app.use((req, res, next) => {
  if (req.path === '/api/gsi') return next(); // Dota GSI klienten kan inte skicka Basic Auth, autentiseras via egen token istallet
  if (!SITE_PASSWORD) return next();
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const password = decoded.slice(decoded.indexOf(':') + 1);
    if (password === SITE_PASSWORD) return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Dreamhack Skyrup"');
  res.status(401).send('Authentication required');
});
app.use(express.static(path.join(__dirname, 'public')));

const BIN_IDS = { players: null, matches: null, draftpools: null };

async function jsonbinRequest(method, path, body) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Access-Key': JSONBIN_API_KEY,
    'X-Bin-Private': 'false'
  };
  const res = await fetch(JSONBIN_BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`JSONBin ${method} ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

async function getBin(key) {
  if (!BIN_IDS[key]) {
    const id = process.env['JSONBIN_' + key.toUpperCase() + '_ID'];
    if (!id) return null;
    BIN_IDS[key] = id;
  }
  try {
    const data = await jsonbinRequest('GET', `/b/${BIN_IDS[key]}/latest`);
    return data.record;
  } catch (e) {
    console.error('getBin error:', e.message);
    return null;
  }
}

async function setBin(key, data) {
  if (!BIN_IDS[key]) {
    const id = process.env['JSONBIN_' + key.toUpperCase() + '_ID'];
    if (!id) throw new Error('No bin ID for ' + key);
    BIN_IDS[key] = id;
  }
  await jsonbinRequest('PUT', `/b/${BIN_IDS[key]}`, data);
}

async function createBin(key, initial) {
  const res = await jsonbinRequest('POST', '/b', initial);
  const id = res.metadata.id;
  BIN_IDS[key] = id;
  console.log(`Created ${key} bin: ${id} — add to Railway variables: JSONBIN_${key.toUpperCase()}_ID=${id}`);
  return id;
}

async function initBins() {
  for (const key of ['players', 'matches', 'draftpools']) {
    const envId = process.env['JSONBIN_' + key.toUpperCase() + '_ID'];
    if (envId) {
      BIN_IDS[key] = envId;
      console.log(`Using existing ${key} bin: ${envId}`);
    } else {
      const initial = { data: [] };
      await createBin(key, initial);
    }
  }
}

async function readPlayers() { const r = await getBin('players'); return (r && r.data) ? r.data : []; }
async function writePlayers(data) { await setBin('players', { data }); }
async function readDraftPools() { const r = await getBin('draftpools'); return (r && r.data) ? r.data : []; }
async function writeDraftPools(data) { await setBin('draftpools', { data }); }
async function readMatches() { const r = await getBin('matches'); return (r && r.data) ? r.data : []; }
async function writeMatches(data) { await setBin('matches', { data }); }

// ── Studio-bins i JSONBin — overlever Railway-deploys eftersom JSONBin ligger
// utanfor appens filsystem. OBS (verifierat mot API:t): JSONBins nginx-proxy
// stoppar requests over 1MiB (413), oavsett bin-storlekens 10MB-tak — darfor
// far VARJE replik sin egen bin (liten, valdigt under grasen) istallet for
// en delad bin per match. Matchens manifest (text, inget ljud) far ocksa en
// egen liten bin, och pekar pa varje repliks ljud-bin via segments[i].binId.
const STUDIO_MAX_BIN_BYTES = 900 * 1024; // 900KB — marginal under nginx 1MiB-taket
const studioManifestCache = new Map(); // matchId -> { data, ts }
const studioSegmentCache = new Map();  // segmentBinId -> { data, ts }
const STUDIO_CACHE_TTL_MS = 5 * 60 * 1000;
async function createStudioBin(payload) {
  const res = await jsonbinRequest('POST', '/b', payload);
  return res.metadata.id;
}
async function setStudioBinData(binId, payload) {
  await jsonbinRequest('PUT', `/b/${binId}`, payload);
}
function checkStudioBinSize(payload, label) {
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (bytes > STUDIO_MAX_BIN_BYTES) {
    throw new Error(label + ' blev ' + Math.round(bytes / 1024) + 'KB — for stort for en JSONBin-bin (max ~900KB, JSONBins proxy stoppar over 1MiB).');
  }
}
async function getStudioManifestCached(match) {
  const cached = studioManifestCache.get(match.id);
  if (cached && (Date.now() - cached.ts) < STUDIO_CACHE_TTL_MS) return cached.data;
  const data = await jsonbinRequest('GET', `/b/${match.studioBinId}/latest`).then(r => r.record);
  studioManifestCache.set(match.id, { data, ts: Date.now() });
  if (studioManifestCache.size > 20) studioManifestCache.delete(studioManifestCache.keys().next().value);
  return data;
}
async function getStudioSegmentCached(binId) {
  const cached = studioSegmentCache.get(binId);
  if (cached && (Date.now() - cached.ts) < STUDIO_CACHE_TTL_MS) return cached.data;
  const data = await jsonbinRequest('GET', `/b/${binId}/latest`).then(r => r.record);
  studioSegmentCache.set(binId, { data, ts: Date.now() });
  if (studioSegmentCache.size > 100) studioSegmentCache.delete(studioSegmentCache.keys().next().value);
  return data;
}

// PLAYERS
app.get('/api/players', async (req, res) => {
  try { res.json(await readPlayers()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/players', async (req, res) => {
  const { name, steamId } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const players = await readPlayers();
    if (players.find(p => p.name === name)) return res.status(409).json({ error: 'Player exists' });
    players.push({ name, heroes: [], steamId: steamId || null });
    await writePlayers(players);
    res.json(players);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/players/:name/rename', async (req, res) => {
  const { newName } = req.body;
  if (!newName) return res.status(400).json({ error: 'newName required' });
  try {
    const players = await readPlayers();
    const p = players.find(p => p.name === req.params.name);
    if (!p) return res.status(404).json({ error: 'Not found' });
    if (players.find(p => p.name === newName)) return res.status(409).json({ error: 'Name taken' });
    p.name = newName;
    await writePlayers(players);
    res.json(players);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/players/:name', async (req, res) => {
  try {
    const players = (await readPlayers()).filter(p => p.name !== req.params.name);
    await writePlayers(players);
    res.json(players);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/players/:name/heroes', async (req, res) => {
  try {
    const players = await readPlayers();
    const p = players.find(p => p.name === req.params.name);
    if (!p) return res.status(404).json({ error: 'Not found' });
    p.heroes = req.body.heroes || [];
    await writePlayers(players);
    res.json(p);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/players/:name/challenge-pool', async (req, res) => {
  try {
    const players = await readPlayers();
    const p = players.find(p => p.name === req.params.name);
    if (!p) return res.status(404).json({ error: 'Not found' });
    p.challengePool = req.body.challengePool || [];
    await writePlayers(players);
    res.json(p);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/players/:name/steamid', async (req, res) => {
  try {
    const players = await readPlayers();
    const p = players.find(p => p.name === req.params.name);
    if (!p) return res.status(404).json({ error: 'Not found' });
    p.steamId = req.body.steamId || null;
    await writePlayers(players);
    res.json(p);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Rensa alla spelares hero pools och utmaningspooler
app.post('/api/players/reset-pools', async (req, res) => {
  try {
    const players = await readPlayers();
    players.forEach(p => { p.heroes = []; p.challengePool = []; });
    await writePlayers(players);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DRAFT POOLS (för /pool-sidan, helt separat från skarp spelardata) ──
app.get('/api/draftpools', async (req, res) => {
  try { res.json(await readDraftPools()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/draftpools/:name/heroes', async (req, res) => {
  try {
    let pools = await readDraftPools();
    let entry = pools.find(p => p.name === req.params.name);
    if (!entry) {
      entry = { name: req.params.name, heroes: [] };
      pools.push(entry);
    }
    entry.heroes = req.body.heroes || [];
    await writeDraftPools(pools);
    res.json(entry);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Importera draft pools till skarp spelardata (körs manuellt strax före LAN)
app.post('/api/draftpools/import', async (req, res) => {
  try {
    const draftPools = await readDraftPools();
    const players = await readPlayers();
    let imported = 0;
    draftPools.forEach(dp => {
      const p = players.find(p => p.name === dp.name);
      if (p) { p.heroes = dp.heroes || []; imported++; }
    });
    await writePlayers(players);
    res.json({ ok: true, imported, total: draftPools.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ELEVENLABS TTS (hype announcer) ──────────────────
const hypeAudioCache = new Map();
async function generateHypeAudio(matchId, text) {
  const key = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!key || !voiceId || !text) return null;
  const res = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voiceId, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.55 }
    })
  });
  if (!res.ok) throw new Error('ElevenLabs ' + res.status + ': ' + await res.text());
  const buf = Buffer.from(await res.arrayBuffer());
  hypeAudioCache.set(matchId, buf);
  if (hypeAudioCache.size > 20) hypeAudioCache.delete(hypeAudioCache.keys().next().value);
  return buf;
}

app.get('/api/hype-audio/:id', async (req, res) => {
  try {
    let buf = hypeAudioCache.get(req.params.id);
    if (!buf) {
      const matches = await readMatches();
      const match = matches.find(m => m.id === req.params.id);
      const spoken = match && (match.hypeSpoken || match.hype);
      if (!spoken) return res.status(404).json({ error: 'No hype text for this match' });
      buf = await generateHypeAudio(req.params.id, spoken);
      if (!buf) return res.status(503).json({ error: 'TTS not configured' });
    }
    res.set('Content-Type', 'audio/mpeg');
    res.send(buf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── STUDIOANALYS (efterhandsgenerering, samma logik som generate-studio.js) ──
const RECAP_HISTORY_FILE = path.join(__dirname, 'recap-history.json');
let _studioVoices = null;
function studioVoices() {
  if (_studioVoices) return _studioVoices;
  let voices = {};
  try { voices = JSON.parse(fs.readFileSync(path.join(__dirname, 'bank-config.json'), 'utf8')).voices || {}; } catch(e) {}
  if (!voices.host) voices.host = 'XAYhxwN5SJaMioCWTDBq';
  if (!voices.analytic2) voices.analytic2 = 'T7JgacQ8vdcmJYfOsKeH';
  _studioVoices = voices;
  return voices;
}
const STUDIO_ARCHETYPE_LABELS = {
  deathball:'Deathball — win before 25 min', snowball:'Early Snowball — dominate laning',
  gank:'Gank & Dominate', teamfight:'Teamfight — wait for the right fight',
  pickoff:'Pick-off — hunt isolated enemies', poke:'Poke & Siege', lategame:'Late Game Scaling — explode at 35+',
  splitpush:'Splitpush', chaos:'Chaos & Disruption — chaos IS the plan', objective:'Objective Control',
  towerdive:'Tower Dive Heavy', global:'Global Presence', magicimmune:'Magic Immune — BKB focus',
  roshan:'Roshan & Aegis Timing', vision:'Vision & Info Warfare',
  powerspike:'Powerspike Rush — all-in on one timing', counterdraft:'Counter-Draft Trap',
  trilane:'Trilane Domination — 3-man safelane from minute 0', buybackdenial:'Buyback Denial — fight only when they can\'t buy back',
  smokechain:'Smoke Timing Chain — scheduled ganks on power spikes', roleswap:'Role-Swap Draft — heroes in unconventional roles'
};
const STUDIO_NOTABLE_ITEMS = ['rapier','hand_of_midas','black_king_bar','ultimate_scepter','aghanims_shard',
  'refresher','gem','blink','divine_rapier','radiance','heart','satanic','swift_blink','overwhelming_blink',
  'arcane_blink','bloodstone','octarine_core','sheepstick','abyssal_blade','moon_shard','travel_boots_2'];
function studioNormHero(n){ return String(n||'').toLowerCase().replace(/[^a-z]/g,''); }

let _studioHeroCache = null;
async function studioHeroes() {
  if (_studioHeroCache) return _studioHeroCache;
  const heroes = {};
  const hRes = await fetch('https://api.opendota.com/api/heroes');
  if (hRes.ok) (await hRes.json()).forEach(h => { heroes[h.id] = h.localized_name; });
  _studioHeroCache = heroes;
  return heroes;
}

let _heroNameToIdCache = null;
async function heroNameToIdMap() {
  if (_heroNameToIdCache) return _heroNameToIdCache;
  const map = {};
  const hRes = await fetch('https://api.opendota.com/api/heroes');
  if (hRes.ok) (await hRes.json()).forEach(h => { map[h.localized_name.toLowerCase()] = h.id; });
  _heroNameToIdCache = map;
  return map;
}

let _gsiHeroNameCache = null;
async function heroInternalNameMap() {
  if (_gsiHeroNameCache) return _gsiHeroNameCache;
  const map = {};
  const hRes = await fetch('https://api.opendota.com/api/heroes');
  if (hRes.ok) (await hRes.json()).forEach(h => { map[h.name] = h.localized_name; });
  _gsiHeroNameCache = map;
  return map;
}

// Displaynamn ("Black King Bar") -> GSI-internnamn UTAN "item_"-prefix ("black_king_bar")
let _itemNameCache = null;
async function itemDisplayNameMap() {
  if (_itemNameCache) return _itemNameCache;
  const map = {};
  const iRes = await fetch('https://api.opendota.com/api/constants/items');
  if (iRes.ok) {
    const items = await iRes.json();
    Object.keys(items).forEach(key => {
      const dname = items[key] && items[key].dname;
      if (dname) map[dname.toLowerCase()] = key;
    });
  }
  _itemNameCache = map;
  return map;
}

// GSI:s player.steamid ar ett 64-bitars SteamID, men spelarnas steamId i players-binen
// ar ett 32-bitars OpenDota account_id — konvertera med Valves standardoffset.
const STEAM64_OFFSET = 76561197960265728n;
function steam64ToAccountId(steamid64) {
  try { return Number(BigInt(String(steamid64)) - STEAM64_OFFSET); }
  catch (e) { return null; }
}
async function findAliasBySteamId64(steamid64) {
  const accountId = steam64ToAccountId(steamid64);
  if (accountId === null) return null;
  const players = await readPlayers();
  const p = players.find(pl => Number(pl.steamId) === accountId);
  return p ? p.name : null;
}

// ── SASONGSKONTEXT (storylines over sasongen) ────────────────────────────────
// Deterministiska fakta ur matchhistoriken (bara matches-binen, inga extra
// OpenDota-anrop): lagets och spelarnas sviter, hjaltupprepningar, arketypfacit,
// aterkommande fiendehjaltar och lagkamratpar. Koden raknar — AI:n far bara
// formulera (projektregel: hitta aldrig pa data). Pubmatcher (mode:'pub') och
// excludeFromMemory-matcher raknas inte in i sasongen.
// OBS: identisk kopia finns i generate-studio.js — hall dem synkade.
const SEASON_ALIAS_MERGE = { 'TOBBE': 'PUGGE' }; // PUGGE har alias Tobbe/TOBBE — mergas i all aggregering (samma som statssidan)
function seasonAlias(name) {
  const up = String(name || '').toUpperCase();
  return SEASON_ALIAS_MERGE[up] || up;
}
function seasonOrd(n) {
  return n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
}
function buildSeasonContext(allMatches, currentMatch, archetypeLabels) {
  const resultOf = m => m.matchResult || m.result || null; // bada falten forekommer (kand inkonsekvens)
  const season = allMatches
    .filter(m => !m.excludeFromMemory && m.mode !== 'pub' && resultOf(m))
    .filter(m => new Date(m.createdAt) <= new Date(currentMatch.createdAt))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const games = season.map((m, i) => ({
    num: m.gameNumber || (i + 1),
    id: m.id,
    win: resultOf(m) === 'win',
    draft: m.currentDraft || m.draft || {},
    enemies: m.enemies || [],
    archetype: m.archetype || null,
    wildcard: !!m.wildcard
  }));
  const curIdx = games.findIndex(g => g.id === currentMatch.id);
  if (curIdx === -1 || games.length < 3) return null; // kvallens match saknar resultat/ar exkluderad, eller for lite historik
  const cur = games[curIdx];
  const upTo = games.slice(0, curIdx + 1); // sasongen t.o.m. kvallen
  const before = upTo.slice(0, -1);
  const lines = [];

  const wins = upTo.filter(g => g.win).length;
  lines.push('DHS season record incl. tonight: ' + wins + 'W-' + (upTo.length - wins) + 'L over ' + upTo.length + ' games.');

  let streak = 1;
  for (let i = upTo.length - 2; i >= 0 && upTo[i].win === cur.win; i--) streak++;
  if (streak >= 2) lines.push('The squad is on a ' + streak + '-game ' + (cur.win ? 'winning' : 'losing') + ' streak, tonight included.');

  Object.keys(cur.draft).forEach(rawAlias => {
    const alias = seasonAlias(rawAlias);
    const inDraft = g => Object.keys(g.draft).some(a => seasonAlias(a) === alias);
    const mine = upTo.filter(inDraft);
    if (mine.length < 2) return;
    const w = mine.filter(g => g.win).length;
    let line = rawAlias + ': ' + w + 'W-' + (mine.length - w) + 'L in the games ' + rawAlias + ' played this season';
    let ps = 1;
    for (let i = mine.length - 2; i >= 0 && mine[i].win === cur.win; i--) ps++;
    if (ps >= 2) line += '; ' + ps + ' straight personal ' + (cur.win ? 'wins' : 'losses');
    const hero = cur.draft[rawAlias];
    const prevOnHero = before.filter(g => Object.keys(g.draft).some(a => seasonAlias(a) === alias && g.draft[a] === hero));
    if (prevOnHero.length) {
      const hw = prevOnHero.filter(g => g.win).length;
      line += '; plays ' + hero + ' for the ' + seasonOrd(prevOnHero.length + 1) + ' time (' + hw + 'W-' + (prevOnHero.length - hw) + 'L on it before tonight)';
    } else {
      line += '; first season game on ' + hero;
    }
    lines.push(line + '.');
  });

  if (cur.archetype) {
    const label = (archetypeLabels && archetypeLabels[cur.archetype]) || cur.archetype;
    const prevArch = before.filter(g => g.archetype === cur.archetype);
    if (!prevArch.length) lines.push("Tonight's archetype (" + label + ') was played for the FIRST time this season.');
    else {
      const aw = prevArch.filter(g => g.win).length;
      lines.push("Tonight's archetype (" + label + '): played for the ' + seasonOrd(prevArch.length + 1) + ' time; ' + aw + 'W-' + (prevArch.length - aw) + 'L before tonight.');
    }
  }

  (cur.enemies || []).map(hero => {
    const prevE = before.filter(g => (g.enemies || []).includes(hero));
    return { hero, prevE };
  }).filter(x => x.prevE.length >= 1)
    .sort((a, b) => b.prevE.length - a.prevE.length).slice(0, 3)
    .forEach(x => {
      const w = x.prevE.filter(g => g.win).length;
      lines.push('Enemy ' + x.hero + ' showed up for the ' + seasonOrd(x.prevE.length + 1) + ' time this season — DHS were ' + w + 'W-' + (x.prevE.length - w) + 'L against it before tonight.');
    });

  // Lagkamratpar som spelar ihop igen efter lang paus (max 1, minst 5 spel sedan sist)
  const curAliasKeys = Object.keys(cur.draft);
  let bestPair = null;
  for (let i = 0; i < curAliasKeys.length; i++) for (let j = i + 1; j < curAliasKeys.length; j++) {
    const a = seasonAlias(curAliasKeys[i]), b = seasonAlias(curAliasKeys[j]);
    let lastNum = null;
    before.forEach(g => {
      const al = Object.keys(g.draft).map(seasonAlias);
      if (al.includes(a) && al.includes(b)) lastNum = g.num;
    });
    if (lastNum !== null && cur.num - lastNum >= 5 && (!bestPair || cur.num - lastNum > bestPair.gap)) {
      bestPair = { gap: cur.num - lastNum, text: curAliasKeys[i] + ' and ' + curAliasKeys[j] + ' are teammates again for the first time since game ' + lastNum + '.' };
    }
  }
  if (bestPair) lines.push(bestPair.text);

  if (cur.wildcard) {
    const prevW = before.filter(g => g.wildcard);
    const ww = prevW.filter(g => g.win).length;
    lines.push('Tonight was a WILDCARD game (AI given free rein)' + (prevW.length ? '; previous wildcard games: ' + ww + 'W-' + (prevW.length - ww) + 'L.' : ' — the first one this season.'));
  }

  return lines.join('\n');
}

// Pre-match sasongskontext for hype-announcern — draft-OBEROENDE lag-narrativ (facit + svit + matchnummer),
// till skillnad fran buildSeasonContext som ar draft-/resultatberoende och racknas EFTER matchen. Racker for
// hype eftersom draften genereras i samma AI-anrop och alltsa inte finns nar hype-texten skrivs.
function buildPreMatchSeasonContext(allMatches) {
  const resultOf = m => m.matchResult || m.result || null; // bada falten forekommer (kand inkonsekvens)
  const season = (allMatches || [])
    .filter(m => !m.excludeFromMemory && m.mode !== 'pub' && resultOf(m))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const gameNumber = season.length + 1;
  if (season.length < 2) return { gameNumber, record: { wins: 0, losses: 0 }, streak: null, recentForm: [], text: null };

  const forms = season.map(m => resultOf(m) === 'win' ? 'win' : 'loss');
  const wins = forms.filter(r => r === 'win').length;
  const losses = forms.length - wins;

  const last = forms[forms.length - 1];
  let streakLen = 1;
  for (let i = forms.length - 2; i >= 0 && forms[i] === last; i--) streakLen++;
  const streak = streakLen >= 2 ? { type: last, length: streakLen } : null;
  const recentForm = forms.slice(-5);

  const parts = ['This is game ' + gameNumber + ' of the season.'];
  parts.push('DHS season record so far: ' + wins + 'W-' + losses + 'L.');
  if (streak) parts.push('Going into tonight the squad is on a ' + streak.length + '-game ' + (streak.type === 'win' ? 'winning' : 'losing') + ' streak.');
  parts.push('Recent form (oldest to newest): ' + recentForm.map(r => r === 'win' ? 'W' : 'L').join('-') + '.');

  return { gameNumber, record: { wins, losses }, streak, recentForm, text: parts.join(' ') };
}

async function generateStudioForMatch(strategyMatch, force) {
  const odId = strategyMatch.openDotaMatchId;
  if (strategyMatch.studioBinId && !force) return { alreadyExists: true };

  const voices = studioVoices();
  if (!voices.analytic) throw new Error('analytic-röst saknas i bank-config.json');
  const VOICE_MAP = { host: voices.host, analyst1: voices.analytic, analyst2: voices.analytic2 };
  const SETTINGS_MAP = {
    host:     { stability: 0.45, similarity_boost: 0.8, style: 0.5 },
    analyst1: { stability: 0.5,  similarity_boost: 0.8, style: 0.4 },
    analyst2: { stability: 0.5,  similarity_boost: 0.8, style: 0.45 }
  };
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const EL_KEY = process.env.ELEVENLABS_API_KEY;
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY saknas');
  if (!EL_KEY) throw new Error('ELEVENLABS_API_KEY saknas');

  const heroes = await studioHeroes();
  const res = await fetch('https://api.opendota.com/api/matches/' + odId);
  if (!res.ok) throw new Error('OpenDota ' + res.status);
  const m = await res.json();

  const heroName = id => heroes[id] || ('hero_' + id);
  const min = t => Math.floor(t / 60);
  const matchResult = strategyMatch.matchResult || strategyMatch.result;
  const weAreRadiant = (matchResult === 'win') === !!m.radiant_win;
  const draft = strategyMatch.currentDraft || strategyMatch.draft || {};

  const aliasByHero = {};
  Object.keys(draft).forEach(alias => { aliasByHero[studioNormHero(draft[alias])] = alias; });

  const players = (m.players || []).map(p => {
    const isOurSide = (p.player_slot < 128) === weAreRadiant;
    const nick = isOurSide ? aliasByHero[studioNormHero(heroName(p.hero_id))] : null;
    const purchases = (p.purchase_log || []).filter(x => STUDIO_NOTABLE_ITEMS.includes(x.key)).map(x => x.key + '@min' + min(x.time));
    return {
      team: p.player_slot < 128 ? 'Radiant' : 'Dire',
      name: nick || undefined,
      is_dhs: nick ? true : undefined,
      hero: heroName(p.hero_id),
      lane_role: p.lane_role,
      kda: p.kills + '/' + p.deaths + '/' + p.assists,
      gpm: p.gold_per_min, xpm: p.xp_per_min, net_worth: p.net_worth,
      last_hits: p.last_hits, denies: p.denies,
      hero_damage: p.hero_damage, tower_damage: p.tower_damage, hero_healing: p.hero_healing,
      obs_placed: p.obs_placed, sen_placed: p.sen_placed,
      stuns_seconds: p.stuns != null ? Math.round(p.stuns) : null,
      teamfight_participation: p.teamfight_participation != null ? Math.round(p.teamfight_participation * 100) + '%' : null,
      buybacks: (p.buyback_log || []).map(b => 'min' + min(b.time)),
      notable_purchases: purchases,
      firstblood: p.firstblood_claimed ? true : undefined
    };
  });

  const teamfights = (m.teamfights || []).map(tf => ({ at_minute: min(tf.start), deaths: tf.deaths }))
    .sort((a,b) => b.deaths - a.deaths).slice(0, 4);
  const roshans = (m.objectives || []).filter(o => o.type === 'CHAT_MESSAGE_ROSHAN_KILL').map(o => 'min' + min(o.time));

  // Utmaningsutfall — verifieras mot matchdatan och ges till panelen som underlag
  let challengeResults = null;
  if (Array.isArray(strategyMatch.challenges) && strategyMatch.challenges.length) {
    const odRowByAlias = {};
    (m.players || []).forEach(p => {
      if ((p.player_slot < 128) !== weAreRadiant) return;
      const nick = aliasByHero[studioNormHero(heroName(p.hero_id))];
      if (nick) odRowByAlias[nick] = p;
    });
    challengeResults = strategyMatch.challenges.map(ch => {
      const row = odRowByAlias[ch.alias];
      if (!row) return { alias: ch.alias, challenge: ch.text, result: 'unknown — player not found in match data' };
      const r = evalChallenge(ch, row);
      return { alias: ch.alias, challenge: ch.text, target: challengeTargetLabel(ch), actual: r.actual, passed: r.passed, achieved_level: r.level, max_level: r.maxLevel };
    });
  }

  const summary = {
    dhs_team: weAreRadiant ? 'Radiant' : 'Dire',
    dhs_result: matchResult,
    duration_minutes: min(m.duration),
    winner: m.radiant_win ? 'Radiant' : 'Dire',
    score: 'Radiant ' + m.radiant_score + ' — ' + m.dire_score + ' Dire',
    radiant_gold_advantage_per_minute: m.radiant_gold_adv || null,
    biggest_teamfights: teamfights,
    roshan_kills: roshans,
    personal_challenges: challengeResults,
    players: players
  };

  const strategyContext = {
    strategy_name: strategyMatch.name || null,
    archetype: strategyMatch.archetype ? (STUDIO_ARCHETYPE_LABELS[strategyMatch.archetype] || strategyMatch.archetype) : null,
    wildcard: !!strategyMatch.wildcard,
    briefing_excerpt: (strategyMatch.briefingEn || strategyMatch.briefing || '').slice(0, 600) || null,
    planned_draft: draft,
    captain_notes: strategyMatch.captainNotes || null
  };

  let history = [];
  try { history = JSON.parse(fs.readFileSync(RECAP_HISTORY_FILE, 'utf8')); } catch(e) {}
  const recentAngles = history.slice(-4).flatMap(h => h.angles || []);

  // Sasongskontext for storylines — deterministiskt beraknad ur matchhistoriken
  let seasonContext = null;
  try { seasonContext = buildSeasonContext(await readMatches(), strategyMatch, STUDIO_ARCHETYPE_LABELS); }
  catch (e) { console.error('SeasonContext:', e.message); }

  const prompt = 'You are writing the post-match STUDIO segment for an esports broadcast at a private Dota 2 LAN (Dreamhack Skyrup). '
    + 'Three voices on the panel: HOST (curious, guides the conversation, asks real questions, occasionally challenges), '
    + 'ANALYST1 (female, the strategic mind: big picture, momentum, macro decisions, what the teams were TRYING to do) and '
    + 'ANALYST2 (male, the numbers guy: stats, item timings, minute marks, gold curves — grounds every claim in data). '
    + 'The analysts have different perspectives and are allowed to DISAGREE and push back on each other; the host mediates '
    + 'and stirs the pot. Make it feel like a real panel, not people taking turns.'
    + '\n\nUNIQUE ANGLE — THE PLAN: before this match, the DHS squad was given a secret AI-generated strategy (see STRATEGY CONTEXT). '
    + 'The panel KNOWS the plan and the audience loves hearing whether the team actually followed it. Weave the plan-vs-reality '
    + 'thread naturally into the discussion when the data supports it — did they play the archetype? did the plan survive contact?'
    + '\n\nStudy the match data and find what is GENUINELY remarkable about THIS match. Let the data decide the story. '
    + 'Pick the 2-3 threads that matter most in this specific game.'
    + '\n\nIDENTITY RULES: The panel are NEUTRAL broadcasters covering the event — they are NOT on the team and must NEVER '
    + 'say "our team", "we", "us", "ours" or similar about the players. Refer to the featured squad as "the DHS squad", '
    + '"the home crew", "tonight\'s team", or simply by player nicknames — vary it naturally. '
    + 'Players with a "name" field are the featured DHS players — always refer to them by that nickname. '
    + 'Players WITHOUT a name are opponents — refer to them ONLY by hero name. '
    + 'The DHS squad is the emotional center of the recap regardless of who won.'
    + '\n\nPERSONAL COLOR: Where the data genuinely earns it, drop a natural personal remark about one of the DHS players — '
    + 'one or two per recap. NEVER walk through the roster player by player; most of our players should go unmentioned.'
    + '\n\nPERSONAL CHALLENGES: if personal_challenges is present in MATCH DATA, each DHS player had a public personal '
    + 'challenge for this match, with verified results. Each challenge has three escalating levels (L1 hard, L2 harder, '
    + 'L3 nearly impossible); achieved_level says how far they got (0 = missed even L1, 3 = the near-impossible feat). '
    + 'Weave the 1-3 most interesting outcomes into the discussion — a level 3 is a huge deal, a 0 is a flop. Do NOT recite the full challenge list.'
    + (seasonContext ? '\n\nSEASON CONTEXT — verified facts computed in code from the season\'s match history. '
      + 'Use them for storyline continuity across the season: streaks, revenge games, firsts, deja vu. Weave in the 1-2 '
      + 'that genuinely fit tonight\'s story — never recite the list, and NEVER invent season facts beyond these:\n' + seasonContext : '')
    + (recentAngles.length ? '\n\nANGLES ALREADY USED in recent recaps tonight (find DIFFERENT threads): ' + recentAngles.join('; ') : '')
    + '\n\nFormat: 10-14 dialogue lines. HOST opens with a short scene-setting line and closes the segment. '
    + 'Both analysts must speak multiple times, and at least once react directly to what the OTHER analyst just said. '
    + 'Written to be SPOKEN: short sentences, ellipses for pauses, at most one CAPS-emphasized word per line. English.'
    + '\n\nSTRATEGY CONTEXT:\n' + JSON.stringify(strategyContext)
    + '\n\nMATCH DATA:\n' + JSON.stringify(summary)
    + '\n\nReply ONLY with JSON, no markdown: {"headline":"4-8 word segment title","dialogue":[{"speaker":"host"|"analyst1"|"analyst2","text":"...","mentions":["exact nicknames of OUR players explicitly mentioned in this line, empty array if none"]}],"angles":["2-4 word label per main thread"]}';

  let recap = null;
  for (let attempt = 1; attempt <= 2 && !recap; attempt++) {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-fable-5', max_tokens: 6000, messages: [{ role: 'user', content: prompt }] })
    });
    if (!aiRes.ok) throw new Error('Anthropic ' + aiRes.status + ': ' + (await aiRes.text()).slice(0,200));
    const data = await aiRes.json();
    const text = (data.content || []).map(c => c.text || '').join('').replace(/```json|```/g, '').trim();
    try { recap = JSON.parse(text); }
    catch(e) { if (attempt === 2) throw new Error('Kunde inte tolka AI-svaret'); }
  }
  if (!Array.isArray(recap.dialogue) || !recap.dialogue.length) throw new Error('Tomt dialogue-fält från AI');

  const validAliases = new Set(Object.keys(draft));
  recap.dialogue.forEach(d => { d.mentions = (d.mentions || []).filter(x => validAliases.has(x)); });

  const segments = [];
  for (let i = 0; i < recap.dialogue.length; i++) {
    const d = recap.dialogue[i];
    const fname = 'seg_' + String(i).padStart(2, '0') + '.mp3';
    const body = { text: d.text, model_id: 'eleven_multilingual_v2', voice_settings: SETTINGS_MAP[d.speaker] || SETTINGS_MAP.analyst1 };
    if (i > 0) body.previous_text = recap.dialogue[i-1].text;
    if (i < recap.dialogue.length - 1) body.next_text = recap.dialogue[i+1].text;
    const tRes = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + (VOICE_MAP[d.speaker] || voices.analytic), {
      method: 'POST',
      headers: { 'xi-api-key': EL_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!tRes.ok) throw new Error('ElevenLabs ' + tRes.status + ' på replik ' + i);
    const audioBase64 = Buffer.from(await tRes.arrayBuffer()).toString('base64');
    await new Promise(r => setTimeout(r, 800));

    // Varje replik far sin egen bin — en delad bin for hela matchen blir for
    // stor for JSONBins 1MiB-request-tak (se STUDIO_MAX_BIN_BYTES ovan).
    const segmentPayload = { audioBase64 };
    checkStudioBinSize(segmentPayload, 'Replik ' + i + ' (' + d.speaker + ')');
    const segmentBinId = await createStudioBin(segmentPayload);

    segments.push({ speaker: d.speaker, text: d.text, mentions: d.mentions, file: fname, binId: segmentBinId });
  }

  const manifest = {
    odMatchId: String(odId),
    strategyMatchId: strategyMatch.id,
    strategyName: strategyMatch.name || null,
    headline: recap.headline || null,
    generatedAt: new Date().toISOString(),
    segments: segments,
    angles: recap.angles || [],
    challengeResults: challengeResults
  };

  // Manifestet (text + repliks bin-id:n, inget ljud) far ocksa en egen liten bin.
  const manifestPayload = { manifest };
  checkStudioBinSize(manifestPayload, 'Manifestet');

  let binId = strategyMatch.studioBinId;
  if (binId) await setStudioBinData(binId, manifestPayload);
  else binId = await createStudioBin(manifestPayload);

  history.push({ match_id: String(odId), angles: recap.angles || [], at: new Date().toISOString() });
  fs.writeFileSync(RECAP_HISTORY_FILE, JSON.stringify(history.slice(-10), null, 2));

  return { ok: true, studioBinId: binId, segments: segments.length };
}

// Generera studioanalys i efterhand (knapp i Playbook — samma logik som generate-studio.js CLI)
app.post('/api/studio-generate/:id', async (req, res) => {
  try {
    const matches = await readMatches();
    const match = matches.find(m => m.id === req.params.id);
    if (!match) return res.status(404).json({ error: 'Match not found' });
    if (!match.openDotaMatchId) return res.status(400).json({ error: 'Matchen saknar OpenDota-länk — länka matchen först' });
    serverStatus.generating = true;
    const result = await generateStudioForMatch(match, !!req.body.force);
    if (result.studioBinId) {
      match.studioBinId = result.studioBinId;
      await writeMatches(matches);
      studioManifestCache.delete(match.id);
    }
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  } finally {
    serverStatus.generating = false;
  }
});

// Servera studiomanifest + ljud fran den matchens JSONBin-bin (ersatter statiska filer under public/studio/)
app.get('/studio/:odId/manifest.json', async (req, res) => {
  try {
    const matches = await readMatches();
    const match = matches.find(m => String(m.openDotaMatchId) === req.params.odId);
    if (!match || !match.studioBinId) return res.status(404).json({ error: 'Ingen studioanalys genererad för denna match' });
    const data = await getStudioManifestCached(match);
    res.json(data.manifest);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/studio/:odId/:file', async (req, res) => {
  try {
    const matches = await readMatches();
    const match = matches.find(m => String(m.openDotaMatchId) === req.params.odId);
    if (!match || !match.studioBinId) return res.status(404).json({ error: 'Ingen studioanalys genererad för denna match' });
    const manifestData = await getStudioManifestCached(match);
    const seg = (manifestData.manifest.segments || []).find(s => s.file === req.params.file);
    if (!seg || !seg.binId) return res.status(404).json({ error: 'Segment saknas' });
    const segData = await getStudioSegmentCached(seg.binId);
    if (!segData.audioBase64) return res.status(404).json({ error: 'Segmentets ljud saknas' });
    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(segData.audioBase64, 'base64'));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── STATUS (polling) ─────────────────────────────────
let serverStatus = { generating: false, latestMatchId: null, replayToken: null, studioMatchId: null, studioToken: null };
app.get('/api/status', (req, res) => res.json(serverStatus));
app.post('/api/status/generating', (req, res) => {
  serverStatus.generating = !!req.body.generating;
  res.json(serverStatus);
});

// ── OVERLAY (in-game widget, se overlay/) ─────────────
// Generiskt innehall, en kanal per spelaralias — vad som helst kan pusha en notis hit
// (draftandringar, itemtiming osv), widgeten bryr sig bara om {id, kind, title, body}
// och vet inte vad "kind" betyder.
const overlayStates = {}; // alias -> {id, kind, title, body, ts}
function pushOverlay(alias, kind, title, body) {
  overlayStates[alias] = { id: Date.now().toString() + '-' + Math.random().toString(36).slice(2, 6), kind: kind, title: title, body: body, ts: Date.now() };
}
// Widgeten kanner sjalv av spelarens Steam-konto (se overlay/main.js) och slar upp
// ratt alias har, sa INGEN per-spelare-config behovs langre — en och samma
// config.js/overlay-mapp funkar for alla 9 spelare.
app.get('/api/overlay/by-steamid/:accountId', async (req, res) => {
  const accountId = Number(req.params.accountId);
  const players = await readPlayers();
  const p = players.find(pl => Number(pl.steamId) === accountId);
  if (!p) return res.json({ id: null, kind: null, title: '', body: '', ts: 0 });
  res.json(overlayStates[p.name] || { id: null, kind: null, title: '', body: '', ts: 0 });
});

app.get('/api/overlay/:alias', (req, res) => {
  res.json(overlayStates[req.params.alias] || { id: null, kind: null, title: '', body: '', ts: 0 });
});
app.post('/api/overlay/:alias', (req, res) => {
  pushOverlay(req.params.alias, req.body.kind || 'test', req.body.title || '', req.body.body || '');
  res.json(overlayStates[req.params.alias]);
});

// Tar emot en topbar-screenshot fran overlay-widgeten (svar pa capture-request,
// se GSI-handlern), identifierar FIENDESIDANS fem hjaltar via template matching
// (topbar-match.js) och genererar itemtips — vagen runt att GSI aldrig exponerar
// fiendehjaltar i All Pick (bekraftat 2026-07-13).
app.post('/api/overlay-capture', async (req, res) => {
  try {
    const accountId = Number(req.body.accountId);
    const image = req.body.image; // base64-PNG, bara skarmens topp-remsa
    if (!accountId || !image) return res.status(400).json({ error: 'accountId + image kravs' });
    const players = await readPlayers();
    const p = players.find(pl => Number(pl.steamId) === accountId);
    if (!p) return res.status(404).json({ error: 'okant steam-konto' });
    const steamid64 = (BigInt(accountId) + STEAM64_OFFSET).toString();
    const myTeam = gsiTeamBySteamId[steamid64];
    if (!myTeam) return res.status(409).json({ error: 'GSI har inte rapporterat lagsida an — kan inte veta vilken sida som ar fienden' });
    const enemySide = myTeam === 'radiant' ? 'dire' : 'radiant';

    // Pub-strategi-session? Da lases BADA sidorna av topbaren (alla 10 hjaltar)
    // och en spelplan for den redan lasta draften genereras, istallet for
    // LAN-flodets fiende-avlasning mot latestMatchId.
    const pubSess = pubFindSessionByAlias(p.name);
    if (pubSess && !pubSess.playbookMatchId) {
      if (pubSess.generating) return res.json({ ok: true, pending: true });
      pubSess.generating = true;
      try {
        const buf = Buffer.from(image, 'base64');
        const ownResult = await identifyTopbarHeroes(buf, myTeam);
        const enemyResult = await identifyTopbarHeroes(buf, enemySide);
        console.log('[PUB capture] egna ok=' + ownResult.ok, JSON.stringify(ownResult.heroes),
          '| fiender ok=' + enemyResult.ok, JSON.stringify(enemyResult.heroes));
        if (!ownResult.ok || !enemyResult.ok) {
          if (pubSess.captureAttempts >= 5) {
            pubSess.failed = true;
            pushOverlay(p.name, 'pub-strategi', 'Pub-strategi', 'Kunde inte lasa av hjaltarna fran skarmen — ingen strategi genererad.');
          }
          return res.json({ ok: false, reason: ownResult.reason || enemyResult.reason, own: ownResult.slots, enemy: enemyResult.slots });
        }
        const pubMatch = await createPubMatch(pubSess, ownResult.heroes, enemyResult.heroes);
        await generateItemTipsForMatch(pubMatch.id, enemyResult.heroes);
        // Recap direkt i overlayn (strateginamn + briefing + spelarens egna
        // nyckelitems) sa spelaren far hela planen upp pa skarmen redan nu, i
        // stallet for forst nar item-paminnelserna borjar ticka in live.
        await pushPubRecap(pubMatch.id, pubSess);
        // Utmaningarna genereras sist (efter att recapen hunnit visas) och
        // pushas till varje spelares overlay nar de ar klara.
        generateChallengesForMatch(pubMatch.id)
          .then(() => pushPubChallenges(pubMatch.id, pubSess))
          .catch(e => console.error('[PUB] Utmaningar:', e.message));
        return res.json({ ok: true, pub: true, matchId: pubMatch.id, own: ownResult.heroes, enemies: enemyResult.heroes });
      } finally { pubSess.generating = false; }
    }

    const result = await identifyTopbarHeroes(Buffer.from(image, 'base64'), enemySide);
    console.log('[capture]', enemySide, 'ok=' + result.ok, JSON.stringify(result.heroes), result.reason || '');
    // Per-slot score/margin/runnerUp — utan detta kravdes en extra rond med
    // riktiga skarmdumpar 2026-07-20 for att forsta VARFOR ett gissat namn
    // (Visage/Puck) inte var den faktiska hjalten (Spectre, aldrig ens
    // tvaa-kandidat i finpasset). Loggas alltid, inte bara vid ok:false, sa
    // aven "lyckade" avlasningar kan granskas i efterhand.
    console.log('[capture-slots]', JSON.stringify(result.slots));
    if (!result.ok) {
      pushOverlay(p.name, 'itemtips', 'Itemtips', 'Kunde inte lasa av fiendehjaltarna fran skarmen — fyll i dem manuellt i Playbook.');
      return res.json({ ok: false, reason: result.reason, heroes: result.heroes, slots: result.slots });
    }
    const generated = await generateItemTipsForMatch(serverStatus.latestMatchId, result.heroes);
    // Push ALLTID nagot har — annars ser spelaren tyst ingenting alls om
    // generateItemTipsForMatch av nagon anledning inte genererade (redan gjort,
    // ingen matchad match, saknad strategitext) trots att fienderna las av korrekt.
    if (generated) {
      pushOverlay(p.name, 'itemtips', 'Itemtips klara', 'Fiender: ' + result.heroes.join(', ') + '. Paminnelser kommer live under matchen.');
    } else {
      pushOverlay(p.name, 'itemtips', 'Fiender identifierade', 'Fiender: ' + result.heroes.join(', ') + '. Kunde inte generera itemtips automatiskt just nu — kolla matchen i Playbook.');
    }
    res.json({ ok: true, heroes: result.heroes, generated, slots: result.slots });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Tar emot en ban-logg-screenshot fran overlay-widgeten (svar pa
// capture-ban-request, se GSI-handlern), laser av bannade hjaltar via OCR
// (ban-log-match.js) och matar dem in i samma ban-ersattningslogik som
// Captain's Mode-flodet — vagen runt att GSI:s draft-objekt alltid ar tomt
// i All Pick (bekraftat 2026-07-13).
app.post('/api/overlay-ban-capture', async (req, res) => {
  try {
    const accountId = Number(req.body.accountId);
    const image = req.body.image; // base64-PNG, bara ban-logg-panelen
    if (!accountId || !image) return res.status(400).json({ error: 'accountId + image kravs' });
    const players = await readPlayers();
    const p = players.find(pl => Number(pl.steamId) === accountId);
    if (!p) return res.status(404).json({ error: 'okant steam-konto' });
    const detected = await readBannedHeroes(Buffer.from(image, 'base64'));
    const newlyUnavailable = detected.filter(h => !gsiSeenUnavailable.has(h));
    detected.forEach(h => gsiSeenUnavailable.add(h));
    console.log('[ban-capture]', JSON.stringify(detected), 'nya:', JSON.stringify(newlyUnavailable));
    await applyNewlyUnavailableHeroes(newlyUnavailable);
    res.json({ ok: true, detected, newlyUnavailable });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Tar emot matchid-observationer fran overlay-widgetens console.log-tail
// (Dota skriver "Player AccountID N connecting to MatchID M" i klartext vid
// anslutning till matchservern — kraver -condebug i Steams launch options,
// se overlay/console-tail.js). Anvands som verifiering/fallback for GSI:s
// map.matchid i pub-strategiflodet: console-raden dyker upp redan innan
// HERO_SELECTION och ar oberoende av GSI.
let consoleMatchIdByAccount = {}; // accountId (32-bit) -> { matchId, ts }
app.post('/api/overlay-console-event', async (req, res) => {
  try {
    const accountId = Number(req.body.accountId);
    const matchId = String(req.body.matchId || '');
    if (!accountId || !/^\d+$/.test(matchId)) return res.status(400).json({ error: 'accountId + matchId kravs' });
    const players = await readPlayers();
    const p = players.find(pl => Number(pl.steamId) === accountId);
    if (!p) return res.status(404).json({ error: 'okant steam-konto' });
    // logAccountId ar id:t Dota sjalv skrev i loggraden — ska normalt matcha Steam-kontot
    if (req.body.logAccountId && String(req.body.logAccountId) !== String(accountId)) {
      console.log('[console-event] accountId-avvikelse: steam=' + accountId + ' logg=' + req.body.logAccountId);
    }
    consoleMatchIdByAccount[accountId] = { matchId: matchId, ts: Date.now() };
    console.log('[console-event]', p.name, 'ansluten till match', matchId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUB-STRATEGI (omvand strategigenerering: last draft → spelplan) ──────────
// For casual/ranked utanfor LAN: en spelare "armerar" sig via knappen pa sitt
// spelarkort (Hero Pool-sidan). Nar GSI sedan rapporterar en match grupperas
// alla armerade DHS-spelare i SAMMA match+lag (map.matchid + team_name) till en
// session, topbaren lases av (BADA sidorna = alla 10 hjaltar) via samma
// overlay-capture-flode som LAN-matcherna, och en spelplan genereras for den
// redan lasta draften. Ingen hemlig arketyp — briefingen kan visas direkt.
// Matchen lankas till OpenDota direkt via GSI:s matchid (ingen 45-min-heuristik).
let pubArmed = {}; // alias -> { armedAt, playbookMatchId }
let pubSessions = {}; // "dotaMatchId:team" -> session (se GSI-hooken for falten)
const PUB_ARM_TTL_MS = 2 * 60 * 60 * 1000; // armering sjalvdör efter 2h utan match

function pubPrune() {
  const now = Date.now();
  Object.keys(pubArmed).forEach(a => { if (now - pubArmed[a].armedAt > PUB_ARM_TTL_MS) delete pubArmed[a]; });
  Object.keys(pubSessions).forEach(k => { if (now - pubSessions[k].createdAt > 3 * 60 * 60 * 1000) delete pubSessions[k]; });
}
function pubFindSessionByAlias(alias) {
  return Object.values(pubSessions).find(s => s.players[alias]) || null;
}

app.post('/api/pub/arm/:alias', async (req, res) => {
  try {
    const players = await readPlayers();
    if (!players.find(p => p.name === req.params.alias)) return res.status(404).json({ error: 'Okand spelare' });
    pubArmed[req.params.alias] = { armedAt: Date.now(), playbookMatchId: null };
    // Koppla loss spelaren fran en REDAN KLAR session fran en tidigare match.
    // Annars plockar /api/pub/status upp den gamla matchens playbookMatchId via
    // pubFindSessionByAlias-fallbacken och rapporterar "ready" direkt vid ny
    // armering — knappen visade da forra matchens strategi i stallet for att
    // vanta pa den nya (bugg 2026-07-24, live-test). En PAGAENDE (ej klar)
    // session nollstalls i stallet for nytt avlasningsforsok.
    Object.values(pubSessions).forEach(s => {
      if (s.players[req.params.alias] && s.playbookMatchId) delete s.players[req.params.alias];
    });
    const sess = pubFindSessionByAlias(req.params.alias);
    if (sess && !sess.playbookMatchId) { sess.captureAttempts = 0; sess.failed = false; }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/pub/disarm/:alias', (req, res) => {
  delete pubArmed[req.params.alias];
  res.json({ ok: true });
});
app.get('/api/pub/status', (req, res) => {
  pubPrune();
  const out = {};
  Object.keys(pubArmed).forEach(alias => {
    const sess = pubFindSessionByAlias(alias);
    const ready = pubArmed[alias].playbookMatchId || (sess && sess.playbookMatchId) || null;
    const failed = sess && !ready && (sess.failed
      || (sess.captureAttempts >= 5 && Date.now() - sess.lastCaptureReq > 60000)); // overlayn svarar inte
    out[alias] = {
      state: ready ? 'ready' : failed ? 'failed' : sess ? 'match' : 'armed',
      playbookMatchId: ready
    };
  });
  res.json(out);
});

// Bygger Playbook-matchen for en pub-session nar bada topbar-sidorna ar avlasta.
async function createPubMatch(sess, ownHeroes, enemyHeroes) {
  const idToName = await studioHeroes();
  const draft = {};
  Object.keys(sess.players).forEach(alias => {
    const hid = sess.players[alias].heroId;
    if (hid && idToName[hid]) draft[alias] = idToName[hid];
  });
  const dhsList = Object.keys(draft).map(a => a + ' - ' + draft[a]).join(', ') || '(ingen identifierad an)';

  const prompt = 'Du ar en Dota 2-coach. En match ar REDAN IGANG — draften ar last och kan inte andras. '
    + 'Skriv en spelplan for hur VART lag vinner med exakt den har sammansattningen.\n\n'
    + 'VART LAG (alla 5 hjaltar): ' + ownHeroes.join(', ') + '\n'
    + 'VARA EGNA SPELARE i laget: ' + dhsList + ' — ovriga ar okanda lagkamrater (randoms).\n'
    + 'MOTSTANDARNA: ' + enemyHeroes.join(', ') + '\n\n'
    + 'Fokusera pa: win condition, laning, powerspikes/timing-fonster, teamfight-roller och vad som ska undvikas. '
    + 'Ge konkreta individuella instruktioner for VARA spelare (alias ovan); okanda lagkamrater behandlas oversiktligt utifran deras hjaltar.\n\n'
    + 'Svara EXAKT i detta format:\n'
    + 'PUBSTRAT_JSON_START\n{"name":"Kort slagkraftigt strateginamn pa svenska"}\nPUBSTRAT_JSON_END\n\n'
    + 'KAPTENSBRIEFING_START\nMax 4 meningar pa svenska, kan lasas hogt direkt i voicen.\nKAPTENSBRIEFING_END\n\n'
    + 'Darefter sjalva spelplanen i markdown med max 3 rubriker. Anvand svenska.';

  const text = await callClaude(prompt, 2500);
  let name = 'Pub-strategi';
  const nameMatch = text.match(/PUBSTRAT_JSON_START([\s\S]*?)PUBSTRAT_JSON_END/);
  if (nameMatch) { try { name = JSON.parse(nameMatch[1].trim()).name || name; } catch (e) {} }
  const briefMatch = text.match(/KAPTENSBRIEFING_START([\s\S]*?)KAPTENSBRIEFING_END/);
  const briefing = briefMatch ? briefMatch[1].trim() : '';
  const strategy = text
    .replace(/PUBSTRAT_JSON_START[\s\S]*?PUBSTRAT_JSON_END/, '')
    .replace(/KAPTENSBRIEFING_START[\s\S]*?KAPTENSBRIEFING_END/, '')
    .trim();

  const allPlayers = await readPlayers();
  const matches = await readMatches();
  const match = {
    id: Date.now().toString(),
    createdAt: new Date().toISOString(),
    gameNumber: matches.length + 1,
    mode: 'pub',
    name: name,
    briefing: briefing,
    briefingEn: '',
    captainNotes: '',
    wildcard: false,
    style: 'standard',
    archetype: null,
    players: allPlayers.filter(p => draft[p.name]),
    strategy: strategy,
    draft: draft,
    teamHeroes: ownHeroes,
    enemies: enemyHeroes,
    items: null,
    openDotaMatchId: sess.dotaMatchId
  };
  matches.unshift(match);
  await writeMatches(matches);
  sess.playbookMatchId = match.id;
  Object.keys(sess.players).forEach(a => { if (pubArmed[a]) pubArmed[a].playbookMatchId = match.id; });
  serverStatus.latestMatchId = match.id; // sa itemtiming-paminnelserna (GAME_IN_PROGRESS-blocket i /api/gsi) hittar matchen

  // Utmaningarna genereras av anroparen (overlay-capture) EFTER item-tipsen och
  // recapen, sa att recapen hinner visas i overlayn innan utmaningen pushas dit.
  console.log('[PUB] Match skapad:', match.id, name, '(OpenDota ' + sess.dotaMatchId + ')');
  return match;
}

// Skickar en kompakt recap till varje DHS-spelares overlay nar en omvand
// strategi ar klar: strateginamn, briefing och spelarens egna nyckelitems med
// senaste koptid. Ersatter den gamla "kolla Playbook"-notisen sa spelaren far
// hela planen direkt i overlayn i stallet for forst nar item-paminnelserna
// borjar ticka in live under matchen.
async function pushPubRecap(matchId, sess) {
  const matches = await readMatches();
  const match = matches.find(m => m.id === matchId);
  if (!match) return;
  Object.keys(sess.players).forEach(alias => {
    let body = match.name || 'Omvand strategi';
    if (match.briefing) body += '\n\n' + match.briefing;
    const timings = match.items ? parsePlayerItemTimings(match.items, alias) : [];
    if (timings.length) {
      body += '\n\nDina nyckelitems: ' + timings.map(t => t.item + ' (min ' + t.minute + ')').join(', ');
    }
    body += '\n\nItempaminnelser dyker upp live nar det ar dags att kopa.';
    pushOverlay(alias, 'pub-strategi', 'Omvand strategi klar', body);
  });
}

// Nar utmaningarna genererats klart for en omvand-strategimatch: pusha varje
// DHS-spelares egna utmaning till deras overlay (LAN-flodet visar dem pa TV:n
// i stallet — dar behovs ingen overlay-push).
async function pushPubChallenges(matchId, sess) {
  const matches = await readMatches();
  const match = matches.find(m => m.id === matchId);
  if (!match || !Array.isArray(match.challenges)) return;
  Object.keys(sess.players).forEach(alias => {
    const ch = match.challenges.find(c => c.alias === alias);
    if (ch) pushOverlay(alias, 'challenge-update', 'Din utmaning', ch.text);
  });
}

// Nedladdningsbar overlay/config.js — EN och samma fil till alla 9 spelare.
// Ingen alias behovs, widgeten kanner sjalv av vem som ar inloggad i Steam.
// Skyddad av samma Basic Auth som resten av sajten.
app.get('/api/overlay-config', (req, res) => {
  const content = "window.OVERLAY_CONFIG = {\n"
    + "  baseUrl: '" + (process.env.PUBLIC_URL || 'https://dhs27.up.railway.app') + "/api/overlay',\n"
    + "  alias: '', // fallback om Steam inte kunde identifieras — normalt behovs detta inte\n"
    + "  password: '" + (process.env.SITE_PASSWORD || '').replace(/'/g, "\\'") + "',\n"
    + "  pollMs: 2000,\n"
    + "  showMs: 12000\n"
    + "};\n";
  res.set('Content-Type', 'application/javascript');
  res.set('Content-Disposition', 'attachment; filename="config.js"');
  res.send(content);
});

// Nedladdningsbar Dota 2 GSI-cfg med ratt URL + token ifyllt.
app.get('/api/gsi-config', (req, res) => {
  const url = (process.env.PUBLIC_URL || 'https://dhs27.up.railway.app') + '/api/gsi';
  const content = '"DHS Playbook GSI"\n{\n'
    + '    "uri"           "' + url + '"\n'
    + '    "timeout"       "5.0"\n'
    + '    "buffer"        "0.1"\n'
    + '    "throttle"      "0.1"\n'
    + '    "heartbeat"     "30.0"\n'
    + '    "data"\n    {\n'
    + '        "provider"      "1"\n'
    + '        "map"           "1"\n'
    + '        "player"        "1"\n'
    + '        "hero"          "1"\n'
    + '        "abilities"     "1"\n'
    + '        "items"         "1"\n'
    + '        "draft"         "1"\n'
    + '    }\n'
    + '    "auth"\n    {\n'
    + '        "token"         "' + (process.env.GSI_TOKEN || '') + '"\n'
    + '    }\n'
    + '}\n';
  res.set('Content-Type', 'text/plain');
  res.set('Content-Disposition', 'attachment; filename="gamestate_integration_dhs.cfg"');
  res.send(content);
});

// Trigga studiosandning pa TV:n for en match med genererad studioanalys
app.post('/api/studio-play/:id', async (req, res) => {
  try {
    const matches = await readMatches();
    const match = matches.find(m => m.id === req.params.id);
    if (!match) return res.status(404).json({ error: 'Match not found' });
    if (!match.openDotaMatchId) return res.status(400).json({ error: 'Matchen saknar OpenDota-lank' });
    if (!match.studioBinId) return res.status(404).json({ error: 'Ingen studioanalys genererad — kor generate-studio.js forst' });
    serverStatus.studioMatchId = match.id;
    serverStatus.studioToken = Date.now().toString();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Trigga TV-repris för en befintlig match
app.post('/api/replay/:id', async (req, res) => {
  try {
    const matches = await readMatches();
    const match = matches.find(m => m.id === req.params.id);
    if (!match) return res.status(404).json({ error: 'Not found' });
    serverStatus.generating = true;
    setTimeout(() => {
      serverStatus.latestMatchId = match.id;
      serverStatus.replayToken = Date.now().toString();
      serverStatus.generating = false;
    }, 500);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PERSONLIGA UTMANINGAR ────────────────────────────
// AI genererar en utmaning per spelare, anpassad efter rollen i strategin.
// Maskinverifierbar: metric ur fast meny (OpenDota-falt), op och value —
// verifieras automatiskt mot matchdatan nar matchen ar lankad.
// Vanliga skalara metrics (heltal). Alla verifierade att finnas i en parsad OpenDota-match.
const CHALLENGE_METRICS = {
  // Kamp
  kills: 'kills', hero_kills: 'kills pa hjaltar', deaths: 'deaths (op <=)', assists: 'assists',
  // Farm & ekonomi
  last_hits: 'last hits', denies: 'denies', gold_per_min: 'GPM', xp_per_min: 'XPM',
  net_worth: 'natvarde (guld) totalt', gold_spent: 'spenderat guld',
  neutral_kills: 'djungelcreeps dodade', ancient_kills: 'ancient-creeps dodade', level: 'hjaltniva',
  // Skada & objectives
  hero_damage: 'hero damage totalt', tower_damage: 'tower damage totalt', hero_healing: 'healing totalt',
  tower_kills: 'torn (sista slaget)', roshan_kills: 'roshan-kills (sallsynt, bra niva-3)', courier_kills: 'couriers dodade',
  // Vision & info (support)
  obs_placed: 'observer wards placerade', sen_placed: 'sentry wards placerade',
  purchase_ward_observer: 'observer wards kopta', purchase_ward_sentry: 'sentry wards kopta',
  dewards: 'motstandarens wards forstorda (obs+sentry)', camps_stacked: 'lager stackade', creeps_stacked: 'creeps stackade',
  // Utility & tempo
  stuns: 'stun-sekunder totalt', purchase_tpscroll: 'TP-scrolls kopta', rune_pickups: 'runor plockade',
  actions_per_min: 'APM (actions/min)', pings: 'pings (op <= for lugn, >= for shotcaller)',
  teamfight_participation: 'andel av lagets fighter i PROCENT 0-100', lane_efficiency_pct: 'lane-effektivitet i procent',
  // Overlevnad & disciplin
  life_state_dead: 'sekunder dod totalt (op <=)', buyback_count: 'buybacks anvanda (op <=)'
};
// Decimal-metrics — jamfors utan heltalsavrundning (en decimal)
const CHALLENGE_FLOAT_METRICS = { kda: 'KDA-kvot som decimal, t.ex. 4.5' };
// Timeline-metrics — kraver faltet `at` (minut). Kumulativa arrayer per minut.
const CHALLENGE_TIMELINE_METRICS = { lh_t: 'last hits vid minut `at`', gold_t: 'natvarde vid minut `at`', xp_t: 'xp vid minut `at`', dn_t: 'denies vid minut `at`' };
// Item-timing — kraver faltet `item` (nyckel ur menyn). Levels ar MINUTER, op '<=' (tidigare = svarare).
// Alla nycklar verifierade mot OpenDotas item-konstanter.
const CHALLENGE_ITEMS = {
  blink: 'Blink Dagger', black_king_bar: 'BKB', manta: 'Manta Style', radiance: 'Radiance', desolator: 'Desolator', bfury: 'Battle Fury',
  power_treads: 'Power Treads', phase_boots: 'Phase Boots', arcane_boots: 'Arcane Boots', travel_boots: 'Boots of Travel',
  hand_of_midas: 'Hand of Midas', maelstrom: 'Maelstrom', mjollnir: 'Mjollnir', diffusal_blade: 'Diffusal Blade',
  echo_sabre: 'Echo Sabre', dragon_lance: 'Dragon Lance', ultimate_scepter: 'Aghanims Scepter', aghanims_shard: 'Aghanims Shard',
  octarine_core: 'Octarine Core', assault: 'Assault Cuirass', pipe: 'Pipe of Insight', crimson_guard: 'Crimson Guard',
  guardian_greaves: 'Guardian Greaves', force_staff: 'Force Staff', glimmer_cape: 'Glimmer Cape', aeon_disk: 'Aeon Disk',
  lotus_orb: 'Lotus Orb', blade_mail: 'Blade Mail', mekansm: 'Mekansm', vladmir: "Vladmir's Offering", spirit_vessel: 'Spirit Vessel',
  orchid: 'Orchid', bloodthorn: 'Bloodthorn', nullifier: 'Nullifier', sheepstick: 'Scythe of Vyse', refresher: 'Refresher Orb',
  shivas_guard: "Shiva's Guard", heart: 'Heart of Tarrasque', satanic: 'Satanic', abyssal_blade: 'Abyssal Blade',
  butterfly: 'Butterfly', greater_crit: 'Daedalus', silver_edge: 'Silver Edge', monkey_king_bar: 'Monkey King Bar',
  skadi: 'Eye of Skadi', bloodstone: 'Bloodstone', veil_of_discord: 'Veil of Discord', solar_crest: 'Solar Crest',
  holy_locket: 'Holy Locket', rod_of_atos: 'Rod of Atos', gungir: 'Gleipnir', meteor_hammer: 'Meteor Hammer',
  cyclone: "Eul's Scepter", hurricane_pike: 'Hurricane Pike', harpoon: 'Harpoon', disperser: 'Disperser', wind_waker: 'Wind Waker'
};

// Tre trosklar per utmaning (niva 1-3, ordnade latt->svar). Aldre matcher har
// bara ett enda `value` — fall tillbaka pa det sa gammal data fortfarande funkar.
function challengeLevels(ch) {
  if (Array.isArray(ch.levels) && ch.levels.length && ch.levels.every(n => typeof n === 'number')) return ch.levels;
  if (typeof ch.value === 'number') return [ch.value];
  return [];
}

// Ett giltigt utmaningsobjekt av nagon av de fyra typerna? (delas av generering + omgenerering)
function validChallengeShape(c) {
  if (!c || typeof c.text !== 'string' || !c.text) return false;
  if (c.op !== '>=' && c.op !== '<=') return false;
  if (!Array.isArray(c.levels) || c.levels.length !== 3 || !c.levels.every(n => typeof n === 'number')) return false;
  if (c.metric === 'item_timing') return typeof c.item === 'string' && !!CHALLENGE_ITEMS[c.item] && c.op === '<=';
  if (CHALLENGE_TIMELINE_METRICS[c.metric]) return typeof c.at === 'number' && c.at >= 2 && c.at <= 45;
  return !!CHALLENGE_METRICS[c.metric] || !!CHALLENGE_FLOAT_METRICS[c.metric];
}

// Bygg det lagrade utmaningsobjektet (behall bara typrelevanta extrafalt). value = niva 1 (bakatkompat).
function buildChallengeRecord(c) {
  const rec = { alias: c.alias, text: c.text, metric: c.metric, op: c.op, levels: c.levels, value: c.levels[0] };
  if (c.metric === 'item_timing') rec.item = c.item;
  if (CHALLENGE_TIMELINE_METRICS[c.metric]) rec.at = c.at;
  return rec;
}

// Det jamforbara faktiska vardet ur en OpenDota-spelarrad (per utmaningstyp)
function challengeActual(ch, odRow) {
  if (ch.metric === 'item_timing') {
    const t = (odRow.first_purchase_time || {})[ch.item];
    return (typeof t === 'number') ? t / 60 : Infinity; // minuter till forsta kop; Infinity = kopte aldrig
  }
  if (CHALLENGE_TIMELINE_METRICS[ch.metric]) {
    const arr = odRow[ch.metric];
    if (!Array.isArray(arr) || !arr.length) return 0;
    const idx = Math.max(0, Math.min(ch.at || 0, arr.length - 1)); // klampa om matchen tog slut fore minut `at`
    return arr[idx] || 0;
  }
  if (ch.metric === 'dewards') return (odRow.observer_kills || 0) + (odRow.sentry_kills || 0);
  if (ch.metric === 'teamfight_participation') return (odRow.teamfight_participation || 0) * 100; // procent
  return odRow[ch.metric] || 0;
}

// Kompakt malbeskrivning at studiopromtens MATCH DATA
function challengeTargetLabel(ch) {
  const levels = challengeLevels(ch);
  if (!levels.length) return ch.op + ' ' + ch.value + ' ' + ch.metric;
  if (ch.metric === 'item_timing') return (CHALLENGE_ITEMS[ch.item] || ch.item) + ' innan ' + levels.map(v => v + 'm').join(' / ');
  const suffix = CHALLENGE_TIMELINE_METRICS[ch.metric] ? (' ' + ch.metric + '@min' + ch.at) : (' ' + ch.metric);
  return levels.map((v, i) => 'L' + (i + 1) + ' ' + ch.op + v).join(' / ') + suffix;
}

function evalChallenge(ch, odRow) {
  const raw = challengeActual(ch, odRow);
  const decimal = !!CHALLENGE_FLOAT_METRICS[ch.metric] || ch.metric === 'item_timing';
  const actual = decimal ? (isFinite(raw) ? Math.round(raw * 10) / 10 : raw) : Math.round(raw);
  const levels = challengeLevels(ch);
  // Hogsta niva vars troskel klaras (nivaerna ar monotona latt->svar)
  let level = 0;
  for (let i = 0; i < levels.length; i++) {
    const ok = ch.op === '<=' ? actual <= levels[i] : actual >= levels[i];
    if (ok) level = i + 1;
  }
  return { actual, passed: level >= 1, level, maxLevel: levels.length };
}

// Utvardera alla utmaningar mot en OpenDota-match och skriv snapshotten pa matchen.
// Steam-ID-matchning (samma robusta metod som klientens statistik) — immun mot hjaltbyten.
// Persisteras sa Sasong-vyns utmaningsstatistik kan aggregera utan att rakna om per vy.
function applyChallengeResults(match, odMatch, players) {
  if (!Array.isArray(match.challenges) || !match.challenges.length) return;
  const odByAccount = {};
  (odMatch.players || []).forEach(p => { if (p.account_id != null) odByAccount[p.account_id] = p; });
  const rowByAlias = {};
  players.forEach(p => { if (p.steamId != null && odByAccount[Number(p.steamId)]) rowByAlias[p.name] = odByAccount[Number(p.steamId)]; });
  match.challengeResults = match.challenges.map(ch => {
    const row = rowByAlias[ch.alias];
    if (!row) return { alias: ch.alias, metric: ch.metric, matched: false };
    const r = evalChallenge(ch, row);
    return { alias: ch.alias, metric: ch.metric, matched: true, actual: (isFinite(r.actual) ? r.actual : null), level: r.level, maxLevel: r.maxLevel, passed: r.passed };
  });
  match.challengeResultsParsed = !!odMatch.version; // oparsad match -> parsade-only-metrics gar inte att mata an
  match.challengeResultsAt = new Date().toISOString();
}

// Be OpenDota parsa matchen (fire-and-forget) sa parsade-only-falt (wards, stuns, timeline, item-kop) blir tillgangliga.
function requestOpenDotaParse(openDotaMatchId) {
  fetch('https://api.opendota.com/api/request/' + openDotaMatchId, { method: 'POST' })
    .then(() => console.log('[OD] Parse-begaran skickad for match ' + openDotaMatchId))
    .catch(e => console.error('[OD] Parse-begaran misslyckades for ' + openDotaMatchId + ':', e.message));
}

async function generateChallengesForMatch(matchId) {
  const matches = await readMatches();
  const match = matches.find(m => m.id === matchId);
  if (!match || (match.challenges && match.challenges.length)) return;
  const draft = match.currentDraft || match.draft || {};
  const aliases = Object.keys(draft);
  if (!aliases.length) return;

  const prompt = 'Du ar utmaningsgeneratorn for en Dota 2-LAN-kvall. Laget har fatt en hemlig strategi och varje spelare en roll. '
    + 'Skapa EN personlig utmaning per spelare, anpassad efter spelarens hjalte och roll i strategin. '
    + 'Utmaningen ska vara matbar via OpenDota-statistik och REALISTISK for rollen: en support ska fa ward/assist/stun-utmaningar, '
    + 'en carry farm/damage-utmaningar, en offlane tanka/disrupta.'
    + '\n\nVarje utmaning har TRE nivaer — en brant, ICKE-LINJAR svarighetstrappa (hoppen mellan nivaerna ska OKA, inte vara jamnt fordelade):'
    + '\n- Niva 1: redan ganska svar (klart over genomsnittet for rollen, aldrig gratis).'
    + '\n- Niva 2: svar.'
    + '\n- Niva 3: nastan omojlig — en exceptionell insats som bara hander valdigt sallan (t.ex. for en do-sallan-utmaning: niva 3 = 0 deaths).'
    + '\n\nDu kan valja EN av FYRA utmaningstyper per spelare — VARIERA typerna mellan spelarna, gor det inte enformigt:'
    + '\n1) VANLIG metric — {"metric":"nyckel","op":">="/"<=","levels":[n1,n2,n3]}. Menyer: ' + JSON.stringify(CHALLENGE_METRICS)
    + '\n2) DECIMAL-metric (samma form, decimaltal tillatna): ' + JSON.stringify(CHALLENGE_FLOAT_METRICS)
    + '\n3) TIMELINE vid en viss minut — lagg till "at" (minut, t.ex. 10): {"metric":"lh_t","at":10,"op":">=","levels":[50,70,90]}. Menyer: ' + JSON.stringify(CHALLENGE_TIMELINE_METRICS)
    + '\n4) ITEM-TIMING — kop ett hjaltviktigt item fore en viss minut: {"metric":"item_timing","item":"nyckel","op":"<=","levels":[16,12,9]} (levels ar MINUTER, MASTE falla eftersom tidigare=svarare). Valj ett item som verkligen ar ett powerspike for just den hjalten (t.ex. Blink pa Axe, BKB pa en carry). Item-meny: ' + JSON.stringify(CHALLENGE_ITEMS)
    + '\n\nop-regler: ">=" (minst) for det mesta, "<=" for deaths/buybacks/life_state_dead/pings-lugn OCH alltid for item_timing.'
    + '\n"levels" ordnas alltid niva 1 -> niva 3. For op ">=" ska vardena STIGA (niva 3 hogst); for op "<=" ska de SJUNKA (niva 3 lagst).'
    + '\n\nDRAFT (spelare -> hjalte): ' + JSON.stringify(draft)
    + '\nSTRATEGI (roller och plan): ' + (match.currentStrategy || match.strategy || '').slice(0, 1500)
    + '\n\nSvara ENDAST med JSON, ingen markdown. "text" = kort slagkraftig utmaningstext pa svenska, max 12 ord:'
    + '\n{"challenges":[{"alias":"exakt spelarnamn ur draften","text":"...","metric":"...","op":">=","levels":[42,60,85]}]}';

  const text = (await callClaude(prompt, 1500)).replace(/```json|```/g, '').trim();
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1) throw new Error('Ogiltigt utmaningssvar fran AI');
  const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));

  const valid = (parsed.challenges || []).filter(c => c && aliases.includes(c.alias) && validChallengeShape(c));
  if (!valid.length) throw new Error('Inga giltiga utmaningar i AI-svaret');

  // Las om binen — annan skrivning kan ha hunnit fore under AI-anropet
  const fresh = await readMatches();
  const freshMatch = fresh.find(m => m.id === matchId);
  if (!freshMatch) return;
  freshMatch.challenges = valid.map(buildChallengeRecord);
  await writeMatches(fresh);
  console.log('Utmaningar genererade for match ' + matchId + ' (' + valid.length + ' st)');
}

// Omgenererar EN spelares personliga utmaning nar deras hjalte byts ut mitt
// i draften (ban-ersattning) — annars kan en utmaning som antog den gamla
// hjaltens formaga ("25 sek stun med Berserker's Call") bli omojlig eller
// missvisande om spelaren aldrig fick spela den hjalten. Pushas till just
// den spelarens overlay, samma monster som draft-ban-notisen.
async function regenerateChallengeForAlias(matchId, alias, newHero) {
  try {
    const matches = await readMatches();
    const match = matches.find(m => m.id === matchId);
    if (!match || !Array.isArray(match.challenges) || !match.challenges.some(c => c.alias === alias)) return;

    const prompt = 'Du ar utmaningsgeneratorn for en Dota 2-LAN-kvall. En spelares hjalte har just bytts ut mitt i draften (bannlyst/taget). '
      + 'Skapa EN ny personlig utmaning for just den har spelaren, anpassad efter deras NYA hjalte och roll i strategin. '
      + 'Matbar via OpenDota-statistik, realistisk for rollen.\n\n'
      + 'Utmaningen har TRE nivaer — en brant, ICKE-LINJAR svarighetstrappa (hoppen mellan nivaerna ska OKA): '
      + 'niva 1 = redan ganska svar (aldrig gratis), niva 2 = svar, niva 3 = nastan omojlig (en exceptionell insats som sallan hander, t.ex. 0 deaths).\n\n'
      + 'Valj EN av FYRA typer som passar den nya hjalten:'
      + '\n1) VANLIG metric — {"metric":"nyckel","op":">="/"<=","levels":[n1,n2,n3]}. Menyer: ' + JSON.stringify(CHALLENGE_METRICS)
      + '\n2) DECIMAL-metric: ' + JSON.stringify(CHALLENGE_FLOAT_METRICS)
      + '\n3) TIMELINE vid minut "at": {"metric":"lh_t","at":10,"op":">=","levels":[50,70,90]}. Menyer: ' + JSON.stringify(CHALLENGE_TIMELINE_METRICS)
      + '\n4) ITEM-TIMING (kop fore minut): {"metric":"item_timing","item":"nyckel","op":"<=","levels":[16,12,9]} — powerspike-item for hjalten. Item-meny: ' + JSON.stringify(CHALLENGE_ITEMS)
      + '\nop-regler: "<=" for deaths/buybacks/life_state_dead OCH alltid for item_timing, annars ">=".'
      + '\n"levels" ordnas niva 1 -> niva 3. For op ">=" ska vardena STIGA; for op "<=" ska de SJUNKA.'
      + '\n\nSPELARE: ' + alias + '\nNY HJALTE: ' + newHero
      + '\nSTRATEGI (roller och plan): ' + (match.currentStrategy || match.strategy || '').slice(0, 1500)
      + '\n\nSvara ENDAST med JSON, ingen markdown. "text" = kort slagkraftig svenska, max 12 ord:'
      + '\n{"text":"...","metric":"...","op":">=","levels":[42,60,85]}';

    const text = (await callClaude(prompt, 500)).replace(/```json|```/g, '').trim();
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) return;
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
    if (!validChallengeShape(parsed)) return;

    // Las om binen — annan skrivning kan ha hunnit fore under AI-anropet
    const fresh = await readMatches();
    const freshMatch = fresh.find(m => m.id === matchId);
    if (!freshMatch || !Array.isArray(freshMatch.challenges)) return;
    const idx = freshMatch.challenges.findIndex(c => c.alias === alias);
    if (idx === -1) return;
    freshMatch.challenges[idx] = buildChallengeRecord(Object.assign({ alias: alias }, parsed));
    await writeMatches(fresh);
    pushOverlay(alias, 'challenge-update', 'Ny utmaning', parsed.text);
    console.log('[GSI] Utmaning omgenererad for', alias, '(' + newHero + '):', parsed.text);
  } catch (e) { console.error('[GSI] Kunde inte omgenerera utmaning for', alias, e.message); }
}

// MATCHES
app.get('/api/matches', async (req, res) => {
  try { res.json(await readMatches()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Sasongskontext for hype-announcern (draft-oberoende lag-narrativ) — index.html bakar in text-faltet i strategipromten
app.get('/api/season-context', async (req, res) => {
  try { res.json(buildPreMatchSeasonContext(await readMatches())); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/matches', async (req, res) => {
  const { players, strategy, briefing, briefingEn, captainNotes, draft, name, wildcard, style, archetype, hype, hypeSpoken, hypeTagline, fightCard } = req.body;
  try {
    const matches = await readMatches();
    const gameNumber = matches.length + 1;
    const match = {
      id: req.body.id || Date.now().toString(),
      createdAt: new Date().toISOString(),
      gameNumber: gameNumber,
      name: name || '',
      briefing: briefing || '',
      briefingEn: briefingEn || '',
      hype: hype || '',
      hypeSpoken: hypeSpoken || '',
      hypeTagline: hypeTagline || '',
      fightCard: fightCard || null,
      captainNotes: captainNotes || '',
      wildcard: !!wildcard,
      style: style || 'standard',
      archetype: archetype || null,
      players,
      strategy,
      draft,
      enemies: [],
      items: null
    };
    matches.unshift(match);
    await writeMatches(matches);
    serverStatus.latestMatchId = match.id;
    // Generera announcer-ljud i bakgrunden — klart innan TV:n når hype-skärmen
    const spokenText = match.hypeSpoken || match.hype;
    if (spokenText) generateHypeAudio(match.id, spokenText).catch(e => console.error('Hype TTS:', e.message));
    // Generera personliga utmaningar i bakgrunden — klart innan TV:n nar utmaningsskarmen
    generateChallengesForMatch(match.id).catch(e => console.error('Utmaningar:', e.message));
    res.json(match);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/matches/:id', async (req, res) => {
  try {
    const matches = await readMatches();
    const match = matches.find(m => m.id === req.params.id);
    if (!match) return res.status(404).json({ error: 'Not found' });
    res.json(match);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/matches/:id/enemies', async (req, res) => {
  try {
    const matches = await readMatches();
    const match = matches.find(m => m.id === req.params.id);
    if (!match) return res.status(404).json({ error: 'Not found' });
    match.enemies = req.body.enemies || [];
    await writeMatches(matches);
    res.json(match);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/matches/:id/items', async (req, res) => {
  try {
    const matches = await readMatches();
    const match = matches.find(m => m.id === req.params.id);
    if (!match) return res.status(404).json({ error: 'Not found' });
    match.items = req.body.items;
    await writeMatches(matches);
    res.json(match);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/matches/:id/banned', async (req, res) => {
  try {
    const matches = await readMatches();
    const match = matches.find(m => m.id === req.params.id);
    if(!match) return res.status(404).json({ error: 'Not found' });
    match.banned = req.body.banned || [];
    await writeMatches(matches);
    res.json(match);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/matches/:id/strategy', async (req, res) => {
  try {
    const matches = await readMatches();
    const match = matches.find(m => m.id === req.params.id);
    if(!match) return res.status(404).json({ error: 'Not found' });
    match.currentStrategy = req.body.strategy;
    if(req.body.draft) match.currentDraft = req.body.draft;
    await writeMatches(matches);
    res.json(match);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Automatisk OpenDota-lankning (ersatter det manuella steget att kora
// link-matches.js lokalt och sjalv klistra in openDotaMatchId i JSONBin —
// den vagen fanns aldrig nagot skrivsteg, bara en dry-run-rapport, se TODO.md).
// Atervander exakt samma poangsattningslogik (spelarmatch + hjaltematch via
// currentDraft/draft) som link-matches.js, men hittar KANDIDATER sjalv via
// OpenDotas /players/:id/matches istallet for att krava en fardig lista med
// match-id:n som indata.
const LINK_TIME_WINDOW_MS = 45 * 60 * 1000; // matchen ska ha startat inom 45 min efter att strategin skapades

function scoreOpenDotaMatch(odMatch, accountToAlias, heroIds) {
  const matchedPlayers = [];
  for (const p of odMatch.players) {
    const alias = accountToAlias[p.account_id];
    if (alias) matchedPlayers.push({ alias, hero_id: p.hero_id, isRadiant: p.player_slot < 128 });
  }
  if (!matchedPlayers.length) return null;
  const radiantCount = matchedPlayers.filter(p => p.isRadiant).length;
  const ourSideIsRadiant = radiantCount >= matchedPlayers.length / 2;
  const ourResult = ourSideIsRadiant === odMatch.radiant_win ? 'win' : 'loss';
  let playerScore = 0, heroScore = 0;
  for (const mp of matchedPlayers) {
    if (heroIds[mp.alias] != null) {
      playerScore++;
      if (heroIds[mp.alias] === mp.hero_id) heroScore++;
    }
  }
  const confidence = matchedPlayers.length >= 3 ? 'HÖG' : matchedPlayers.length === 2 ? 'MEDEL' : 'LÅG';
  return { matchedPlayers, ourResult, playerScore, heroScore, total: playerScore + heroScore, confidence };
}

async function findOpenDotaCandidates(match) {
  const players = await readPlayers();
  const accountToAlias = {};
  players.forEach(p => { if (p.steamId) accountToAlias[Number(p.steamId)] = p.name; });

  const draft = match.currentDraft || match.draft || {};
  const rosterAliases = (match.players || []).map(p => p.name).filter(Boolean);
  const rosterSteamIds = players
    .filter(p => rosterAliases.includes(p.name) && p.steamId)
    .map(p => Number(p.steamId));
  if (!rosterSteamIds.length) return { candidates: [], reason: 'Ingen spelare i matchen har Steam-ID satt pa Hero Pool-sidan.' };

  const heroNameToId = await heroNameToIdMap();
  const heroIds = {};
  for (const [alias, heroName] of Object.entries(draft)) {
    const id = heroNameToId[String(heroName).toLowerCase()];
    if (id != null) heroIds[alias] = id;
  }

  const createdMs = new Date(match.createdAt).getTime();
  const daysBack = Math.min(30, Math.max(1, Math.ceil((Date.now() - createdMs) / 86400000) + 1));

  const candidateIds = new Set();
  for (const accountId of rosterSteamIds) {
    try {
      const res = await fetch(`https://api.opendota.com/api/players/${accountId}/matches?date=${daysBack}`);
      if (!res.ok) continue;
      const recent = await res.json();
      recent.forEach(rm => {
        const startMs = rm.start_time * 1000;
        if (startMs - createdMs >= 0 && startMs - createdMs <= LINK_TIME_WINDOW_MS) candidateIds.add(rm.match_id);
      });
    } catch (e) { console.error('[opendota-link] kunde inte hamta matcher for', accountId, e.message); }
  }
  if (!candidateIds.size) return { candidates: [], reason: 'Inga OpenDota-matcher hittades inom 45 minuter efter att strategin skapades.' };

  const scored = [];
  for (const matchId of candidateIds) {
    try {
      const res = await fetch(`https://api.opendota.com/api/matches/${matchId}`);
      if (!res.ok) continue;
      const odMatch = await res.json();
      const result = scoreOpenDotaMatch(odMatch, accountToAlias, heroIds);
      if (result) scored.push(Object.assign({ matchId, startMs: odMatch.start_time * 1000 }, result));
    } catch (e) { console.error('[opendota-link] kunde inte hamta match', matchId, e.message); }
  }
  scored.sort((a, b) => b.total - a.total);
  const decisive = scored.length > 0 && (scored.length === 1 || scored[0].total > scored[1].total);
  return { candidates: scored, decisive };
}

app.get('/api/matches/:id/opendota-candidates', async (req, res) => {
  try {
    const matches = await readMatches();
    const match = matches.find(m => m.id === req.params.id);
    if (!match) return res.status(404).json({ error: 'Not found' });
    const result = await findOpenDotaCandidates(match);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/matches/:id/link-opendota', async (req, res) => {
  try {
    const openDotaMatchId = String(req.body.openDotaMatchId || '');
    if (!openDotaMatchId) return res.status(400).json({ error: 'openDotaMatchId kravs' });
    const matches = await readMatches();
    const match = matches.find(m => m.id === req.params.id);
    if (!match) return res.status(404).json({ error: 'Not found' });

    const odRes = await fetch(`https://api.opendota.com/api/matches/${openDotaMatchId}`);
    if (!odRes.ok) return res.status(400).json({ error: 'Kunde inte hamta matchen fran OpenDota (HTTP ' + odRes.status + ')' });
    const odMatch = await odRes.json();

    const players = await readPlayers();
    const accountToAlias = {};
    players.forEach(p => { if (p.steamId) accountToAlias[Number(p.steamId)] = p.name; });
    const draft = match.currentDraft || match.draft || {};
    const heroNameToId = await heroNameToIdMap();
    const heroIds = {};
    for (const [alias, heroName] of Object.entries(draft)) {
      const id = heroNameToId[String(heroName).toLowerCase()];
      if (id != null) heroIds[alias] = id;
    }
    const scoreResult = scoreOpenDotaMatch(odMatch, accountToAlias, heroIds);
    if (!scoreResult) return res.status(400).json({ error: 'Ingen kand spelare hittades i den har OpenDota-matchen — troligen fel match-id.' });

    match.openDotaMatchId = openDotaMatchId;
    match.matchResult = scoreResult.ourResult;
    match.matchConfidence = scoreResult.confidence;
    // Utvardera + persistera utmaningsutfallet direkt (best-effort med den data vi har)
    applyChallengeResults(match, odMatch, players);
    await writeMatches(matches);
    // Be OpenDota parsa sa parsade-only-metrics blir tillgangliga; klienten uppdaterar snapshotten nar parsningen ar klar
    requestOpenDotaParse(openDotaMatchId);
    res.json(match);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Rakna om + persistera utmaningsutfallet mot farsk OpenDota-data (anropas av klienten nar en
// tidigare oparsad match nu blivit parsad, sa den sparade snapshotten kommer ikapp). Idempotent.
app.post('/api/matches/:id/refresh-challenges', async (req, res) => {
  try {
    const matches = await readMatches();
    const match = matches.find(m => m.id === req.params.id);
    if (!match) return res.status(404).json({ error: 'Not found' });
    if (!match.openDotaMatchId) return res.status(400).json({ error: 'Matchen ar inte lankad' });
    if (!Array.isArray(match.challenges) || !match.challenges.length) return res.json({ updated: false, reason: 'inga utmaningar' });
    const odRes = await fetch('https://api.opendota.com/api/matches/' + match.openDotaMatchId);
    if (!odRes.ok) return res.status(400).json({ error: 'OpenDota HTTP ' + odRes.status });
    const odMatch = await odRes.json();
    const players = await readPlayers();
    applyChallengeResults(match, odMatch, players);
    await writeMatches(matches);
    // Fortfarande oparsad? Nudga en parse-begaran (tacker pub-matcher som lankas via GSI utan att ga via link-opendota)
    if (!odMatch.version) requestOpenDotaParse(match.openDotaMatchId);
    res.json({ updated: true, parsed: !!match.challengeResultsParsed, results: match.challengeResults });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/matches/:id/result', async (req, res) => {
  try {
    const matches = await readMatches();
    const match = matches.find(m => m.id === req.params.id);
    if (!match) return res.status(404).json({ error: 'Not found' });
    match.result = req.body.result || null;
    await writeMatches(matches);
    res.json(match);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/matches/:id/archetype', async (req, res) => {
  try {
    const matches = await readMatches();
    const match = matches.find(m => m.id === req.params.id);
    if (!match) return res.status(404).json({ error: 'Not found' });
    match.archetype = req.body.archetype || null;
    match.archetypeGuessed = !!req.body.guessed;
    await writeMatches(matches);
    res.json(match);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/matches/:id/memory', async (req, res) => {
  try {
    const matches = await readMatches();
    const match = matches.find(m => m.id === req.params.id);
    if (!match) return res.status(404).json({ error: 'Not found' });
    match.excludeFromMemory = !!req.body.excludeFromMemory;
    await writeMatches(matches);
    res.json(match);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/matches', async (req, res) => {
  try { await writeMatches([]); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/matches/:id', async (req, res) => {
  try {
    const matches = (await readMatches()).filter(m => m.id !== req.params.id);
    await writeMatches(matches);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// AI
async function callClaude(prompt, maxTokens = 1500) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-fable-5', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content.map(c => c.text || '').join('');
}

app.post('/api/strategy', async (req, res) => {
  try { res.json({ text: await callClaude(req.body.prompt, req.body.maxTokens||2500) }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/items', async (req, res) => {
  try { res.json({ text: await callClaude(req.body.prompt, 2000) }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Hittar spelarens egen sektion i itemtips-texten (rubrik "## Alias") och plockar ut
// varje "**Item** - ... (senast minut X)"-rad darunder.
function parsePlayerItemTimings(itemsText, alias) {
  if (!itemsText) return [];
  const sections = itemsText.split(/^##\s+/m).slice(1);
  for (const section of sections) {
    const firstLine = section.split('\n')[0].trim();
    if (firstLine.toLowerCase() === alias.toLowerCase()) {
      const timings = [];
      const re = /\*\*([^*]+)\*\*[^\n(]*\(senast minut (\d+)\)/gi;
      let m;
      while ((m = re.exec(section))) {
        timings.push({ item: m[1].trim(), minute: parseInt(m[2], 10) });
      }
      return timings;
    }
  }
  return [];
}
function ownedItemKeys(gsiItems) {
  const owned = new Set();
  Object.keys(gsiItems || {}).forEach(slot => {
    const it = gsiItems[slot];
    if (it && it.name && it.name !== 'empty') owned.add(String(it.name).replace(/^item_/, ''));
  });
  return owned;
}
function dueReminders(timings, ownedKeys, clockSeconds, nameMap, remindedSet, matchId, alias) {
  const clockMinutes = clockSeconds / 60;
  const due = [];
  timings.forEach(t => {
    const key = nameMap[t.item.toLowerCase()];
    if (!key) return; // okant itemnamn i OpenDota-mappningen, hoppa over tyst
    const dedupKey = matchId + '|' + alias + '|' + t.item;
    if (remindedSet.has(dedupKey)) return;
    if (ownedKeys.has(key)) return; // redan kopt
    if (clockMinutes < t.minute) return; // inte dags an
    due.push(t);
    remindedSet.add(dedupKey);
  });
  return due;
}

// Genererar itemtips for en match mot kanda fiendehjaltar och sparar dem.
// Delas av CM-flodet (STRATEGY_TIME med draft-data) och All Pick-flodet
// (/api/overlay-capture, dar fienderna lases fran en topbar-screenshot).
let gsiItemsGenerating = false; // enkel lasning mot dubbelgenerering vid samtidiga anrop
async function generateItemTipsForMatch(matchId, enemyHeroes) {
  if (!matchId || gsiItemsGenerating) return false;
  gsiItemsGenerating = true;
  try {
    const matches = await readMatches();
    const match = matches.find(m => m.id === matchId);
    if (!match || match.items) return false; // ingen aktiv match, eller redan genererat
    if (!(match.currentStrategy || match.strategy || '').trim()) {
      // Sant hant 2026-07-18: en match sparad utan fardig strategitext (AI-svaret
      // klipptes av innan strategidelen, se TODO.md) gav ett forvirrat AI-svar
      // nar itemtips genererades mot en tom prompt-sektion. Hoppa over istallet
      // for att skicka ett garanterat daligt anrop OCH permanent lasa match.items
      // (som annars aldrig kan genereras om) med skrapsvaret.
      console.log('[GSI] Hoppar over itemtips-generering for match', match.id, '— saknar strategitext');
      return false;
    }

    const prompt = 'Du ar en Dota 2 item-expert. Vi har precis genererat en draft-strategi och ska nu mota dessa motstandare.\n\n'
      + 'VAR DRAFT-STRATEGI:\n' + (match.currentStrategy || match.strategy || '') + '\n\n'
      + 'MOTSTANDARNA SPELAR:\n' + enemyHeroes.join(', ') + '\n\n'
      + 'Ge konkreta itemtips per spelare i vart lag. Fokusera pa 3-5 nyckelitems per spelare som ar extra viktiga MOT just dessa motstandare.\n\n'
      + 'FORMAT: For varje spelare, skriv en rubrik pa egen rad exakt som "## [SPELARNAMN]" (spelarens alias rakt av, inget annat pa den raden), sedan hjaltens namn pa egen rad, sedan varje item pa egen rad som "**Itemnamn** - kort motivering (senast minut X)" dar X ar en ungefarlig match-minut senast nar itemet bor vara kopt. Avsluta varje spelare med en "Prioritet:"-rad. Ingen markdown-tabell, inga | tecken. Anvand svenska. Var specifik.';

    match.enemies = enemyHeroes;
    match.items = await callClaude(prompt, 2000);
    await writeMatches(matches);
    // Nollstall reminder-cachen sa itemtips genererade MITT I en match plockas
    // upp av paminnelselogiken (annars ligger en tom parsning kvar for aliaset)
    gsiItemCache = { matchId: null, timingsByAlias: {} };
    console.log('[GSI] Itemtips auto-genererade for match', match.id);
    return true;
  } finally { gsiItemsGenerating = false; }
}

// Dota GSI-endpoint: auto-genererar itemtips, foreslar ersattare live under draften,
// och paminner varje spelare individuellt om sina egna itemtips i realtid under matchen.
// .cfg-filen i Dota 2:s gamestate_integration-mapp pekar hit med matchande auth-token.
// OVERIFIERAT MOT LIVE-PAYLOAD (kan inte testas pa denna dator, se TODO.md) — loggar radata
// sa faltnamnen kan bekraftas nasta gang nagon spelar en pubmatch.
let gsiLastState = null;
let gsiSeenUnavailable = new Set(); // kumulativt sedan draften borjade, aterstalls varje ny HERO_SELECTION
let gsiLastItemCheck = {}; // alias -> timestamp, throttlar JSONBin-lasningar under matchen
let gsiItemCache = { matchId: null, timingsByAlias: {} };
let gsiRemindedItems = new Set(); // matchId|alias|itemnamn
let gsiTeamBySteamId = {}; // steamid64 -> 'radiant'|'dire', satt av varje GSI-payload; /api/overlay-capture behover veta vilken sida som ar fienden
let gsiCaptureState = { matchId: null, attempts: 0, lastReq: 0, done: false }; // capture-request-flodet (All Pick), max 3 forsok per match
let gsiBanCaptureState = { matchId: null, lastReq: 0 }; // ban-logg-OCR-flodet (All Pick), fragar hela HERO_SELECTION-fasen

// Ersatt bannlysta/tagna hjaltar for de spelare som paverkas. Delad av bade
// CM-draftflodet (GSI:s draft-objekt, se nedan) och All Pick-ban-OCR:n
// (POST /api/overlay-ban-capture) — bada matar bara in en lista med NYA
// otillgangliga hjaltnamn, gsiSeenUnavailable ar redan uppdaterad av
// anroparen innan detta anrops.
async function applyNewlyUnavailableHeroes(newlyUnavailable) {
  if (newlyUnavailable.length === 0) return;
  const matches = await readMatches();
  const match = matches.find(m => m.id === serverStatus.latestMatchId);
  const plannedDraft = match ? (match.currentDraft || match.draft || {}) : {};
  const affected = Object.keys(plannedDraft).filter(alias => newlyUnavailable.includes(plannedDraft[alias]));
  if (!match || affected.length === 0) return;

  const idToName = await studioHeroes();
  const takenThisBatch = new Set(); // undvik att foresla samma ersattare till tva spelare i samma omgang
  const pools = {};
  affected.forEach(alias => {
    const p = (match.players || []).find(pl => pl.name === alias);
    pools[alias] = ((p && p.heroes) || []).map(id => idToName[id]).filter(Boolean)
      .filter(h => !gsiSeenUnavailable.has(h));
  });

  const bannedList = affected.map(alias => plannedDraft[alias] + ' (' + alias + ')').join(', ');
  const poolList = affected.map(alias => alias + ': ' + (pools[alias].join(', ') || 'Tom pool - valj basta alternativ')).join('\n');

  const replacePrompt = 'Du ar en Dota 2 draft-expert. Ersatt bannlysta/tagna hjaltar sa snabbt som mojligt.\n\n'
    + 'STRATEGI (valj hjaltar som passar denna win condition och spelstil): ' + (match.currentStrategy || match.strategy || '').substring(0, 800) + '\n\n'
    + 'ERSATT: ' + bannedList + '\n'
    + 'POOLER: ' + poolList + '\n'
    + 'EJ VALBARA: ' + [...gsiSeenUnavailable].join(', ') + '\n\n'
    + 'Svara ENDAST med ersattningarna, en rad per spelare:\n'
    + '**[SPELARNAMN]: [NY HJALTE]** — en mening om varfor och hur hjalten fyller samma roll i planen.\n'
    + 'Skriv INGET annat — ingen omskriven strategi, ingen inledning.\n\n'
    + 'Anvand svenska.';

  const replaceText = await callClaude(replacePrompt, 500);
  const newDraft = Object.assign({}, plannedDraft);
  const overlayLines = [];
  const swapped = []; // {alias, newHero} — for utmaningsomgenerering efter skrivningen

  affected.forEach(alias => {
    const oldHero = plannedDraft[alias];
    const escaped = alias.replace(/[.*+?^${}()|\[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped + '[^\\n]*?:\\s*([A-Za-z\\- ]+)', 'i');
    const m2 = replaceText.match(regex);
    let newHero = m2 ? m2[1].trim().replace(/\*+/g, '').split(' - ')[0].split('(')[0].trim() : null;

    // Sakerhetsnat: lita aldrig blint pa AI-svaret — om det foreslar nagot
    // som ar bannat/taget/redan valt at nagon annan i denna omgang, fall
    // tillbaka pa forsta lediga hjalte i spelarens egen pool istallet.
    const available = pools[alias].filter(h => !takenThisBatch.has(h));
    if (!newHero || gsiSeenUnavailable.has(newHero) || takenThisBatch.has(newHero)) {
      newHero = available[0] || null;
    }
    if (newHero) {
      takenThisBatch.add(newHero);
      newDraft[alias] = newHero;
      const line = oldHero + ' bannad → ' + newHero;
      overlayLines.push(line + ' (' + alias + ')');
      pushOverlay(alias, 'draft-ban', 'Draftändring', line); // varje spelare ser bara sin egen ersattning
      swapped.push({ alias, newHero });
    }
  });

  match.currentStrategy = (match.currentStrategy || match.strategy || '')
    + '\n\n---\n### Draftändring efter bans (' + bannedList + ')\n' + replaceText;
  match.currentDraft = newDraft;
  match.banned = Array.from(new Set((match.banned || []).concat(affected.map(a => plannedDraft[a]))));
  await writeMatches(matches);

  console.log('[GSI] Auto-ersatte:', overlayLines.join(' | '));

  // Utmaningarna omgenereras EFTER att draften sparats (sa prompten ser den
  // uppdaterade currentStrategy/currentDraft), och blockerar inte svaret —
  // samma fire-and-forget-monster som generateChallengesForMatch anvander
  // nar matchen sparas forsta gangen.
  swapped.forEach(({ alias, newHero }) => {
    regenerateChallengeForAlias(match.id, alias, newHero).catch(e => console.error('[GSI] Utmaning-regen fel:', e.message));
  });
}

app.post('/api/gsi', async (req, res) => {
  res.sendStatus(200); // svara direkt, GSI vantar inte pa oss
  try {
    const body = req.body || {};
    if (!process.env.GSI_TOKEN || !body.auth || body.auth.token !== process.env.GSI_TOKEN) return;

    const state = body.map && body.map.game_state;

    const enteringHeroSelection = state === 'DOTA_GAMERULES_STATE_HERO_SELECTION' && gsiLastState !== state;
    const justEnteredStrategyTime = state === 'DOTA_GAMERULES_STATE_STRATEGY_TIME' && gsiLastState !== state;
    gsiLastState = state;
    if (enteringHeroSelection) gsiSeenUnavailable = new Set();

    const myTeam = body.player && body.player.team_name; // 'radiant' | 'dire'
    const draft = body.draft;
    if (!myTeam) return;
    if (body.player.steamid) gsiTeamBySteamId[body.player.steamid] = myTeam;

    // ── Pub-strategi (omvand strategigenerering): armerade spelare utanfor LAN.
    // Grupperar armerade DHS-spelare per matchid+lag (tva DHS-gang kan hamna pa
    // varsin sida i samma pubmatch), samlar deras egna hjaltar fran GSI:s
    // hero-block, och ber om en topbar-screenshot nar matchen startat — bada
    // sidorna lases av i /api/overlay-capture och spelplan genereras dar. ──
    if (Object.keys(pubArmed).length && body.player.steamid) {
      // Matchid: GSI:s map.matchid i forsta hand; console.log-tailens
      // observation (POST /api/overlay-console-event) som fallback om
      // GSI-faltet saknas/ar "0". Avvikelse mellan kallorna loggas —
      // verifieringsdata for TODO-punkten om map.matchid:s palitlighet.
      const gsiMid = (body.map && body.map.matchid && String(body.map.matchid) !== '0') ? String(body.map.matchid) : null;
      const conEntry = consoleMatchIdByAccount[steam64ToAccountId(body.player.steamid)];
      const conMid = (conEntry && Date.now() - conEntry.ts < 2 * 60 * 60 * 1000) ? conEntry.matchId : null;
      if (gsiMid && conMid && gsiMid !== conMid) console.log('[PUB] matchid-avvikelse: GSI=' + gsiMid + ' console.log=' + conMid + ' — GSI anvands');
      const pubMid = gsiMid || conMid;
      if (pubMid) {
      pubPrune();
      const pubStates = ['DOTA_GAMERULES_STATE_HERO_SELECTION', 'DOTA_GAMERULES_STATE_STRATEGY_TIME',
        'DOTA_GAMERULES_STATE_TEAM_SHOWCASE', 'DOTA_GAMERULES_STATE_WAIT_FOR_MAP_TO_LOAD',
        'DOTA_GAMERULES_STATE_PRE_GAME', 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS'];
      if (pubStates.includes(state)) {
        const pubAlias = await findAliasBySteamId64(body.player.steamid);
        if (pubAlias && pubArmed[pubAlias] && !pubArmed[pubAlias].playbookMatchId) {
          const pubKey = pubMid + ':' + myTeam;
          let sess = pubSessions[pubKey];
          if (!sess) {
            sess = pubSessions[pubKey] = { dotaMatchId: pubMid, team: myTeam, players: {},
              captureAttempts: 0, lastCaptureReq: 0, generating: false, failed: false, playbookMatchId: null, createdAt: Date.now() };
            console.log('[PUB] Ny session', pubKey, 'via', pubAlias);
          }
          const pd = sess.players[pubAlias] || (sess.players[pubAlias] = {});
          if (body.hero && body.hero.id > 0) pd.heroId = body.hero.id;

          if ((state === 'DOTA_GAMERULES_STATE_PRE_GAME' || state === 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS')
              && !sess.playbookMatchId && !sess.generating && !sess.failed
              && sess.captureAttempts < 5 && Date.now() - sess.lastCaptureReq > 20000) {
            sess.lastCaptureReq = Date.now();
            sess.captureAttempts++;
            pushOverlay(pubAlias, 'capture-request', '', '');
            console.log('[PUB] Capture-request till ' + pubAlias + ' (forsok ' + sess.captureAttempts + ')');
          }
        }
      }
      }
    }

    // OBS: i All Pick ar draft-objektet ALLTID tomt (bekraftat mot riktig Ranked
    // All Pick 2026-07-13) — darfor far tom draft inte langre stoppa hela handlern.
    // Draft-beroende delar (ersattning vid bans, CM-itemtips) hoppar over sig
    // sjalva nedan; capture-flodet och itemtiming-paminnelserna klarar sig utan.
    const enemyTeamKey = myTeam === 'radiant' ? 'team3' : 'team2';
    const enemyTeam = draft ? draft[enemyTeamKey] : null;

    const heroMap = await heroInternalNameMap();
    const enemyHeroes = [];
    if (enemyTeam) for (let i = 0; i < 5; i++) {
      const cls = enemyTeam['pick' + i + '_class'];
      if (cls && heroMap[cls]) enemyHeroes.push(heroMap[cls]);
    }

    // ── Live under draften (Captain's Mode): foresla ersattare sa fort en
    // planerad hjalte forsvinner. Draft-objektet ar ALLTID tomt i All Pick
    // (bekraftat 2026-07-13) sa det har blocket bidrar aldrig med nagot dar —
    // se ban-logg-OCR-blocket nedan for All Pick-motsvarigheten ──
    if (state === 'DOTA_GAMERULES_STATE_HERO_SELECTION' && draft) {
      const allBannedNames = [];
      ['team2', 'team3'].forEach(tk => {
        const t = draft[tk];
        if (!t) return;
        for (let i = 0; i < 8; i++) {
          const cls = t['ban' + i + '_class'];
          if (cls && heroMap[cls]) allBannedNames.push(heroMap[cls]);
        }
      });
      const currentUnavailable = new Set([...enemyHeroes, ...allBannedNames]);
      const newlyUnavailable = [...currentUnavailable].filter(h => !gsiSeenUnavailable.has(h));
      currentUnavailable.forEach(h => gsiSeenUnavailable.add(h));
      await applyNewlyUnavailableHeroes(newlyUnavailable);
    }

    // ── All Pick: bannade hjaltar syns aldrig i GSI:s draft-objekt (bekraftat
    // 2026-07-13), men skrivs ut som REN TEXT i ban-loggen ("X has been
    // Banned.") pa skarmen under HERO_SELECTION — be overlayn om en
    // screenshot av just den panelen och las av med OCR istallet (POST
    // /api/overlay-ban-capture + ban-log-match.js). Loggen ar skrollande sa
    // en enskild avlasning kan klippa en rad i kanten (verifierat 2026-07-17)
    // — darfor fragar vi ofta under hela HERO_SELECTION och later
    // gsiSeenUnavailable ackumulera over flera avlasningar, samma monster
    // som CM-blocket ovan.
    if (state === 'DOTA_GAMERULES_STATE_HERO_SELECTION' && serverStatus.latestMatchId && body.player.steamid) {
      if (gsiBanCaptureState.matchId !== serverStatus.latestMatchId) {
        gsiBanCaptureState = { matchId: serverStatus.latestMatchId, lastReq: 0 };
      }
      if (Date.now() - gsiBanCaptureState.lastReq > 10000) {
        gsiBanCaptureState.lastReq = Date.now();
        const banAlias = await findAliasBySteamId64(body.player.steamid);
        if (banAlias) pushOverlay(banAlias, 'capture-ban-request', '', '');
      }
    }

    // ── All Pick: fiendehjaltar syns aldrig i GSI (bekraftat 2026-07-13) — be
    // spelarens overlay om en topbar-screenshot och las fienderna darifran
    // istallet (POST /api/overlay-capture + topbar-match.js) ──
    if ((state === 'DOTA_GAMERULES_STATE_PRE_GAME' || state === 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS')
        && serverStatus.latestMatchId && body.player.steamid) {
      if (gsiCaptureState.matchId !== serverStatus.latestMatchId) {
        gsiCaptureState = { matchId: serverStatus.latestMatchId, attempts: 0, lastReq: 0, done: false };
      }
      if (!gsiCaptureState.done && gsiCaptureState.attempts < 3 && Date.now() - gsiCaptureState.lastReq > 20000) {
        gsiCaptureState.lastReq = Date.now(); // satt direkt sa tata payloads inte dubblar requesten
        const capMatches = await readMatches();
        const capMatch = capMatches.find(m => m.id === serverStatus.latestMatchId);
        if (capMatch && !capMatch.items && !(capMatch.enemies || []).length) {
          const capAlias = await findAliasBySteamId64(body.player.steamid);
          if (capAlias) {
            gsiCaptureState.attempts++;
            pushOverlay(capAlias, 'capture-request', '', '');
            console.log('[GSI] Capture-request till overlay (forsok ' + gsiCaptureState.attempts + ')');
          }
        } else {
          gsiCaptureState.done = true; // fiender/items finns redan (manuellt eller via capture) — sluta fraga
        }
      }
    }

    // ── Live under matchen: paminn den enskilda spelaren om sina egna itemtips ──
    if (state === 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS') {
      const alias = await findAliasBySteamId64(body.player && body.player.steamid);
      if (alias) {
        const now = Date.now();
        if (now - (gsiLastItemCheck[alias] || 0) >= 5000) { // throttla JSONBin-lasningar till var 5:e sekund per spelare
          gsiLastItemCheck[alias] = now;

          if (gsiItemCache.matchId !== serverStatus.latestMatchId) {
            gsiItemCache = { matchId: serverStatus.latestMatchId, timingsByAlias: {} };
            gsiRemindedItems = new Set();
          }
          if (!(alias in gsiItemCache.timingsByAlias)) {
            const matches = await readMatches();
            const match = matches.find(m => m.id === serverStatus.latestMatchId);
            if (match && match.items) gsiItemCache.timingsByAlias[alias] = parsePlayerItemTimings(match.items, alias);
          }

          const timings = gsiItemCache.timingsByAlias[alias];
          if (timings && timings.length > 0) {
            const nameMap = await itemDisplayNameMap();
            const owned = ownedItemKeys(body.items);
            const clockSeconds = (body.map && body.map.clock_time) || 0;
            const due = dueReminders(timings, owned, clockSeconds, nameMap, gsiRemindedItems, gsiItemCache.matchId, alias);
            due.forEach(t => {
              pushOverlay(alias, 'item-reminder', 'Itemtips', 'Dags att kopa ' + t.item + ' (senast minut ' + t.minute + ')');
              console.log('[GSI] Itemparminnelse:', alias, '->', t.item);
            });
          }
        }
      }
    }

    if (!justEnteredStrategyTime) return;
    if (enemyHeroes.length < 5) return; // ofullstandig draft-data (eller All Pick, dar draft alltid ar tom — capture-flodet tar over dar)
    await generateItemTipsForMatch(serverStatus.latestMatchId, enemyHeroes);
  } catch(e) { console.error('[GSI] Fel:', e.message); }
});

app.get('/tv', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tv.html')));
app.get('/pool', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pool.html')));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, async () => {
  console.log(`Laneight running on port ${PORT}`);
  await initBins();
});
