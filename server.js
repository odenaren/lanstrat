const express = require('express');
const cors = require('cors');
const path = require('path');

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
    "connect-src 'self'; " +
    "media-src 'self'"
  );
  next();
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
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const players = await readPlayers();
    if (players.find(p => p.name === name)) return res.status(409).json({ error: 'Player exists' });
    players.push({ name, heroes: [] });
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

// ── STATUS (polling) ─────────────────────────────────
let serverStatus = { generating: false, latestMatchId: null, replayToken: null };
app.get('/api/status', (req, res) => res.json(serverStatus));
app.post('/api/status/generating', (req, res) => {
  serverStatus.generating = !!req.body.generating;
  res.json(serverStatus);
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
  const { players, strategy, briefing, captainNotes, draft, name, wildcard, style } = req.body;
  try {
    const matches = await readMatches();
    const gameNumber = matches.length + 1;
    const match = {
      id: req.body.id || Date.now().toString(),
      createdAt: new Date().toISOString(),
      gameNumber: gameNumber,
      name: name || '',
      briefing: briefing || '',
      captainNotes: captainNotes || '',
      wildcard: !!wildcard,
      style: style || 'standard',
      players,
      strategy,
      draft,
      enemies: [],
      items: null
    };
    matches.unshift(match);
    await writeMatches(matches);
    serverStatus.latestMatchId = match.id;
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
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] })
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
