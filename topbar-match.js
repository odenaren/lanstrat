// topbar-match.js — identifierar hjaltarna i Dota 2:s topbar fran en screenshot,
// via template matching (normaliserad korskorrelation) mot samma CDN-hjaltbilder
// som resten av appen anvander. Ingen AI — ren deterministisk pixeljamforelse.
// Metoden verifierad 10/10 mot en riktig 1080p-screenshot 2026-07-13 (AI-vision
// pa samma bild fick 1/10 — darfor template matching).
//
// Anvands av server.js:s /api/overlay-capture: overlay-widgeten skickar en remsa
// av skarmens overkant, servern laser av FIENDESIDANS fem hjaltar och genererar
// itemtips automatiskt (GSI exponerar aldrig fiendehjaltar i All Pick).

const { PNG } = require('pngjs');

const CDN = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/';

// Lattice uppmatt pa 1919 bred 16:9-screenshot: forsta Radiant-ikonen borjar
// x=546, forsta Dire-ikonen x=1062, ikonavstand 62px. Allt skalar linjart med
// skarmbredden (16:9 antaget — ultrawide centrerar HUD:en annorlunda, ej stott).
const REF_W = 1919;
const LEFT0 = 546 / REF_W;
const RIGHT0 = 1062 / REF_W;
const SPACING = 62 / REF_W;
const ICON_W = 62 / REF_W;
const STRIP_H = 80 / REF_W; // remshojd som racker for topbaren, relativt bredden

const MIN_SCORE = 0.6;    // vinnaren maste na hit...
const MIN_MARGIN = 0.07;  // ...och vara sa har langt fore tvaan, annars ok:false
// MIN_MARGIN sankt fran 0.1 till 0.07 (2026-07-17): ursprungsvardet kalibrerades
// mot en screenshot utan lagfargad kantram/rollriband/levelbricka pa ikonerna.
// Verifierat mot en riktig live-match (Oskars skarmdump): alla 5 fiendehjaltar
// ratt identifierade, men en slot (Tidehunter, score 0.68) hade bara 0.073
// marginal mot tvaan (Io) — under 0.1-tröskeln trots korrekt svar, eftersom
// riktiga HUD-ikoner har extra dekor (kantram/riband/badge) som saknas i det
// rena CDN-referensbildet och drar ner alla scorer nagot jamfort med den
// idealiserade kalibreringsbilden.

let templatesPromise = null;

async function fetchHeroList() {
  const res = await fetch('https://api.opendota.com/api/constants/heroes');
  if (!res.ok) throw new Error('OpenDota heroes: ' + res.status);
  const data = await res.json();
  return Object.values(data).map(h => ({
    name: h.localized_name,
    slug: h.name.replace('npc_dota_hero_', '')
  }));
}

function decodePng(buffer) {
  return PNG.sync.read(buffer);
}

// Bilinjar nedskalning till bredd w (RGB, alfa ignoreras).
function resizeRgb(img, w) {
  const h = Math.max(1, Math.round(w * img.height / img.width));
  const out = new Float32Array(w * h * 3);
  const xr = img.width / w, yr = img.height / h;
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1.001, y * yr);
    const y0 = Math.floor(sy), fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1.001, x * xr);
      const x0 = Math.floor(sx), fx = sx - x0;
      for (let c = 0; c < 3; c++) {
        const p00 = img.data[(y0 * img.width + x0) * 4 + c];
        const p01 = img.data[(y0 * img.width + x0 + 1) * 4 + c];
        const p10 = img.data[((y0 + 1) * img.width + x0) * 4 + c];
        const p11 = img.data[((y0 + 1) * img.width + x0 + 1) * 4 + c];
        out[(y * w + x) * 3 + c] =
          p00 * (1 - fx) * (1 - fy) + p01 * fx * (1 - fy) + p10 * (1 - fx) * fy + p11 * fx * fy;
      }
    }
  }
  return { w, h, data: out };
}

// Forbereder en template for NCC: nollcentrerad pixeldata + norm.
function prepTemplate(rgb) {
  const n = rgb.data.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += rgb.data[i];
  mean /= n;
  const zm = new Float32Array(n);
  let ss = 0;
  for (let i = 0; i < n; i++) { zm[i] = rgb.data[i] - mean; ss += zm[i] * zm[i]; }
  return { w: rgb.w, h: rgb.h, zm, norm: Math.sqrt(ss) || 1 };
}

// NCC for en template mot alla fonsterpositioner i en region; returnerar basta varde.
function bestNcc(region, tpl) {
  const { w: rw, h: rh, data: rd } = region;
  const { w: tw, h: th, zm, norm } = tpl;
  let best = -1;
  for (let oy = 0; oy + th <= rh; oy++) {
    for (let ox = 0; ox + tw <= rw; ox++) {
      let sum = 0, ss = 0, dot = 0;
      for (let y = 0; y < th; y++) {
        const rrow = ((oy + y) * rw + ox) * 3;
        const trow = y * tw * 3;
        for (let i = 0; i < tw * 3; i++) {
          const v = rd[rrow + i];
          sum += v; ss += v * v;
          dot += v * zm[trow + i];
        }
      }
      const n = tw * th * 3;
      const winNorm = Math.sqrt(Math.max(1e-6, ss - sum * sum / n));
      const score = dot / (winNorm * norm);
      if (score > best) best = score;
    }
  }
  return best;
}

