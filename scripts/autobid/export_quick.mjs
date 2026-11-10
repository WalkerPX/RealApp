#!/usr/bin/env node
/**
 * Bake the iOS app's saved Quick Searches into the userscript's PRESETS.
 *
 * The Made tweak (real-ios/tweak/made_layer.js) keeps its quick searches in
 * AsyncStorage *and* mirrors them to the IPA host (SYNC_URL "…/ipa/menu/quick"),
 * because a sideload update wipes the app container. That mirror is the single
 * source of truth here — so the dropdown in the userscript and the list in the
 * iOS app can't drift the way the old generated families did.
 *
 *   QUICK_USER=walkr QUICK_TOKEN=… node scripts/autobid/export_quick.mjs
 *   node scripts/autobid/export_quick.mjs --file /tmp/quick.json   # offline
 *
 * A quick search is only a nickname + a player list (the app's deal screen —
 * factor, rarities, listing types — is global state, not part of the saved
 * entry), so each one becomes a preset of {sport, season, players} slices,
 * exactly the shape scan() already understands. The app screens at a factor of
 * 21 by default, so every generated preset carries maxRpr: 21.
 */
import { readFileSync, writeFileSync } from "node:fs";

const SCRIPT = new URL("../../userscripts/walkr-autobid.user.js", import.meta.url).pathname;
const SYNC_URL = process.env.QUICK_URL || "https://truenas.tail94e08b.ts.net:8443/ipa/menu/quick";
const USER = process.env.QUICK_USER || "walkr";
const TOKEN = process.env.QUICK_TOKEN || "";
const CEILING = 21; // the iOS app's default deal-screen factor

const fileArg = process.argv.indexOf("--file");
let payload;
if (fileArg > 0) {
  payload = JSON.parse(readFileSync(process.argv[fileArg + 1], "utf8"));
} else {
  if (!TOKEN) {
    console.error("Missing QUICK_TOKEN (or pass --file <json>).");
    process.exit(1);
  }
  const url = `${SYNC_URL}?u=${encodeURIComponent(USER)}&t=${encodeURIComponent(TOKEN)}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Sync fetch failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  payload = await res.json();
}

const items = Array.isArray(payload.items) ? payload.items : [];
if (!items.length) {
  console.error("No quick searches in the payload — refusing to blank the dropdown.");
  process.exit(1);
}

/** Group a flat player list into {sport, season, players[]} slices, in the
 * order the app lists them. A search can span sports (Farm-Mens BB is CBB and
 * NBA at once), which is exactly why the preset is a list of slices. */
function slices(players) {
  const out = [], at = new Map();
  for (const p of players) {
    if (!p || !p.name || !p.sport) continue;
    const season = Number(p.season);
    if (!Number.isFinite(season)) continue;
    const key = `${p.sport}|${season}`;
    if (!at.has(key)) {
      at.set(key, out.length);
      out.push({ sport: p.sport, season, players: [] });
    }
    const slice = out[at.get(key)];
    if (!slice.players.includes(p.name)) slice.players.push(p.name);
  }
  return out;
}

const presets = items.map((q) => {
  const sl = slices(q.players || []);
  const sports = new Set(sl.map((s) => s.sport));
  const cards = sl.reduce((n, s) => n + s.players.length, 0);
  return {
    id: `ios-${q.id}`,
    label: String(q.nick || q.id).trim(),
    sport: sports.size === 1 ? [...sports][0] : "all",
    cards,
    maxRpr: CEILING,
    slices: sl,
  };
}).filter((p) => p.slices.length);

if (!presets.length) {
  console.error("Every quick search was empty — refusing to write.");
  process.exit(1);
}

const block =
  "  // >>> GENERATED PRESETS\n" +
  "  // Baked from the iOS app's saved Quick Searches (Made tweak → IPA host\n" +
  "  // /ipa/menu/quick). Regenerate: node scripts/autobid/export_quick.mjs\n" +
  `  // ${presets.length} searches · ${presets.reduce((n, p) => n + p.cards, 0)} cards · screens at ×${CEILING}\n` +
  "  const PRESETS = [\n" +
  presets.map((p) => "    " + JSON.stringify(p) + ",").join("\n") +
  "\n  ];\n" +
  "  // <<< GENERATED PRESETS";

const src = readFileSync(SCRIPT, "utf8");
const re = / {2}\/\/ >>> GENERATED PRESETS[\s\S]*? {2}\/\/ <<< GENERATED PRESETS/;
if (!re.test(src)) {
  console.error("Marker block not found in the userscript — nothing written.");
  process.exit(1);
}
writeFileSync(SCRIPT, src.replace(re, block));

console.log(`wrote ${presets.length} presets · ${presets.reduce((n, p) => n + p.cards, 0)} cards`);
for (const p of presets) console.log(`  ${p.label.padEnd(14)} ${p.sport.padEnd(6)} ${p.cards} card(s) in ${p.slices.length} slice(s)`);
