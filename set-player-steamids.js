// set-player-steamids.js — skriver spelarnas Steam-ID (32-bit account_id) till
// spelar-binet via appens eget API, istallet for att lita pa en lokal fil.
// Spelar-binet ar delat mellan dev och prod, sa det racker att kora mot en URL.
//
// Anvandning:
//   node set-player-steamids.js            <- DRY RUN, visar vad som skulle andras
//   node set-player-steamids.js --apply    <- skriver pa riktigt
//
// Kraver i .env: SITE_PASSWORD (samma Basic Auth som resten av sajten).
// Valfritt: PUBLIC_URL (annars dhs27.up.railway.app, samma default som server.js).

const fs = require("fs");
const path = require("path");

try {
  const env = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  env.split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
} catch {}

if (!process.env.SITE_PASSWORD) {
  console.error("SITE_PASSWORD kravs i .env (samma losenord som resten av sajten anvander).");
  process.exit(1);
}

const BASE_URL = process.env.PUBLIC_URL || "https://dhs27.up.railway.app";
const APPLY = process.argv.includes("--apply");

// Alias -> 32-bit OpenDota account_id (samma data som tidigare lag i player-accounts.json).
const STEAM_IDS = {
  "Rutigaskjortan": 2684179,
  "Elsa": 214580933,
  "Pax": 77105636,
  "Jockwe": 1266477726,
  "Flabben": 20027734,
  "PUGGE": 1751671838,
  "Gojja": 52591849,
  "Robin Hood": 104565352,
  "Skiipa": 460948432,
};

function authHeader() {
  return { Authorization: "Basic " + Buffer.from("dhs:" + process.env.SITE_PASSWORD).toString("base64") };
}

async function main() {
  console.log("Hamtar spelare fran " + BASE_URL + " ...");
  const res = await fetch(BASE_URL + "/api/players", { headers: authHeader() });
  if (!res.ok) throw new Error("GET /api/players HTTP " + res.status);
  const players = await res.json();

  const byLowerName = {};
  players.forEach(p => { byLowerName[p.name.toLowerCase()] = p; });

  const unmatched = [];
  const changes = [];
  for (const [alias, steamId] of Object.entries(STEAM_IDS)) {
    const p = byLowerName[alias.toLowerCase()];
    if (!p) { unmatched.push(alias); continue; }
    if (String(p.steamId || "") === String(steamId)) {
      console.log("  " + p.name + ": redan " + steamId + " — ingen andring");
      continue;
    }
    changes.push({ name: p.name, from: p.steamId || "(saknas)", to: steamId });
  }

  if (unmatched.length) {
    console.log("\nHittade INGEN spelare i binet for: " + unmatched.join(", ") + " — kontrollera stavning/namn manuellt.");
  }

  if (!changes.length) {
    console.log("\nInget att uppdatera.");
    return;
  }

  console.log("\n" + changes.length + " spelare skulle uppdateras:");
  changes.forEach(c => console.log("  " + c.name + ": " + c.from + " -> " + c.to));

  if (!APPLY) {
    console.log("\nDRY RUN — inget skickat. Kor med --apply for att skriva pa riktigt.");
    return;
  }

  for (const c of changes) {
    const putRes = await fetch(BASE_URL + "/api/players/" + encodeURIComponent(c.name) + "/steamid", {
      method: "PUT",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeader()),
      body: JSON.stringify({ steamId: c.to }),
    });
    if (!putRes.ok) { console.error("  FEL vid " + c.name + ": HTTP " + putRes.status); continue; }
    console.log("  " + c.name + " uppdaterad.");
  }
  console.log("\nKlart.");
}

main().catch(e => { console.error("Fel:", e.message); process.exit(1); });
