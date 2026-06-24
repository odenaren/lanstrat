const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'players.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ensure data directory exists
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'));
}
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2));
}

function readPlayers() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writePlayers(players) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(players, null, 2));
}

// GET all players
app.get('/api/players', (req, res) => {
  res.json(readPlayers());
});

// POST add player
app.post('/api/players', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const players = readPlayers();
  if (players.find(p => p.name === name)) {
    return res.status(409).json({ error: 'Player already exists' });
  }
  players.push({ name, heroes: [] });
  writePlayers(players);
  res.json(players);
});

// DELETE player
app.delete('/api/players/:name', (req, res) => {
  let players = readPlayers();
  players = players.filter(p => p.name !== req.params.name);
  writePlayers(players);
  res.json(players);
});

// PUT update hero pool for a player
app.put('/api/players/:name/heroes', (req, res) => {
  const { heroes } = req.body;
  const players = readPlayers();
  const player = players.find(p => p.name === req.params.name);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  player.heroes = heroes || [];
  writePlayers(players);
  res.json(player);
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Laneight running on port ${PORT}`);
});
