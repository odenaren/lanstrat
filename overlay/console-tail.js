// overlay/console-tail.js — tailar Dota 2:s console.log (finns bara om spelaren
// har -condebug i Steams launch options for Dota). Tva saker lases ut:
//
//  1. "LOBBY STATE RUN: ... Player AccountID N connecting to MatchID M ..."
//     — matchid i klartext REDAN vid anslutning till matchservern (fore
//     HERO_SELECTION). Rapporteras till servern som verifiering/fallback
//     for GSI:s map.matchid i pub-strategiflodet.
//
//  2. "Loading Game State Integration: gamestate_integration_dhs.cfg"
//     — beviset pa att spelarens GSI-config faktiskt laddas av Dota.
//     Saknas raden nar en match startat varnas spelaren lokalt i overlayn
//     (vanligaste felet: cfg-filen ligger i fel mapp).
//
// Ren Node (ingen Electron) sa modulen kan testas fristaende.
const fs = require('fs');
const { execSync } = require('child_process');

const CONSOLE_LOG_REL = '\\steamapps\\common\\dota 2 beta\\game\\dota\\console.log';

// Hittar console.log via Steams registernyckel + libraryfolders.vdf (Dota kan
// ligga i ett annat Steam-bibliotek an huvudinstallationen).
function findDotaConsoleLog() {
  try {
    const out = execSync('reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath', { encoding: 'utf8' });
    const m = out.match(/REG_SZ\s+(.+)/);
    if (!m) return null;
    const steamPath = m[1].trim().replace(/\//g, '\\');
    const candidates = [steamPath + CONSOLE_LOG_REL];
    try {
      const vdf = fs.readFileSync(steamPath + '\\steamapps\\libraryfolders.vdf', 'utf8');
      const re = /"path"\s+"([^"]+)"/g;
      let mm;
      while ((mm = re.exec(vdf))) candidates.push(mm[1].replace(/\\\\/g, '\\') + CONSOLE_LOG_REL);
    } catch (e) {}
    return candidates.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } }) || null;
  } catch (e) {
    return null; // Steam inte installerat / registret otillgangligt
  }
}

// Skapar en tailer. emit anropas med:
//   { type: 'match-connect', logAccountId, matchId }  — ny match sedd i loggen
//   { type: 'gsi-missing' }                           — match startad men dhs-cfg:en laddades aldrig
// opts.path kan overrida sokvagen (tester); opts.warnDelayMs/gsiFreshMs styr
// GSI-varningens timing (default 60s vantan, 3 min farskhetskrav).
function createConsoleTail(emit, opts) {
  opts = opts || {};
  const warnDelayMs = opts.warnDelayMs != null ? opts.warnDelayMs : 60000;
  const gsiFreshMs = opts.gsiFreshMs != null ? opts.gsiFreshMs : 3 * 60 * 1000;
  let logPath = opts.path || null;
  let offset = -1; // -1 = annu inte initierad (borja vid EOF, gamla rader ar inaktuella)
  let gsiCfgSeenAt = 0;
  let lastMatchId = null;
  let warnTimer = null;

  function poll() {
    if (!logPath) {
      logPath = findDotaConsoleLog();
      if (!logPath) return; // Dota saknas eller -condebug inte satt — forsok igen nasta varv
    }
    let st;
    try { st = fs.statSync(logPath); } catch (e) { return; }
    if (offset === -1) { offset = st.size; return; } // forsta varvet: stall oss vid EOF
    if (st.size < offset) offset = 0; // filen trunkerad (ny Dota-start)
    if (st.size === offset) return;
    const start = Math.max(offset, st.size - 512 * 1024); // max 512KB per varv
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    let fd;
    try {
      fd = fs.openSync(logPath, 'r');
      fs.readSync(fd, buf, 0, len, start);
    } catch (e) {
      return;
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch (e2) {} }
    }
    offset = st.size;
    const text = buf.toString('utf8');

    if (text.indexOf('Loading Game State Integration: gamestate_integration_dhs.cfg') !== -1) {
      gsiCfgSeenAt = Date.now();
    }

    // Ta sista matchid-raden i chunken (spelaren kan ha lamnat/omkoat)
    const re = /Player AccountID (\d+) connecting to MatchID (\d+)/g;
    let m, last = null;
    while ((m = re.exec(text))) last = m;
    if (last && last[2] !== lastMatchId) {
      lastMatchId = last[2];
      emit({ type: 'match-connect', logAccountId: last[1], matchId: last[2] });
      // GSI-cfg-raderna skrivs nar kartan laddar, nagra sekunder efter
      // LOBBY STATE RUN — vanta darfor innan vi bedomer att cfg:en saknas.
      clearTimeout(warnTimer);
      warnTimer = setTimeout(function () {
        if (Date.now() - gsiCfgSeenAt > gsiFreshMs) emit({ type: 'gsi-missing' });
      }, warnDelayMs);
      if (warnTimer.unref) warnTimer.unref();
    }
  }

  return { poll };
}

module.exports = { findDotaConsoleLog, createConsoleTail };
