const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const JSONBIN_BASE = 'https://api.jsonbin.io/v3';

app.use(cors());
app.use(express.json({ limit: '2mb' }));
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
      return { alias: ch.alias, challenge: ch.text, target: ch.op + ' ' + ch.value + ' ' + ch.metric, actual: r.actual, passed: r.passed };
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
    + 'challenge for this match, with verified results. Weave the 1-3 most interesting outcomes into the discussion — '
    + 'celebrate a clutch clear or roast a spectacular fail. Do NOT recite the full challenge list.'
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
const CHALLENGE_METRICS = {
  kills: 'kills', deaths: 'deaths (getts som max, op <=)', assists: 'assists',
  last_hits: 'last hits', denies: 'denies',
  gold_per_min: 'GPM', xp_per_min: 'XPM',
  hero_damage: 'hero damage totalt', tower_damage: 'tower damage totalt', hero_healing: 'healing totalt',
  obs_placed: 'observer wards placerade', sen_placed: 'sentry wards placerade',
  stuns: 'stun-sekunder totalt'
};

function evalChallenge(ch, odRow) {
  const raw = ch.metric === 'stuns' ? (odRow.stuns || 0) : (odRow[ch.metric] || 0);
  const actual = Math.round(raw);
  const passed = ch.op === '<=' ? actual <= ch.value : actual >= ch.value;
  return { actual, passed };
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
    + 'en carry farm/damage-utmaningar, en offlane tanka/disrupta. Svarighetsgrad: klarbar men inte gratis — man ska behova tanka pa den under matchen.'
    + '\n\nTillgangliga metrics (anvand exakt dessa nycklar): ' + JSON.stringify(CHALLENGE_METRICS)
    + '\nop ar ">=" (minst) eller "<=" (hogst, typiskt for deaths).'
    + '\n\nDRAFT (spelare -> hjalte): ' + JSON.stringify(draft)
    + '\nSTRATEGI (roller och plan): ' + (match.currentStrategy || match.strategy || '').slice(0, 1500)
    + '\n\nSvara ENDAST med JSON, ingen markdown:'
    + '\n{"challenges":[{"alias":"exakt spelarnamn ur draften","text":"kort slagkraftig utmaningstext pa svenska, max 12 ord","metric":"nyckel ur menyn","op":">=","value":42}]}';

  const text = (await callClaude(prompt, 1500)).replace(/```json|```/g, '').trim();
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1) throw new Error('Ogiltigt utmaningssvar fran AI');
  const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));

  const valid = (parsed.challenges || []).filter(c =>
    c && aliases.includes(c.alias) && CHALLENGE_METRICS[c.metric]
    && (c.op === '>=' || c.op === '<=') && typeof c.value === 'number' && c.text
  );
  if (!valid.length) throw new Error('Inga giltiga utmaningar i AI-svaret');

  // Las om binen — annan skrivning kan ha hunnit fore under AI-anropet
  const fresh = await readMatches();
  const freshMatch = fresh.find(m => m.id === matchId);
  if (!freshMatch) return;
  freshMatch.challenges = valid.map(c => ({ alias: c.alias, text: c.text, metric: c.metric, op: c.op, value: c.value }));
  await writeMatches(fresh);
  console.log('Utmaningar genererade for match ' + matchId + ' (' + valid.length + ' st)');
}

// MATCHES
app.get('/api/matches', async (req, res) => {
  try { res.json(await readMatches()); }
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

app.get('/tv', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tv.html')));
app.get('/pool', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pool.html')));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, async () => {
  console.log(`Laneight running on port ${PORT}`);
  await initBins();
});
