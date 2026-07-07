// analyze-match.js — AI-eftersnack som DIALOG mellan host och analytiker
//
// Körning (från soundbank-mappen):
//   node analyze-match.js <match_id>          (bara manus i terminalen)
//   node analyze-match.js <match_id> --tts    (även mp3 med host- + analytic-rösterna)
//
// Kräver: ANTHROPIC_API_KEY i .env
// --tts kräver även: ELEVENLABS_API_KEY i .env samt "host" och "analytic"
// röst-ID:n i bank-config.json
//
// recap-history.json (skapas automatiskt) minns tidigare eftersnacks vinklar
// så att varje match får en egen berättelse istället för samma mall.

const fs = require('fs');
const path = require('path');

const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
}

const KEY = process.env.ANTHROPIC_API_KEY;
const MATCH_ID = process.argv[2];
const DO_TTS = process.argv.includes('--tts');
const HISTORY_FILE = path.join(__dirname, 'recap-history.json');
const ROSTER_FILE = path.join(__dirname, 'dhs-roster.json');

// DHS-rostern: nick + Steam-alias. Skapas med grunduppsättningen, fyll på aliases
// med spelarnas Steam-visningsnamn om de skiljer sig fran nicket.
if (!fs.existsSync(ROSTER_FILE)) {
  fs.writeFileSync(ROSTER_FILE, JSON.stringify([
    { nick: 'Rutigaskjortan', aliases: [] },
    { nick: 'Elsa', aliases: [] },
    { nick: 'Pax', aliases: [] },
    { nick: 'Jockwe', aliases: [] },
    { nick: 'Flabben', aliases: [] },
    { nick: 'PUGGE', aliases: ['Tobbe', 'TOBBE'] },
    { nick: 'Gojja', aliases: [] },
    { nick: 'Robin Hood', aliases: [] },
    { nick: 'Skiipa', aliases: ['venomspark', 'ayawasker'] }
  ], null, 2));
}
const roster = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8'));
function dhsNick(personaname) {
  const p = (personaname || '').trim().toLowerCase();
  if (!p) return null;
  const hit = roster.find(r => r.nick.toLowerCase() === p || (r.aliases || []).some(a => a.toLowerCase() === p));
  return hit ? hit.nick : null;
}
if (!KEY) { console.error('ANTHROPIC_API_KEY saknas i .env'); process.exit(1); }
if (!MATCH_ID) { console.error('Ange ett match-id: node analyze-match.js <match_id> [--tts]'); process.exit(1); }

// Items värda att nämna om de dyker upp i purchase_log
const NOTABLE_ITEMS = ['rapier','hand_of_midas','black_king_bar','ultimate_scepter','aghanims_shard',
  'refresher','gem','blink','divine_rapier','radiance','heart','satanic','swift_blink','overwhelming_blink',
  'arcane_blink','bloodstone','octarine_core','sheepstick','abyssal_blade','moon_shard','travel_boots_2'];