function cropRgb(img, x0, y0, w, h) {
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        out[(y * w + x) * 3 + c] = img.data[((y0 + y) * img.width + x0 + x) * 4 + c];
      }
    }
  }
  return { w, h, data: out };
}

// Halverar upplosningen pa en RGB-region (for grovpasset).
function halveRgb(rgb) {
  const w = Math.floor(rgb.w / 2), h = Math.floor(rgb.h / 2);
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        out[(y * w + x) * 3 + c] = (
          rgb.data[((y * 2) * rgb.w + x * 2) * 3 + c] +
          rgb.data[((y * 2) * rgb.w + x * 2 + 1) * 3 + c] +
          rgb.data[((y * 2 + 1) * rgb.w + x * 2) * 3 + c] +
          rgb.data[((y * 2 + 1) * rgb.w + x * 2 + 1) * 3 + c]) / 4;
      }
    }
  }
  return { w, h, data: out };
}

// Laddar (en gang per process) alla hjaltbilder fran CDN och haller dem i minnet
// som ratemplates; skalade varianter cachas per efterfragad bredd.
function loadTemplates() {
  if (!templatesPromise) {
    templatesPromise = (async () => {
      const heroes = await fetchHeroList();
      const out = [];
      for (const h of heroes) {
        try {
          const res = await fetch(CDN + h.slug + '.png');
          if (!res.ok) { console.error('[topbar] CDN-miss for', h.slug, res.status); continue; }
          const png = decodePng(Buffer.from(await res.arrayBuffer()));
          out.push({ name: h.name, png, scaled: {} });
        } catch (e) {
          console.error('[topbar] kunde inte ladda', h.slug, e.message);
        }
      }
      console.log('[topbar] ' + out.length + ' hjalttemplates laddade');
      return out;
    })().catch(e => { templatesPromise = null; throw e; });
  }
  return templatesPromise;
}

function scaledTemplate(hero, w) {
  if (!hero.scaled[w]) {
    const rgb = resizeRgb(hero.png, w);
    hero.scaled[w] = { full: prepTemplate(rgb), coarse: prepTemplate(halveRgb(rgb)) };
  }
  return hero.scaled[w];
}

// Huvudfunktion. pngBuffer: screenshot (hela skarmen eller bara topp-remsan —
// bredden MASTE vara hela skarmens bredd). side: 'radiant' | 'dire' — vilken
// sida av topbaren som ska lasas av (anroparen skickar FIENDENS sida).
async function identifyTopbarHeroes(pngBuffer, side) {
  const heroes = await loadTemplates();
  const img = decodePng(pngBuffer);
  const W = img.width;
  const stripH = Math.min(img.height, Math.round(STRIP_H * W));

  const iconW = Math.round(ICON_W * W);
  const start = Math.round((side === 'radiant' ? LEFT0 : RIGHT0) * W);
  const spacing = SPACING * W;
  const margin = Math.max(6, Math.round(iconW * 0.13));
  const scales = [iconW - 3, iconW, iconW + 3];

  const slots = [];
  for (let i = 0; i < 5; i++) {
    const x = Math.round(start + i * spacing);
    const x0 = Math.max(0, x - margin);
    const rw = Math.min(W - x0, iconW + margin * 2);
    const region = cropRgb(img, x0, 0, rw, stripH);
    const regionCoarse = halveRgb(region);

    // Grovpass pa halv upplosning: rangordna alla hjaltar snabbt
    const coarse = [];
    for (const h of heroes) {
      let best = -1;
      for (const s of scales) {
        const t = scaledTemplate(h, s).coarse;
        if (t.h <= regionCoarse.h && t.w <= regionCoarse.w) {
          const v = bestNcc(regionCoarse, t);
          if (v > best) best = v;
        }
      }
      coarse.push({ hero: h, score: best });
    }
    coarse.sort((a, b) => b.score - a.score);

    // Finpass pa full upplosning for topp-5-kandidaterna
    const fine = coarse.slice(0, 5).map(c => {
      let best = -1;
      for (const s of scales) {
        const t = scaledTemplate(c.hero, s).full;
        if (t.h <= region.h && t.w <= region.w) {
          const v = bestNcc(region, t);
          if (v > best) best = v;
        }
      }
      return { name: c.hero.name, score: best };
    }).sort((a, b) => b.score - a.score);

    slots.push({
      hero: fine[0].name,
      score: fine[0].score,
      margin: fine[0].score - (fine[1] ? fine[1].score : 0),
      runnerUp: fine[1] ? fine[1].name : null
    });
  }

  const names = slots.map(s => s.hero);
  const distinct = new Set(names).size === 5;
  const confident = slots.every(s => s.score >= MIN_SCORE && s.margin >= MIN_MARGIN);
  return {
    ok: distinct && confident,
    heroes: names,
    slots,
    reason: !distinct ? 'dubblettehjalte — troligen felmatchning'
          : !confident ? 'for lag sakerhet i minst en slot'
          : null
  };
}

module.exports = { identifyTopbarHeroes, loadTemplates, STRIP_H, MIN_SCORE, MIN_MARGIN };
