// design-lights.js — låter AI:n designa ljusprofiler för D4200:an per event
//
// Körning (från soundbank-mappen, kräver ANTHROPIC_API_KEY i .env):
//   node design-lights.js
//
// Läser eventen ur bank-lines.json och beskrivningarna ur bank-config.json,
// och skriver light-profiles.json — vårt mellanformat som senare konverteras
// till D4200:ans profilformat (när vi verifierat schemat mot enheten).
// Kör om skriptet för att designa om allt; redigera JSON-filen fritt för finjustering.

const fs = require('fs');
const path = require('path');

// Läs .env-fil om den finns
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
}

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.error('ANTHROPIC_API_KEY saknas i .env'); process.exit(1); }

const lines = JSON.parse(fs.readFileSync(path.join(__dirname, 'bank-lines.json'), 'utf8'));
let eventDesc = {};
try { eventDesc = JSON.parse(fs.readFileSync(path.join(__dirname, 'bank-config.json'), 'utf8')).eventDesc || {}; } catch(e) {}

const events = Object.keys(lines).map(ev => ({
  name: ev,
  description: eventDesc[ev] || '',
  sampleLine: (lines[ev][0] || '')
}));

const prompt = 'You are designing light effects for an RGBA strobe light at a private Dota 2 LAN called Dreamhack Skyrup. '
  + 'For each game event below, design 2-3 light VARIANTS so the same event never looks identical twice. '
  + 'Variants of one event should feel like siblings: same color family and mood, but different pattern/tempo/intensity.'
  + '\n\nDesign principles:'
  + '\n- Color should match the event semantics (examples: blood/kills lean red, magic/objectives can lean blue or purple, gold/victory lean warm gold, defeat lean cold dim blue). These are examples - use your judgment.'
  + '\n- Big rare moments (rampage, victory) = high intensity, dramatic patterns, higher priority.'
  + '\n- Frequent small events (tower_fall, killstreak_3) = shorter, calmer, lower priority so they never dominate.'
  + '\n- priority: 1-10 where 10 interrupts everything. Same event = same priority across its variants.'
  + '\n- duration_s: how long the effect runs (2-12 seconds, matched to the moment).'
  + '\n\nEVENTS:\n' + events.map(e =>
      '- ' + e.name + (e.description ? ' — ' + e.description : '') + (e.sampleLine ? ' (caster line: "' + e.sampleLine + '")' : '')
    ).join('\n')
  + '\n\nReply ONLY with JSON (no markdown), in this exact shape:'
  + '\n{"<event>": {"priority": <1-10>, "variants": [{"name": "<event>_light_a", "color": "#RRGGBB", "pattern": "<steady|pulse|flash|strobe|fade>", "intensity": <1-100>, "duration_s": <number>, "mood": "<3-6 word description>"}]}}';

(async () => {
  console.log('Skickar ' + events.length + ' events till AI:n för ljusdesign…');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-fable-5', max_tokens: 4000, messages: [{ role: 'user', content: prompt }] })
  });
  if (!res.ok) { console.error('Anthropic ' + res.status + ': ' + await res.text()); process.exit(1); }
  const data = await res.json();
  const text = (data.content || []).map(c => c.text || '').join('').replace(/```json|```/g, '').trim();
  let profiles;
  try { profiles = JSON.parse(text); } catch(e) { console.error('Kunde inte tolka AI-svaret:\n' + text); process.exit(1); }

  fs.writeFileSync(path.join(__dirname, 'light-profiles.json'), JSON.stringify(profiles, null, 2));

  console.log('\nlight-profiles.json skapad:\n');
  Object.keys(profiles).forEach(ev => {
    const p = profiles[ev];
    console.log(ev + '  (prio ' + p.priority + ')');
    (p.variants || []).forEach(v => {
      console.log('   ' + v.name + '  ' + v.color + '  ' + v.pattern + '  int:' + v.intensity + '  ' + v.duration_s + 's  — ' + v.mood);
    });
  });
  const totalVariants = Object.values(profiles).reduce((n, p) => n + (p.variants || []).length, 0);
  console.log('\nTotalt ' + totalVariants + ' ljusvarianter för ' + Object.keys(profiles).length + ' events.');
  if (totalVariants > 30) console.log('OBS: D4200:an rymmer max 30 profiler — beskär i light-profiles.json innan enhetsuppladdning.');
})();
