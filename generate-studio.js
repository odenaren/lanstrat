// generate-studio.js — genererar STUDIOANALYS per lankad match: trerosts-panel
// (host + tva analytiker) som strukturerade segment med mp3 per replik.
//
// Skillnad mot analyze-match.js (som lamnas orord):
//   * Hamtar aven STRATEGIN fran matches-binen — panelen kanner till planen
//     (arketyp, briefing, draft) och kan jamfora mot verkligheten
//   * Varje replik taggas med vilka DHS-spelare som namns ("mentions")
//     sa TV:n kan lyfta fram deras statistik nar de omtalas
//   * Output: en JSONBin-bin PER REPLIK (bara ljudet) plus en liten
//     manifest-bin per match (text + varje repliks binId). Manifestets
//     bin-id sparas som studioBinId pa matchen i matches-binen. Detta
//     istallet for disk, eftersom Railways filsystem ar efemart vid deploy.
//     En delad bin for hela matchens ljud funkar INTE - JSONBins nginx-proxy
//     stoppar requests over 1MiB (413), langt under vad en hel matchs ljud vager.
//     (spelas av Playbook-detaljvyn och /tv via /studio/:odId/... pa servern)
//
// Anvandning:
//   node generate-studio.js                 <- alla lankade matcher utan studio
//   node generate-studio.js <odMatchId>...  <- specifika matcher
//   node generate-studio.js --force ...     <- generera om aven om studio finns
//
// Kraver i .env: ANTHROPIC_API_KEY, ELEVENLABS_API_KEY, JSONBIN_API_KEY
// samt DEV_HISTORY_BIN_ID (eller bin-id som forsta argument fore match-id:n)

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
const EL_KEY = process.env.ELEVENLABS_API_KEY;
const BIN_KEY = process.env.JSONBIN_API_KEY;
const HISTORY_FILE = path.join(__dirname, 'recap-history.json');
const MAX_BIN_BYTES = 900 * 1024; // 900KB — marginal under JSONBins verifierade 1MiB-tak per request

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const positional = args.filter(a => a !== '--force');
const BIN_ID = process.env.DEV_HISTORY_BIN_ID || positional.shift();
const ONLY_MATCHES = positional; // tomt = alla lankade

if (!KEY || !EL_KEY) { console.error('ANTHROPIC_API_KEY och ELEVENLABS_API_KEY kravs i .env'); process.exit(1); }
if (!BIN_ID) { console.error('Ange bin-id: DEV_HISTORY_BIN_ID i .env eller som forsta argument'); process.exit(1); }

let voices = {};
try { voices = JSON.parse(fs.readFileSync(path.join(__dirname, 'bank-config.json'), 'utf8')).voices || {}; } catch(e) {}
if (!voices.host) voices.host = 'XAYhxwN5SJaMioCWTDBq';
if (!voices.analytic2) voices.analytic2 = 'T7JgacQ8vdcmJYfOsKeH';
if (!voices.analytic) { console.error('analytic-rost saknas i bank-config.json'); process.exit(1); }
const VOICE_MAP = { host: voices.host, analyst1: voices.analytic, analyst2: voices.analytic2 };
const SETTINGS_MAP = {
  host:     { stability: 0.45, similarity_boost: 0.8, style: 0.5 },
  analyst1: { stability: 0.5,  similarity_boost: 0.8, style: 0.4 },
  analyst2: { stability: 0.5,  similarity_boost: 0.8, style: 0.45 }
};

const NOTABLE_ITEMS = ['rapier','hand_of_midas','black_king_bar','ultimate_scepter','aghanims_shard',
  'refresher','gem','blink','divine_rapier','radiance','heart','satanic','swift_blink','overwhelming_blink',
  'arcane_blink','bloodstone','octarine_core','sheepstick','abyssal_blade','moon_shard','travel_boots_2'];

