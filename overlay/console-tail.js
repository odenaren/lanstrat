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
//     OBS (verifierat mot riktig logg 2026-08-12): Dota loggar raden BARA EN
//     GANG per klientsession, vid forsta matchens map-load — inte per match.
//     Beviset galler darfor hela sessionen och nollstalls forst nar loggen
//     trunkeras (= Dota startats om). Tidigare kravdes att raden var hogst
//     3 min gammal, vilket gav falsk varning pa varje match efter den forsta.
//
// Ren Node (ingen Electron) sa modulen kan testas fristaende.
const fs = require('fs');
const { execSync } = require('child_process');

const CONSOLE_LOG_REL = '\\steamapps\\common\\dota 2 beta\\game\\dota\\console.log';
const GSI_CFG_LINE = 'Loading Game State Integration: gamestate_integration_dhs.cfg';
const MAX_CHUNK = 512 * 1024;

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
// opts.path kan overrida sokvagen (tester); opts.warnDelayMs styr hur lange vi
// vantar efter matchanslutning innan GSI-varningen bedoms (default 60s).
function createConsoleTail(emit, opts) {
  opts = opts || {};
  const warnDelayMs = opts.warnDelayMs != null ? opts.warnDelayMs : 60000;
  let logPath = opts.path || null;
  let offset = -1; // -1 = annu inte initierad (borja vid EOF, gamla rader ar inaktuella)
  let gsiCfgSeen = false; // galler hela Dota-sessionen, nollstalls vid trunkering
  let lastMatchId = null;
  let warnTimer = null;

  // Laser [start, start+len) ur loggen. Tom strang vid lasfel.
  function readChunk(start, len) {
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    let fd;
    try {
      fd = fs.openSync(logPath, 'r');
      fs.readSync(fd, buf, 0, len, start);
    } catch (e) {
      return '';
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch (e2) {} }
    }
    return buf.toString('utf8');
  }

  function poll() {
    if (!logPath) {
      logPath = findDotaConsoleLog();
      if (!logPath) return; // Dota saknas eller -condebug inte satt — forsok igen nasta varv
    }
    let st;
    try { st = fs.statSync(logPath); } catch (e) { return; }
    if (offset === -1) {
      // Forsta varvet: stall oss vid EOF (gamla matchid-rader ar inaktuella) —
      // men cfg-raden kan redan ha loggats innan overlayn startade, sa skanna
      // det befintliga innehallet efter den forst.
      if (readChunk(Math.max(0, st.size - MAX_CHUNK), Math.min(st.size, MAX_CHUNK)).indexOf(GSI_CFG_LINE) !== -1) gsiCfgSeen = true;
      offset = st.size;
      return;
    }
    if (st.size < offset) { offset = 0; gsiCfgSeen = false; } // filen trunkerad (ny Dota-start) — nytt cfg-bevis kravs
    if (st.size === offset) return;
    const start = Math.max(offset, st.size - MAX_CHUNK); // max 512KB per varv
    const text = readChunk(start, st.size - start);
    if (!text) return; // lasfel — forsok igen nasta varv
    offset = st.size;

    if (text.indexOf(GSI_CFG_LINE) !== -1) gsiCfgSeen = true;

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
        if (!gsiCfgSeen) emit({ type: 'gsi-missing' });
      }, warnDelayMs);
      if (warnTimer.unref) warnTimer.unref();
    }
  }

  return { poll };
}

module.exports = { findDotaConsoleLog, createConsoleTail };
