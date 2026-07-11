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
const STUDIO_DIR = path.join(__dirname, 'public', 'studio');
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
  splitpush:'Splitpush', chaos:'Chaos & Disruption', objective:'Objective Control',
  towerdive:'Tower Dive Heavy', global:'Global Presence', magicimmune:'Magic Immune — BKB focus'
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
  const outDir = path.join(STUDIO_DIR, String(odId));
  const manifestFile = path.join(outDir, 'manifest.json');
  if (fs.existsSync(manifestFile) && !force) return { alreadyExists: true };

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

  const summary = {
    dhs_team: weAreRadiant ? 'Radiant' : 'Dire',
    dhs_result: matchResult,
    duration_minutes: min(m.duration),
    winner: m.radiant_win ? 'Radiant' : 'Dire',
    score: 'Radiant ' + m.radiant_score + ' — ' + m.dire_score + ' Dire',
    radiant_gold_advantage_per_minute: m.radiant_gold_adv || null,
    biggest_teamfights: teamfights,
    roshan_kills: roshans,
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

  fs.mkdirSync(outDir, { recursive: true });

  const segments = [];
  for (let i = 0; i < recap.dialogue.length; i++) {
    const d = recap.dialogue[i];
    const fname = 'seg_' + String(i).padStart(2, '0') + '.mp3';
    const fpath = path.join(outDir, fname);
    if (!fs.existsSync(fpath) || force) {
      const body = { text: d.text, model_id: 'eleven_multilingual_v2', voice_settings: SETTINGS_MAP[d.speaker] || SETTINGS_MAP.analyst1 };
      if (i > 0) body.previous_text = recap.dialogue[i-1].text;
      if (i < recap.dialogue.length - 1) body.next_text = recap.dialogue[i+1].text;
      const tRes = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + (VOICE_MAP[d.speaker] || voices.analytic), {
        method: 'POST',
        headers: { 'xi-api-key': EL_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!tRes.ok) throw new Error('ElevenLabs ' + tRes.status + ' på replik ' + i);
      fs.writeFileSync(fpath, Buffer.from(await tRes.arrayBuffer()));
      await new Promise(r => setTimeout(r, 800));
    }
    segments.push({ speaker: d.speaker, text: d.text, mentions: d.mentions, file: fname });
  }

  const manifest = {
    odMatchId: String(odId),
    strategyMatchId: strategyMatch.id,
    strategyName: strategyMatch.name || null,
    headline: recap.headline || null,
    generatedAt: new Date().toISOString(),
    segments: segments,
    angles: recap.angles || []
  };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

  history.push({ match_id: String(odId), angles: recap.angles || [], at: new Date().toISOString() });
  fs.writeFileSync(RECAP_HISTORY_FILE, JSON.stringify(history.slice(-10), null, 2));

  return { ok: true, segments: segments.length };
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
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  } finally {
    serverStatus.generating = false;
  }
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
    const manifest = path.join(__dirname, 'public', 'studio', String(match.openDotaMatchId), 'manifest.json');
    if (!fs.existsSync(manifest)) return res.status(404).json({ error: 'Ingen studioanalys genererad — kor generate-studio.js forst' });
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