const ARCHETYPE_LABELS = {
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

async function fetchBinMatches() {
  const res = await fetch('https://api.jsonbin.io/v3/b/' + BIN_ID + '/latest', {
    headers: { 'X-Access-Key': BIN_KEY }  // OBS: Access Key-header, inte Master (samma som servern)
  });
  if (!res.ok) throw new Error('JSONBin ' + res.status);
  const json = await res.json();
  const rec = json.record;
  return Array.isArray(rec) ? rec : (rec && rec.data) || [];
}

// Skriver hela matchlistan tillbaka (anvands efter att studioBinId satts pa en match)
async function writeBinMatches(matches) {
  const res = await fetch('https://api.jsonbin.io/v3/b/' + BIN_ID, {
    method: 'PUT',
    headers: { 'X-Access-Key': BIN_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(matches)
  });
  if (!res.ok) throw new Error('JSONBin skriv ' + res.status);
}

async function createStudioBin(payload) {
  const res = await fetch('https://api.jsonbin.io/v3/b', {
    method: 'POST',
    headers: { 'X-Access-Key': BIN_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('JSONBin skapa studio-bin ' + res.status);
  const json = await res.json();
  return json.metadata.id;
}

async function setStudioBinData(binId, payload) {
  const res = await fetch('https://api.jsonbin.io/v3/b/' + binId, {
    method: 'PUT',
    headers: { 'X-Access-Key': BIN_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('JSONBin uppdatera studio-bin ' + res.status);
}

function checkStudioBinSize(payload, label) {
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (bytes > MAX_BIN_BYTES) throw new Error(label + ' blev ' + Math.round(bytes / 1024) + 'KB — for stort for en JSONBin-bin (max ~900KB)');
}

function normHero(n){ return String(n||'').toLowerCase().replace(/[^a-z]/g,''); }

// ── SASONGSKONTEXT (storylines over sasongen) ────────────────────────────────
// Deterministiska fakta ur matchhistoriken (bara matches-binen, inga extra
// OpenDota-anrop): lagets och spelarnas sviter, hjaltupprepningar, arketypfacit,
// aterkommande fiendehjaltar och lagkamratpar. Koden raknar — AI:n far bara
// formulera (projektregel: hitta aldrig pa data). Pubmatcher (mode:'pub') och
// excludeFromMemory-matcher raknas inte in i sasongen.
// OBS: identisk kopia finns i server.js — hall dem synkade.
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

async function generateForMatch(strategyMatch, heroes, allMatches) {
  const odId = strategyMatch.openDotaMatchId;
  if (strategyMatch.studioBinId && !FORCE) {
    console.log('  ↷ ' + odId + ' — studio finns redan, hoppar over (kor med --force for att gora om)');
    return;
  }

  console.log('\n══ ' + odId + '  "' + (strategyMatch.name||'') + '" ══');
  const res = await fetch('https://api.opendota.com/api/matches/' + odId);
  if (!res.ok) { console.error('  OpenDota ' + res.status + ' — hoppar over'); return; }
  const m = await res.json();

  const heroName = id => heroes[id] || ('hero_' + id);
  const min = t => Math.floor(t / 60);
  const weAreRadiant = (strategyMatch.matchResult === 'win') === !!m.radiant_win;
  const draft = strategyMatch.currentDraft || strategyMatch.draft || {};

  // Koppla alias -> OpenDota-rad via hjaltenamn (samma logik som statssidan)
  const aliasByHero = {};
  Object.keys(draft).forEach(alias => { aliasByHero[normHero(draft[alias])] = alias; });

  const players = (m.players || []).map(p => {
    const isOurSide = (p.player_slot < 128) === weAreRadiant;
    const nick = isOurSide ? aliasByHero[normHero(heroName(p.hero_id))] : null;
    const purchases = (p.purchase_log || []).filter(x => NOTABLE_ITEMS.includes(x.key)).map(x => x.key + '@min' + min(x.time));
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

  // Utmaningsutfall — verifieras mot matchdatan och ges till panelen (samma logik som server.js)
  let challengeResults = null;
  if (Array.isArray(strategyMatch.challenges) && strategyMatch.challenges.length) {
    const odRowByAlias = {};
    (m.players || []).forEach(p => {
      if ((p.player_slot < 128) !== weAreRadiant) return;
      const nick = aliasByHero[normHero(heroName(p.hero_id))];
      if (nick) odRowByAlias[nick] = p;
    });
    // Utmaningstyper (speglar server.js): item_timing (minut till kop), timeline (array@minut),
    // decimal (kda), samt harledda dewards/teamfight_participation. Halls synkat med evalChallenge.
    const CH_TIMELINE = { lh_t: 1, gold_t: 1, xp_t: 1, dn_t: 1 };
    const CH_FLOAT = { kda: 1 };
    const chActual = (ch, r) => {
      if (ch.metric === 'item_timing') { const t = (r.first_purchase_time || {})[ch.item]; return (typeof t === 'number') ? t / 60 : Infinity; }
      if (CH_TIMELINE[ch.metric]) { const a = r[ch.metric]; if (!Array.isArray(a) || !a.length) return 0; return a[Math.max(0, Math.min(ch.at || 0, a.length - 1))] || 0; }
      if (ch.metric === 'dewards') return (r.observer_kills || 0) + (r.sentry_kills || 0);
      if (ch.metric === 'teamfight_participation') return (r.teamfight_participation || 0) * 100;
      return r[ch.metric] || 0;
    };
    challengeResults = strategyMatch.challenges.map(ch => {
      const row = odRowByAlias[ch.alias];
      if (!row) return { alias: ch.alias, challenge: ch.text, result: 'unknown — player not found in match data' };
      // Tre trosklar (niva 1-3, latt->svar); aldre matcher har bara ett `value` som fallback
      const levels = (Array.isArray(ch.levels) && ch.levels.length && ch.levels.every(n => typeof n === 'number')) ? ch.levels : (typeof ch.value === 'number' ? [ch.value] : []);
      const raw = chActual(ch, row);
      const decimal = CH_FLOAT[ch.metric] || ch.metric === 'item_timing';
      const actual = decimal ? (isFinite(raw) ? Math.round(raw * 10) / 10 : raw) : Math.round(raw);
      let level = 0;
      for (let i = 0; i < levels.length; i++) {
        const ok = ch.op === '<=' ? actual <= levels[i] : actual >= levels[i];
        if (ok) level = i + 1;
      }
      let target;
      if (ch.metric === 'item_timing') target = (ch.item || 'item') + ' innan ' + levels.map(v => v + 'm').join(' / ');
      else if (CH_TIMELINE[ch.metric]) target = levels.map((v, i) => 'L' + (i + 1) + ' ' + ch.op + v).join(' / ') + ' ' + ch.metric + '@min' + ch.at;
      else target = levels.length ? levels.map((v, i) => 'L' + (i + 1) + ' ' + ch.op + v).join(' / ') + ' ' + ch.metric : (ch.op + ' ' + ch.value + ' ' + ch.metric);
      const actualOut = isFinite(actual) ? actual : 'kopte aldrig';
      return { alias: ch.alias, challenge: ch.text, target, actual: actualOut, passed: level >= 1, achieved_level: level, max_level: levels.length };
    });
  }

  const summary = {
    dhs_team: weAreRadiant ? 'Radiant' : 'Dire',
    dhs_result: strategyMatch.matchResult,
    duration_minutes: min(m.duration),
    winner: m.radiant_win ? 'Radiant' : 'Dire',
    score: 'Radiant ' + m.radiant_score + ' — ' + m.dire_score + ' Dire',
    radiant_gold_advantage_per_minute: m.radiant_gold_adv || null,
    biggest_teamfights: teamfights,
    roshan_kills: roshans,
    personal_challenges: challengeResults,
    players: players
  };

  // Strategikontexten — det som gor DHS-studion unik
  const strategyContext = {
    strategy_name: strategyMatch.name || null,
    archetype: strategyMatch.archetype ? (ARCHETYPE_LABELS[strategyMatch.archetype] || strategyMatch.archetype) : null,
    wildcard: !!strategyMatch.wildcard,
    briefing_excerpt: (strategyMatch.briefingEn || strategyMatch.briefing || '').slice(0, 600) || null,
    planned_draft: draft,
    captain_notes: strategyMatch.captainNotes || null
  };

  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch(e) {}
  const recentAngles = history.slice(-4).flatMap(h => h.angles || []);

  // Sasongskontext for storylines — deterministiskt beraknad ur matchhistoriken
  let seasonContext = null;
  try { seasonContext = buildSeasonContext(allMatches, strategyMatch, ARCHETYPE_LABELS); }
  catch (e) { console.error('  SeasonContext: ' + e.message); }

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

  console.log('  Fable skriver studiosegmentet…');
  let recap = null;
  for (let attempt = 1; attempt <= 2 && !recap; attempt++) {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-fable-5', max_tokens: 6000, messages: [{ role: 'user', content: prompt }] })
    });
    if (!aiRes.ok) { console.error('  Anthropic ' + aiRes.status + ': ' + (await aiRes.text()).slice(0,200)); return; }
    const data = await aiRes.json();
    const text = (data.content || []).map(c => c.text || '').join('').replace(/```json|```/g, '').trim();
    try { recap = JSON.parse(text); }
    catch(e) { if (attempt === 2) { console.error('  Kunde inte tolka svaret. Borjan: ' + text.slice(0,200)); return; } }
  }
  if (!Array.isArray(recap.dialogue) || !recap.dialogue.length) { console.error('  Tomt dialogue-falt — hoppar over.'); return; }

  // Sanera mentions: bara alias som faktiskt finns i draften
  const validAliases = new Set(Object.keys(draft));
  recap.dialogue.forEach(d => {
    d.mentions = (d.mentions || []).filter(x => validAliases.has(x));
  });

  console.log('  "' + (recap.headline || '') + '" — ' + recap.dialogue.length + ' repliker. Genererar roster…');

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
    if (!tRes.ok) { console.error('  ElevenLabs ' + tRes.status + ' pa replik ' + i + ' — avbryter denna match.'); return; }
    const audioBase64 = Buffer.from(await tRes.arrayBuffer()).toString('base64');
    await new Promise(r => setTimeout(r, 800));

    // Varje replik far sin egen bin - en delad bin for hela matchen blir for
    // stor for JSONBins 1MiB-request-tak.
    const segmentPayload = { audioBase64 };
    checkStudioBinSize(segmentPayload, 'Replik ' + i + ' (' + d.speaker + ')');
    const segmentBinId = await createStudioBin(segmentPayload);

    process.stdout.write('    ✓ ' + (i+1) + '/' + recap.dialogue.length + ' ' + d.speaker + (d.mentions.length ? '  [' + d.mentions.join(', ') + ']' : '') + '\n');
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

  const manifestPayload = { manifest };
  checkStudioBinSize(manifestPayload, 'Manifestet');

  let binId = strategyMatch.studioBinId;
  if (binId) await setStudioBinData(binId, manifestPayload);
  else binId = await createStudioBin(manifestPayload);
  strategyMatch.studioBinId = binId;
  await writeBinMatches(allMatches);

  history.push({ match_id: String(odId), angles: recap.angles || [], at: new Date().toISOString() });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-10), null, 2));
  console.log('  ✔ Sparad i JSONBin-bin ' + binId + ' (' + segments.length + ' segment)');
}

(async () => {
  const heroes = {};
  const hRes = await fetch('https://api.opendota.com/api/heroes');
  if (hRes.ok) (await hRes.json()).forEach(h => { heroes[h.id] = h.localized_name; });

  console.log('Hamtar strategier fran bin ' + BIN_ID + ' …');
  const all = await fetchBinMatches();
  let targets = all.filter(m => m.openDotaMatchId);
  if (ONLY_MATCHES.length) targets = targets.filter(m => ONLY_MATCHES.includes(String(m.openDotaMatchId)));
  console.log(targets.length + ' lankade matcher att behandla.');

  for (const t of targets) {
    try { await generateForMatch(t, heroes, all); }
    catch(e) { console.error('  Fel pa ' + t.openDotaMatchId + ': ' + e.message); }
  }
  console.log('\nKlart. Ljudet ligger i JSONBin och overlever Railway-deploys — inget att committa.');
})();
