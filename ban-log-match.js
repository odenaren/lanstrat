// ban-log-match.js — laser Dota 2:s ban-logg ("X has been Banned.") fran en
// screenshot av chatt/logg-panelen i All Pick-draften, via OCR (tesseract.js,
// ren JS/WASM — inget systembinart tesseract-beroende, funkar pa Railways
// Nixpacks-build precis som pngjs gor for topbar-match.js).
//
// Varfor OCR pa loggtext istallet for template matching mot grid-ikoner (som
// topbar-match.js gor for hjaltval): panelen skriver ut hjaltnamn som REN
// TEXT, vilket ar mycket mer robust an att mata gra/overstrukna hjaltikoner
// i en 117-hjalte-grid. Verifierat 2026-07-17 mot fyra riktiga screenshots
// (se TODO.md) — OCR + fuzzy-matchning mot riktiga hjaltnamn las av 8-9 av 9
// bannade hjaltar korrekt per screenshot, inklusive "Largo" (ny hjalte,
// bekraftad mot OpenDotas hjaltlista, inte en OCR-felläsning).
//
// Loggen ar en SKROLLANDE panel — en enskild avlasning kan klippa av precis
// den understa/oversta raden mitt i tecknen (verifierat: forsta raden i ett
// av testfallen las som "Legion _ommander nas been Banned" och missade
// matchningen). Det ar darfor anroparen (server.js) ackumulerar nya namn
// over flera periodiska avlasningar via samma monster som gsiSeenUnavailable
// — en rad som klipps i en avlasning fangas typiskt upp korrekt i nasta.

const { PNG } = require('pngjs');
const Tesseract = require('tesseract.js');

const BAN_LINE_RE = /^(.+?) has been Banned\.?$/i;
const FUZZY_MIN_RATIO = 0.6;
const UPSCALE = 3; // tomt testat: hoger traffsakerhet an att kora OCR pa originalstorleken

let heroNamesPromise = null;
async function fetchHeroNames() {
  if (!heroNamesPromise) {
    heroNamesPromise = (async () => {
      const res = await fetch('https://api.opendota.com/api/heroes');
      if (!res.ok) throw new Error('OpenDota heroes: ' + res.status);
      const data = await res.json();
      return data.map(h => h.localized_name);
    })().catch(e => { heroNamesPromise = null; throw e; });
  }
  return heroNamesPromise;
}

// Levenshtein-baserad likhet (0-1) — racker for att rensa OCR-brus i namn.
function similarity(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return 1 - dp[n] / Math.max(m, n);
}

function bestHeroMatch(candidate, heroNames) {
  let best = null, bestScore = 0;
  for (const name of heroNames) {
    const s = similarity(candidate, name);
    if (s > bestScore) { bestScore = s; best = name; }
  }
  return bestScore >= FUZZY_MIN_RATIO ? best : null;
}

// Skalar upp 3x + gor gratone — samma forbehandling som verifierades ge
// paverkbart battre OCR-traffsakerhet an raw storlek (se testresultat i TODO).
function upscaleGray(png, scale) {
  const w = png.width * scale, h = png.height * scale;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    const sy = Math.min(png.height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(png.width - 1, Math.floor(x / scale));
      const si = (sy * png.width + sx) * 4;
      const di = (y * w + x) * 4;
      const gray = Math.round(0.299 * png.data[si] + 0.587 * png.data[si + 1] + 0.114 * png.data[si + 2]);
      out.data[di] = gray; out.data[di + 1] = gray; out.data[di + 2] = gray; out.data[di + 3] = 255;
    }
  }
  return out;
}

// pngBuffer: overlayn skickar BARA ban-logg-panelen, aldrig hela skarmen
// (se overlay/main.js) — inget mer att beskara har.
async function readBannedHeroes(pngBuffer) {
  const heroNames = await fetchHeroNames();
  const png = PNG.sync.read(pngBuffer);
  const scaled = PNG.sync.write(upscaleGray(png, UPSCALE));
  const { data: { text } } = await Tesseract.recognize(scaled, 'eng');

  const bans = [];
  text.split('\n').forEach(line => {
    const m = line.trim().match(BAN_LINE_RE);
    if (!m) return;
    const hero = bestHeroMatch(m[1].trim(), heroNames);
    if (hero && !bans.includes(hero)) bans.push(hero);
  });
  return bans;
}

module.exports = { readBannedHeroes };
