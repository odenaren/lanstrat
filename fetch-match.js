// fetch-match.js — hämtar slutstatistik för valfritt publikt match-id via OpenDota
//
// Ingen API-nyckel krävs. Körning:
//   node fetch-match.js <match_id>
//
// Match-id hittas på dotabuff.com / opendota.com, eller via
// https://api.opendota.com/api/publicMatches
//
// (Valves egen GetMatchDetails-endpoint är kroniskt opålitlig — 500-fel och
// tomma svar är dokumenterade återkommande problem — så OpenDota är primär källa.)

const MATCH_ID = process.argv[2];
if (!MATCH_ID) { console.error('Ange ett match-id: node fetch-match.js <match_id>'); process.exit(1); }

(async () => {
  const res = await fetch('https://api.opendota.com/api/matches/' + MATCH_ID);
  if (!res.ok) { console.error('OpenDota ' + res.status + ': ' + await res.text()); process.exit(1); }
  const m = await res.json();
  if (!m || !m.match_id) { console.error('Tomt svar — kontrollera match-id:t.'); process.exit(1); }

  const parsed = !!(m.od_data && m.od_data.has_parsed) || !!(m.players && m.players[0] && m.players[0].obs_log);
  const mins = Math.floor(m.duration / 60), secs = m.duration % 60;

  console.log('\nMATCH ' + m.match_id + (m.league ? '   [' + (m.league.name || 'liga') + ']' : ''));
  console.log('Längd: ' + mins + ':' + String(secs).padStart(2,'0') + '   Vinnare: ' + (m.radiant_win ? 'Radiant' : 'Dire') + '   Slutställning: ' + m.radiant_score + '–' + m.dire_score);
  console.log('Replay-parsad (djupdata): ' + (parsed ? 'JA — obs_log, gold_t m.m. tillgängligt' : 'NEJ — begär med POST /request/' + MATCH_ID));

  const cols = ['Hjälte','K','D','A','LH','DN','GPM','XPM','Net worth','HD','TD','Wards+','Wards-'];
  ['Radiant','Dire'].forEach((side, si) => {
    console.log('\n=== ' + side.toUpperCase() + (si===0 === m.radiant_win ? '  (VINNARE)' : '') + ' ===');
    console.log(cols.map((c,i)=>pad(c, i===0?22:i===8?10:6)).join(''));
    (m.players || []).filter(p => si===0 ? p.isRadiant : !p.isRadiant).forEach(p => {
      const row = [
        (p.hero && p.hero.localized_name) || p.hero_name_loc || ('hero_' + p.hero_id),
        p.kills, p.deaths, p.assists, p.last_hits, p.denies,
        p.gold_per_min, p.xp_per_min,
        p.net_worth != null ? p.net_worth : (p.total_gold != null ? p.total_gold : '—'),
        p.hero_damage != null ? p.hero_damage : '—',
        p.tower_damage != null ? p.tower_damage : '—',
        p.obs_placed != null ? p.obs_placed : '—',
        p.sen_placed != null ? p.sen_placed : '—'
      ];
      console.log(row.map((c,i)=>pad(String(c), i===0?22:i===8?10:6)).join(''));
    });
  });

  if (parsed) {
    const p0 = m.players[0];
    console.log('\nDJUPDATA (exempel från första spelaren):');
    if (p0.obs_log) console.log('  obs_log: ' + p0.obs_log.length + ' wards med x/y-koordinater och tidsstämplar');
    if (p0.gold_t) console.log('  gold_t: net worth-kurva, ' + p0.gold_t.length + ' minutpunkter (TV-grafens råmaterial)');
    if (m.teamfights) console.log('  teamfights: ' + m.teamfights.length + ' analyserade teamfights');
  }
  console.log('\nFält per spelare i råsvaret (för framtida design):');
  console.log(Object.keys((m.players && m.players[0]) || {}).slice(0, 40).join(', ') + ' …');
})();

function pad(s, n) { return (s + ' '.repeat(n)).slice(0, Math.max(n, s.length + 1)); }