(async () => {
  const heroes = {};
  const hRes = await fetch('https://api.opendota.com/api/heroes');
  if (hRes.ok) (await hRes.json()).forEach(h => { heroes[h.id] = h.localized_name; });

  console.log('Hämtar match ' + MATCH_ID + '…');
  const res = await fetch('https://api.opendota.com/api/matches/' + MATCH_ID);
  if (!res.ok) { console.error('OpenDota ' + res.status); process.exit(1); }
  const m = await res.json();
  if (!m.match_id) { console.error('Tomt svar — kontrollera match-id:t.'); process.exit(1); }

  const heroName = id => heroes[id] || ('hero_' + id);
  const min = t => Math.floor(t / 60);

  // ── Brett datapaket: kuraterad rådata, inte färdiga slutsatser ──
  const players = (m.players || []).map(p => {
    const purchases = (p.purchase_log || [])
      .filter(x => NOTABLE_ITEMS.includes(x.key))
      .map(x => x.key + '@min' + min(x.time));
    const nick = dhsNick(p.personaname);
    return {
      team: p.isRadiant ? 'Radiant' : 'Dire',
      name: nick || undefined,
      is_dhs: nick ? true : undefined,
      hero: heroName(p.hero_id),
      lane_role: p.lane_role,
      kda: p.kills + '/' + p.deaths + '/' + p.assists,
      gpm: p.gold_per_min, xpm: p.xp_per_min,
      net_worth: p.net_worth,
      last_hits: p.last_hits, denies: p.denies,
      hero_damage: p.hero_damage, tower_damage: p.tower_damage, hero_healing: p.hero_healing,
      obs_placed: p.obs_placed, sen_placed: p.sen_placed,
      stuns_seconds: p.stuns != null ? Math.round(p.stuns) : null,
      teamfight_participation: p.teamfight_participation != null ? Math.round(p.teamfight_participation * 100) + '%' : null,
      buybacks: (p.buyback_log || []).map(b => 'min' + min(b.time)),
      notable_purchases: purchases,
      max_hero_hit: p.max_hero_hit ? { value: p.max_hero_hit.value, with: p.max_hero_hit.inflictor } : null,
      first_kills: (p.kills_log || []).slice(0, 3).map(k => heroName(parseInt((k.key||'').replace(/\D/g,''),10)) !== 'hero_NaN' ? min(k.time) + 'min' : min(k.time) + 'min')
    };
  });

  const teamfights = (m.teamfights || [])
    .map(tf => ({ at_minute: min(tf.start), deaths: tf.deaths }))
    .sort((a, b) => b.deaths - a.deaths)
    .slice(0, 4);

  const roshans = (m.objectives || []).filter(o => o.type === 'CHAT_MESSAGE_ROSHAN_KILL').map(o => 'min' + min(o.time));

  const radDhs = players.filter(p => p.is_dhs && p.team === 'Radiant').length;
  const direDhs = players.filter(p => p.is_dhs && p.team === 'Dire').length;
  const dhsTeam = radDhs > direDhs ? 'Radiant' : (direDhs > radDhs ? 'Dire' : null);

  const summary = {
    dhs_team: dhsTeam,
    duration_minutes: min(m.duration),
    winner: m.radiant_win ? 'Radiant' : 'Dire',
    score: 'Radiant ' + m.radiant_score + ' — ' + m.dire_score + ' Dire',
    radiant_gold_advantage_per_minute: m.radiant_gold_adv || null,
    biggest_teamfights: teamfights,
    roshan_kills: roshans,
    players: players
  };

  // ── Anti-repetition: tidigare vinklar in i prompten ──
  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch(e) {}
  const recentAngles = history.slice(-4).flatMap(h => h.angles || []);

  const prompt = 'You are writing the post-match segment for an esports broadcast at a private Dota 2 LAN (Dreamhack Skyrup). '
    + 'Three voices on the panel: HOST (curious, guides the conversation, asks real questions, occasionally challenges), '
    + 'ANALYST1 (female, the strategic mind: big picture, momentum, macro decisions, what the teams were TRYING to do) and '
    + 'ANALYST2 (male, the numbers guy: stats, item timings, minute marks, gold curves — grounds every claim in data). '
    + 'The analysts have different perspectives and are allowed to DISAGREE and push back on each other; the host mediates '
    + 'and stirs the pot. Make it feel like a real panel, not people taking turns.'
    + '\n\nStudy the match data and find what is GENUINELY remarkable about THIS match. Let the data decide the story — '
    + 'the gold advantage curve shows how the game actually swung, minute by minute. Do not force any particular statistic '
    + 'into the conversation; pick the 2-3 threads that matter most in this specific game.'
    + '\n\nIDENTITY RULES: Players with a "name" field are OUR crew (Dreamhack Skyrup regulars) — always refer to them '
    + 'by that nickname (their hero can be mentioned alongside). Players WITHOUT a name are opponents — refer to them '
    + 'ONLY by hero name, never invent names for them. The "dhs_team" field tells you which side is ours; the recap is '
    + 'for OUR crowd, so our team is the emotional center of the story regardless of who won.'
    + '\n\nPERSONAL COLOR: Where the data genuinely earns it, drop a natural personal remark about one of our players '
    + '(a nod, a tease, a hats-off) — one or two per recap, woven into the analysis. NEVER walk through the roster '
    + 'player by player; most of our players should go unmentioned in any given recap. Opponents get individual '
    + 'attention only when something is truly exceptional — most recaps should barely mention them as individuals.'
    + (recentAngles.length ? '\n\nANGLES ALREADY USED in recent recaps tonight (find DIFFERENT threads): ' + recentAngles.join('; ') : '')
    + '\n\nFormat: 10-14 dialogue lines. HOST opens with a short scene-setting line and closes the segment. '
    + 'Both analysts must speak multiple times, and at least once react directly to what the OTHER analyst just said. '
    + 'Written to be SPOKEN: short sentences, ellipses for pauses, at most one CAPS-emphasized word per line. English.'
    + '\n\nMATCH DATA:\n' + JSON.stringify(summary)
    + '\n\nReply ONLY with JSON, no markdown: {"dialogue":[{"speaker":"host"|"analyst1"|"analyst2","text":"..."}],"angles":["2-4 word label per main thread you chose"]}';

  console.log('Fable skriver eftersnacket…\n');
  let recap = null;
  for (let attempt = 1; attempt <= 2 && !recap; attempt++) {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-fable-5', max_tokens: 6000, messages: [{ role: 'user', content: prompt }] })
    });
    if (!aiRes.ok) { console.error('Anthropic ' + aiRes.status + ': ' + await aiRes.text()); process.exit(1); }
    const data = await aiRes.json();
    const text = (data.content || []).map(c => c.text || '').join('').replace(/```json|```/g, '').trim();
    try {
      recap = JSON.parse(text);
    } catch(e) {
      console.error('Försök ' + attempt + ': kunde inte tolka svaret (stop_reason: ' + data.stop_reason + ', textlängd: ' + text.length + ')' + (attempt < 2 ? ' — försöker igen…' : ''));
      if (attempt === 2) { console.error('\nRåtext:\n' + text.slice(0, 500)); process.exit(1); }
    }
  }

  console.log('══════ EFTERSNACK — MATCH ' + MATCH_ID + ' ══════\n');
  const LABELS = { host: '🎙 HOST:      ', analyst1: '📈 ANALYST 1: ', analyst2: '📊 ANALYST 2: ' };
  recap.dialogue.forEach(d => {
    console.log((LABELS[d.speaker] || d.speaker + ': ') + d.text + '\n');
  });
  console.log('Vinklar: ' + (recap.angles || []).join(', '));
  console.log('═══════════════════════════════════════════');

  // Spara vinklarna för anti-repetition
  history.push({ match_id: MATCH_ID, angles: recap.angles || [], at: new Date().toISOString() });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-10), null, 2));

  if (DO_TTS) {
    const elKey = process.env.ELEVENLABS_API_KEY;
    let voices = {};
    try { voices = JSON.parse(fs.readFileSync(path.join(__dirname, 'bank-config.json'), 'utf8')).voices || {}; } catch(e) {}
    // Fallback till kända ID:n om bank-config saknar dem (röst-ID:n är ofarliga identifierare)
    if (!voices.host) voices.host = 'XAYhxwN5SJaMioCWTDBq';
    if (!voices.analytic2) voices.analytic2 = 'T7JgacQ8vdcmJYfOsKeH';
    if (!elKey || !voices.host || !voices.analytic || !voices.analytic2) {
      console.error('\n--tts kräver ELEVENLABS_API_KEY i .env samt host-, analytic- och analytic2-röster i bank-config.json');
      process.exit(1);
    }
    const VOICE_MAP = { host: voices.host, analyst1: voices.analytic, analyst2: voices.analytic2 };
    const SETTINGS_MAP = {
      host:     { stability: 0.45, similarity_boost: 0.8, style: 0.5 },
      analyst1: { stability: 0.5,  similarity_boost: 0.8, style: 0.4 },
      analyst2: { stability: 0.5,  similarity_boost: 0.8, style: 0.45 }
    };
    console.log('\nGenererar dialogen, ' + recap.dialogue.length + ' repliker…');
    const parts = [];
    for (const d of recap.dialogue) {
      const voiceId = VOICE_MAP[d.speaker] || voices.analytic;
      const settings = SETTINGS_MAP[d.speaker] || SETTINGS_MAP.analyst1;
      const tRes = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voiceId, {
        method: 'POST',
        headers: { 'xi-api-key': elKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: d.text, model_id: 'eleven_multilingual_v2', voice_settings: settings })
      });
      if (!tRes.ok) { console.error('ElevenLabs ' + tRes.status + ': ' + await tRes.text()); process.exit(1); }
      parts.push(Buffer.from(await tRes.arrayBuffer()));
      process.stdout.write('  ✓ ' + d.speaker + '\n');
      await new Promise(r => setTimeout(r, 800));
    }
    const file = path.join(__dirname, 'recap_' + MATCH_ID + '.mp3');
    fs.writeFileSync(file, Buffer.concat(parts));
    console.log('Sparad: ' + file + ' — dubbelklicka och lyssna på sändningen!');
  }
})();
