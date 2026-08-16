// diag.js — lattvikts sjalvdiagnostik for draftavlasningen (topbar-capture).
//
// Bakgrund (2026-08-16): nar avlasningen misslyckas pa lanet finns inget kvar att
// titta pa efterat. Railways HTTP-loggar racker ~2 minuter bakat (status-pollningen
// dranker dem), deploy-loggarna forsvinner vid nasta deploy, och sjalva
// screenshoten kastas sa fort identifyTopbarHeroes kort klart. Felsokningen har
// darfor kravt att Oskar manuellt skickar skarmdumpar dagen efter.
//
// Den har modulen haller ett litet minne i processen over vad som FAKTISKT hande:
// hur manga capture-requests servern skickade, om overlayn svarade, vad varje slot
// fick for score, och de senaste misslyckade remsorna som riktiga PNG:er. Allt
// exponeras via GET /api/diag (+ /api/diag/capture/:id.png) sa hela underlaget kan
// hamtas med ett kommando efter en spelkvall, utan att nagon behover gora nagot
// under tiden.
//
// Allt ligger i minnet med harda tak — inget skrivs till disk (efemart pa Railway)
// och inget gar till JSONBin (requests ar en engangspuckel, se server.js).

const MAX_CAPTURES = 20; // ringbuffert med avlasningsforsok
const MAX_IMAGES = 4;    // sa manga remsor sparas som bilder (ca 1-3MB styck)

const state = {
  bootAt: Date.now(),
  jsonbin: { get: 0, put: 0, post: 0, fail: 0, cacheHits: 0, lastError: null, lastErrorAt: null },
  gsi: {},             // steamid64 -> { payloads, lastState, lastMatchId, lastSeen }
  captureRequests: {}, // alias -> { sent, lastSent, kinds: { kind: n } }
  overlayPolls: {},    // alias -> { polls, lastPoll }
  captures: []         // aldst forst
};
const images = new Map(); // imageId -> { buf, ts, n }
let seq = 0;
let imgSeq = 0; // monoton ordning — Date.now() racker inte, flera bilder kan landa samma ms

// ── Insamling ───────────────────────────────────────────────────────────────

// Varje HTTP-anrop mot JSONBin. kind: 'get'|'put'|'post'.
function bin(kind, ok, errMsg) {
  if (state.jsonbin[kind] != null) state.jsonbin[kind]++;
  if (!ok) {
    state.jsonbin.fail++;
    state.jsonbin.lastError = errMsg || 'okant fel';
    state.jsonbin.lastErrorAt = Date.now();
  }
}

// Cachetraff i getBin — skillnaden mot .get visar hur mycket cachen sparar.
function cacheHit() { state.jsonbin.cacheHits++; }

function gsi(steamid64, gameState, matchId) {
  if (!steamid64) return;
  const g = state.gsi[steamid64] || (state.gsi[steamid64] = { payloads: 0, lastState: null, lastMatchId: null, lastSeen: 0 });
  g.payloads++;
  g.lastState = gameState || g.lastState;
  if (matchId) g.lastMatchId = String(matchId);
  g.lastSeen = Date.now();
}

// Servern bad en spelare om en screenshot. Skillnaden mot antalet capture-poster
// nedan ar hela poangen: "8 skickade, 0 svar" = overlayn ar nere eller pollar fel
// endpoint; "8 skickade, 8 svar, 0 ok" = bilden kommer fram men avlasningen felar.
function captureRequest(alias, kind) {
  const c = state.captureRequests[alias] || (state.captureRequests[alias] = { sent: 0, lastSent: 0, kinds: {} });
  c.sent++;
  c.lastSent = Date.now();
  c.kinds[kind] = (c.kinds[kind] || 0) + 1;
}

function overlayPoll(alias) {
  const o = state.overlayPolls[alias] || (state.overlayPolls[alias] = { polls: 0, lastPoll: 0 });
  o.polls++;
  o.lastPoll = Date.now();
}

