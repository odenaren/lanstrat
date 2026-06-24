const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
const MATCHES_FILE = path.join(DATA_DIR, 'matches.json');

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(PLAYERS_FILE)) fs.writeFileSync(PLAYERS_FILE, '[]');
if (!fs.existsSync(MATCHES_FILE)) fs.writeFileSync(MATCHES_FILE, '[]');

function read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } }
function write(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// ── PLAYERS ──────────────────────────────────────────
app.get('/api/players', (req, res) => res.json(read(PLAYERS_FILE)));

app.post('/api/players', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const players = read(PLAYERS_FILE);
  if (players.find(p => p.name === name)) return res.status(409).json({ error: 'Player exists' });
  players.push({ name, heroes: [] });
  write(PLAYERS_FILE, players);
  res.json(players);
});

app.put('/api/players/:name/rename', (req, res) => {
  const { newName } = req.body;
  if(!newName) return res.status(400).json({ error: 'newName required' });
  const players = read(PLAYERS_FILE);
  const p = players.find(p => p.name === req.params.name);
  if(!p) return res.status(404).json({ error: 'Player not found' });
  if(players.find(p => p.name === newName)) return res.status(409).json({ error: 'Name taken' });
  p.name = newName;
  write(PLAYERS_FILE, players);
  res.json(players);
});

app.delete('/api/players/:name', (req, res) => {
  const players = read(PLAYERS_FILE).filter(p => p.name !== req.params.name);
  write(PLAYERS_FILE, players);
  res.json(players);
});

app.put('/api/players/:name/heroes', (req, res) => {
  const players = read(PLAYERS_FILE);
  const p = players.find(p => p.name === req.params.name);
  if (!p) return res.status(404).json({ error: 'Not found' });
  p.heroes = req.body.heroes || [];
  write(PLAYERS_FILE, players);
  res.json(p);
});

// ── MATCHES ──────────────────────────────────────────
app.get('/api/matches', (req, res) => res.json(read(MATCHES_FILE)));

app.post('/api/matches', (req, res) => {
  const { players, strategy, draft, name, wildcard } = req.body;
  const matches = read(MATCHES_FILE);
  const match = {
    id: Date.now().toString(),
    createdAt: new Date().toISOString(),
    name: name||'',
    wildcard: !!wildcard,
    players,
    strategy,
    draft,
    enemies: [],
    items: null
  };
  matches.unshift(match);
  write(MATCHES_FILE, matches);
  res.json(match);
});

app.get('/api/matches/:id', (req, res) => {
  const match = read(MATCHES_FILE).find(m => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: 'Not found' });
  res.json(match);
});

app.put('/api/matches/:id/enemies', (req, res) => {
  const matches = read(MATCHES_FILE);
  const match = matches.find(m => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: 'Not found' });
  match.enemies = req.body.enemies || [];
  write(MATCHES_FILE, matches);
  res.json(match);
});

app.put('/api/matches/:id/memory', (req, res) => {
  const matches = read(MATCHES_FILE);
  const match = matches.find(m => m.id === req.params.id);
  if(!match) return res.status(404).json({ error: 'Not found' });
  match.excludeFromMemory = !!req.body.excludeFromMemory;
  write(MATCHES_FILE, matches);
  res.json(match);
});

app.put('/api/matches/:id/items', (req, res) => {
  const matches = read(MATCHES_FILE);
  const match = matches.find(m => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: 'Not found' });
  match.items = req.body.items;
  write(MATCHES_FILE, matches);
  res.json(match);
});

app.delete('/api/matches/:id', (req, res) => {
  const matches = read(MATCHES_FILE).filter(m => m.id !== req.params.id);
  write(MATCHES_FILE, matches);
  res.json({ ok: true });
});

// ── AI ───────────────────────────────────────────────
async function callClaude(prompt, maxTokens = 1500) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set on server');
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
  try {
    const text = await callClaude(req.body.prompt, 1500);
    res.json({ text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/items', async (req, res) => {
  try {
    const text = await callClaude(req.body.prompt, 1200);
    res.json({ text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Laneight running on port ${PORT}`));
