// bank-studio.js — lokalt GUI för announcer-ljudbanken
//
// Körning (från mappen med bank-lines.json):
//   cmd:        set ELEVENLABS_API_KEY=sk_xxx && node bank-studio.js
//   PowerShell: $env:ELEVENLABS_API_KEY="sk_xxx"; node bank-studio.js
//
// Öppna sedan http://localhost:4600 i webbläsaren.
//
// Filer som används i samma mapp:
//   bank-lines.json   — event och repliker (samma som förut)
//   bank-config.json  — röst-ID:n och event→röst-mappning (skapas automatiskt)
//   bank/             — genererade mp3-filer

const http = require('http');
const fs = require('fs');
const path = require('path');

// Läs .env-fil om den finns (rad-format: NYCKEL=värde)
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
}

const PORT = 4600;
const API_KEY = process.env.ELEVENLABS_API_KEY;
const MODEL_ID = 'eleven_multilingual_v2';
const VOICE_SETTINGS = { stability: 0.4, similarity_boost: 0.8, style: 0.55 };

const LINES_FILE = path.join(__dirname, 'bank-lines.json');
const CONFIG_FILE = path.join(__dirname, 'bank-config.json');
const BANK_DIR = path.join(__dirname, 'bank');
const HTML_FILE = path.join(__dirname, 'bank-studio.html');

if (!fs.existsSync(BANK_DIR)) fs.mkdirSync(BANK_DIR);
if (!fs.existsSync(LINES_FILE)) fs.writeFileSync(LINES_FILE, '{}');
if (!fs.existsSync(CONFIG_FILE)) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    voices: { generic1: '', generic2: '', intense: '', analytic: '' },
    eventVoice: {
      killstreak_5: 'intense', rampage: 'intense', item_rapier: 'intense',
      defeat: 'analytic'
    }
  }, null, 2));
}

function readJson(f) { return JSON.parse(fs.readFileSync(f, 'utf8')); }
function writeJson(f, data) { fs.writeFileSync(f, JSON.stringify(data, null, 2)); }

function voiceIdFor(event, index) {
  const cfg = readJson(CONFIG_FILE);
  const v = cfg.eventVoice[event] || 'duo';
  if (v === 'duo') return index % 2 === 0 ? cfg.voices.generic1 : cfg.voices.generic2;
  return cfg.voices[v] || '';
}

async function tts(text, voiceId) {
  if (!API_KEY) throw new Error('ELEVENLABS_API_KEY är inte satt — starta om med nyckeln som miljövariabel');
  if (!voiceId) throw new Error('Röst-ID saknas — fyll i under Röster i GUI:t');
  const res = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voiceId, {
    method: 'POST',
    headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: MODEL_ID, voice_settings: VOICE_SETTINGS })
  });
  if (!res.ok) throw new Error('ElevenLabs ' + res.status + ': ' + await res.text());
  return Buffer.from(await res.arrayBuffer());
}

function fileNameFor(event, index) {
  return event + '_' + String(index + 1).padStart(2, '0') + '.mp3';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch(e) { reject(e); } });
  });
}

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json' });
  res.end(type ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, fs.readFileSync(HTML_FILE), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const files = fs.readdirSync(BANK_DIR).filter(f => f.endsWith('.mp3'));
      return send(res, 200, {
        lines: readJson(LINES_FILE),
        config: readJson(CONFIG_FILE),
        files: files,
        apiKeySet: !!API_KEY
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/lines') {
      writeJson(LINES_FILE, await readBody(req));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      writeJson(CONFIG_FILE, await readBody(req));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/generate-one') {
      const { event, index } = await readBody(req);
      const lines = readJson(LINES_FILE);
      if (!lines[event] || !lines[event][index]) return send(res, 404, { error: 'Repliken finns inte' });
      const file = path.join(BANK_DIR, fileNameFor(event, index));
      if (fs.existsSync(file)) return send(res, 200, { ok: true, skipped: true });
      const buf = await tts(lines[event][index], voiceIdFor(event, index));
      fs.writeFileSync(file, buf);
      return send(res, 200, { ok: true, chars: lines[event][index].length });
    }
    if (req.method === 'POST' && url.pathname === '/api/preview') {
      const { text, event, index } = await readBody(req);
      const buf = await tts(text, voiceIdFor(event, index));
      return send(res, 200, buf, 'audio/mpeg');
    }
    if (req.method === 'POST' && url.pathname === '/api/suggest-lines') {
      const { event, description, count, existing } = await readBody(req);
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return send(res, 503, { error: 'ANTHROPIC_API_KEY saknas i .env' });
      const n = Math.min(Math.max(count || 8, 1), 15);
      const prompt = 'You write short SPOKEN lines for an esports announcer at a private Dota 2 LAN called Dreamhack Skyrup. '
        + 'The lines are read aloud by a deep-voiced caster - write for the EAR: 4-15 words each, TI grand final energy, '
        + 'punctuation for pacing (ellipses for pauses, dashes for beats, occasional CAPS for ONE emphasized word). Vary the energy and angle between lines.'
        + '\n\nEVENT NAME: ' + event
        + '\nWHAT THE EVENT MEANS: ' + (description || 'infer from the event name')
        + (existing && existing.length ? '\n\nEXISTING LINES (do NOT repeat their phrasing or angles):\n' + existing.join('\n') : '')
        + '\n\nWrite exactly ' + n + ' new lines in ENGLISH. Reply ONLY with a JSON array of strings, no markdown, no other text.';
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-fable-5', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] })
      });
      if (!aiRes.ok) throw new Error('Anthropic ' + aiRes.status + ': ' + await aiRes.text());
      const data = await aiRes.json();
      const text = (data.content || []).map(c => c.text || '').join('').replace(/```json|```/g, '').trim();
      let suggestions;
      try { suggestions = JSON.parse(text); } catch(e) { throw new Error('Kunde inte tolka AI-svaret som JSON'); }
      if (!Array.isArray(suggestions) || !suggestions.every(s => typeof s === 'string')) throw new Error('Oväntat AI-svarsformat');
      return send(res, 200, { lines: suggestions });
    }
    if (req.method === 'POST' && url.pathname === '/api/delete-event-files') {
      const { event } = await readBody(req);
      let n = 0;
      fs.readdirSync(BANK_DIR).forEach(f => {
        if (f.startsWith(event + '_') && f.endsWith('.mp3')) { fs.unlinkSync(path.join(BANK_DIR, f)); n++; }
      });
      return send(res, 200, { ok: true, deleted: n });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/bank/')) {
      const f = path.join(BANK_DIR, path.basename(url.pathname));
      if (!fs.existsSync(f)) return send(res, 404, { error: 'Filen finns inte' });
      return send(res, 200, fs.readFileSync(f), 'audio/mpeg');
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log('Bank Studio: http://localhost:' + PORT);
  if (!API_KEY) console.log('OBS: ELEVENLABS_API_KEY är inte satt — du kan redigera repliker men inte generera ljud.');
});
