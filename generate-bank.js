// generate-bank.js — bulkgenererar announcer-ljudbank via ElevenLabs
//
// 1. Klistra in dina fyra röst-ID:n i VOICES nedan
// 2. Kör (från mappen med bank-lines.json):
//      ELEVENLABS_API_KEY=sk_xxx node generate-bank.js
//    Windows (cmd):  set ELEVENLABS_API_KEY=sk_xxx && node generate-bank.js
//
// Resultat: ./bank/first_blood_01.mp3, ...
// Resume-säkert: befintliga filer hoppas över — kör om efter avbrott,
// nya repliker eller ändrad röstmappning (radera då berörda filer först).

const fs = require('fs');
const path = require('path');

// ── RÖSTER: klistra in dina voice-ID:n här ──────────────────────────
const VOICES = {
  generic1: 'BKWNPLMZRm7a8Wnez453',   // generisk röst A (play-by-play)
  generic2: 'L9dOHOIEZZqpIpVTGRMX',   // generisk röst B (play-by-play)
  intense:  'dbHu481wImqzDVSDOkln',   // intensiv röst (de stora ögonblicken)
  analytic: 'thxIt8KyvIvmcMAH0cUP'    // analytisk röst (eftertanke, analys)
};

// ── MAPPNING: event → röst ('duo' växlar mellan generic1/generic2) ──
const EVENT_VOICE = {
  match_start:  'duo',
  first_blood:  'duo',
  tower_fall:   'duo',
  killstreak_3: 'duo',
  roshan:       'duo',
  killstreak_5: 'intense',
  rampage:      'intense',
  victory:      'duo',
  defeat:       'analytic'
};

const API_KEY = process.env.ELEVENLABS_API_KEY;
const MODEL_ID = 'eleven_multilingual_v2';
const VOICE_SETTINGS = { stability: 0.4, similarity_boost: 0.8, style: 0.55 };
const DELAY_MS = 1500;

if (!API_KEY) {
  console.error('Sätt ELEVENLABS_API_KEY som miljövariabel.');
  process.exit(1);
}
const missing = Object.keys(VOICES).filter(k => VOICES[k].indexOf('KLISTRA') !== -1);
if (missing.length) {
  console.error('Klistra in röst-ID för: ' + missing.join(', ') + ' (överst i skriptet)');
  process.exit(1);
}

function voiceFor(event, variantIndex) {
  const v = EVENT_VOICE[event] || 'duo';
  if (v === 'duo') return variantIndex % 2 === 0 ? VOICES.generic1 : VOICES.generic2;
  return VOICES[v];
}

const lines = JSON.parse(fs.readFileSync(path.join(__dirname, 'bank-lines.json'), 'utf8'));
const outDir = path.join(__dirname, 'bank');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

const wait = ms => new Promise(r => setTimeout(r, ms));

async function tts(text, voiceId) {
  const res = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voiceId, {
    method: 'POST',
    headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: MODEL_ID, voice_settings: VOICE_SETTINGS })
  });
  if (!res.ok) throw new Error(res.status + ': ' + await res.text());
  return Buffer.from(await res.arrayBuffer());
}

(async () => {
  let done = 0, skipped = 0, failed = 0, totalChars = 0;
  const events = Object.keys(lines);
  const total = events.reduce((n, e) => n + lines[e].length, 0);
  console.log('Ljudbank: ' + total + ' repliker, ' + events.length + ' events, 4 röster\n');

  for (const event of events) {
    for (let i = 0; i < lines[event].length; i++) {
      const nr = String(i + 1).padStart(2, '0');
      const file = path.join(outDir, event + '_' + nr + '.mp3');
      const text = lines[event][i];
      if (fs.existsSync(file)) { skipped++; continue; }
      try {
        const buf = await tts(text, voiceFor(event, i));
        fs.writeFileSync(file, buf);
        done++;
        totalChars += text.length;
        console.log('✓ ' + event + '_' + nr + '.mp3  [' + (EVENT_VOICE[event] || 'duo') + ']  "' + text + '"');
      } catch (e) {
        failed++;
        console.error('✗ ' + event + '_' + nr + '  ' + e.message);
      }
      await wait(DELAY_MS);
    }
  }

  console.log('\nKlart: ' + done + ' genererade, ' + skipped + ' fanns redan, ' + failed + ' misslyckades');
  console.log('Förbrukade tecken denna körning: ~' + totalChars);
  if (failed) console.log('Kör skriptet igen för att göra om de som misslyckades.');
})();