// Startar en post for ett avlasningsforsok och lagger den DIREKT i ringbufferten.
// Anroparen far tillbaka objektet och fyller pa falt (outcome, slots, ok...) allt
// eftersom — mutationerna syns i bufferten utan nagot avslutande anrop, sa varje
// tidig return i /api/overlay-capture blir dokumenterad utan extra rader.
function capture(entry) {
  const rec = Object.assign({
    id: 'cap' + (++seq),
    ts: Date.now(),
    alias: null,
    accountId: null,
    mode: null,        // 'lan' | 'pub'
    enemySide: null,
    bytes: null,
    width: null,
    height: null,
    slots: null,
    ok: null,
    reason: null,
    confident: null,
    outcome: 'pagaende', // satts vid varje utgang i routen
    imageId: null
  }, entry || {});
  state.captures.push(rec);
  while (state.captures.length > MAX_CAPTURES) state.captures.shift();
  return rec;
}

// Sparar remsan sa den gar att analysera i efterhand (kor topbar-match.js lokalt
// mot den). Misslyckade avlasningar prioriteras — det ar de som ska granskas.
function captureImage(rec, buf) {
  if (!buf || !buf.length) return;
  const dim = pngSize(buf);
  rec.bytes = buf.length;
  rec.width = dim.width;
  rec.height = dim.height;
  rec.imageId = rec.id;
  images.set(rec.id, { buf: buf, ts: Date.now(), n: ++imgSeq });
  pruneImages();
}

// Behall de senaste misslyckade i forsta hand, plus hogst EN lyckad (bra att ha
// som referens att jamfora en trasig remsa mot) — en misslyckad avlasning ska
// alltid ga att granska, en lyckad sallan.
function pruneImages() {
  if (images.size <= MAX_IMAGES) return;
  const byId = {};
  state.captures.forEach(r => { byId[r.id] = r; });
  const entries = Array.from(images.keys()).map(id => ({ id: id, rec: byId[id], n: images.get(id).n }));
  const failed = entries.filter(e => !e.rec || e.rec.ok !== true).sort((a, b) => b.n - a.n);
  const okOnes = entries.filter(e => e.rec && e.rec.ok === true).sort((a, b) => b.n - a.n);
  const keep = new Set(failed.slice(0, MAX_IMAGES - 1).map(e => e.id));
  if (okOnes.length) keep.add(okOnes[0].id);
  failed.slice(0, MAX_IMAGES).forEach(e => { if (keep.size < MAX_IMAGES) keep.add(e.id); });
  Array.from(images.keys()).forEach(id => {
    if (!keep.has(id)) { images.delete(id); if (byId[id]) byId[id].imageId = null; }
  });
}

function image(id) { const e = images.get(id); return e ? e.buf : null; }

// Bredd/hojd ur PNG:ens IHDR — undviker en andra, dyr avkodning av bilden.
function pngSize(buf) {
  if (!buf || buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return { width: null, height: null };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ── Utlasning ───────────────────────────────────────────────────────────────

function ago(ts) { return ts ? Math.round((Date.now() - ts) / 1000) : null; }

function snapshot(extra) {
  const caps = state.captures.map(r => Object.assign({}, r, { agoSec: ago(r.ts) }));
  const answered = caps.length;
  const requested = Object.keys(state.captureRequests).reduce((n, a) => n + state.captureRequests[a].sent, 0);
  return Object.assign({
    now: new Date().toISOString(),
    uptimeSec: ago(state.bootAt),
    jsonbin: Object.assign({}, state.jsonbin, { lastErrorAgoSec: ago(state.jsonbin.lastErrorAt) }),
    gsi: Object.keys(state.gsi).reduce((o, k) => {
      o[k] = Object.assign({}, state.gsi[k], { lastSeenAgoSec: ago(state.gsi[k].lastSeen) });
      return o;
    }, {}),
    captureRequests: Object.keys(state.captureRequests).reduce((o, a) => {
      o[a] = Object.assign({}, state.captureRequests[a], { lastSentAgoSec: ago(state.captureRequests[a].lastSent) });
      return o;
    }, {}),
    overlayPolls: Object.keys(state.overlayPolls).reduce((o, a) => {
      o[a] = Object.assign({}, state.overlayPolls[a], { lastPollAgoSec: ago(state.overlayPolls[a].lastPoll) });
      return o;
    }, {}),
    captureSummary: {
      requested: requested,
      answered: answered,
      ok: caps.filter(c => c.ok === true).length,
      failed: caps.filter(c => c.ok === false).length,
      savedImages: Array.from(images.keys())
    },
    captures: caps
  }, extra || {});
}

module.exports = { bin, cacheHit, gsi, captureRequest, overlayPoll, capture, captureImage, image, snapshot, pngSize };
