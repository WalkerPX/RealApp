#!/usr/bin/env node
/**
 * Regenerates the QUICK SEARCH preset block inside userscripts/walkr-autobid.user.js
 * from the two files that already own that data:
 *
 *   lib/budget-searches.ts  BUDGET_SEARCH_PRESETS  (the "Optimal Budget" lineups)
 *   lib/max-searches.ts     MAX_SEARCH_PRESETS     (the "Optimal MAX" lineups)
 *   lib/setup-searches.ts   SETUP_SEARCH_PRESETS   (the "Optimal Setup" lineups)
 *   lib/daily-pack-searches.ts  DAILY_PACK_PRESETS (the "Daily Pack Buys" album)
 *   lib/deals.ts            LOW_PERRAX_SLICES      (the Low PerRax tracked players)
 *
 * The userscript runs on realapp.com and can't import any of them, so its copy
 * has to be baked in. Run this after a budget sweep regenerates budget-searches.ts,
 * after editing daily-pack-searches.ts, or the dropdown will quote lineups the
 * menu no longer agrees with.
 *
 *   node scripts/autobid/export_presets.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const budgetPath = join(root, "lib", "budget-searches.ts");
const maxPath = join(root, "lib", "max-searches.ts");
const setupPath = join(root, "lib", "setup-searches.ts");
const dailyPackPath = join(root, "lib", "daily-pack-searches.ts");
const dealsPath = join(root, "lib", "deals.ts");
const target = join(root, "userscripts", "walkr-autobid.user.js");

const BEGIN = "  // >>> GENERATED PRESETS";
const END = "  // <<< GENERATED PRESETS";

const playersIn = (s) => (s.match(/"([^"]*)"/g) || []).map((x) => x.slice(1, -1));

/** budget-searches.ts slices are pure JSON on one line each, and a preset may
 * carry a per-player ceiling map (`playerCaps`) for cards it buys looser than
 * the ceiling — that rides along so the extension screens each player at the
 * same number the menu does. */
function budgetPresets() {
  const src = readFileSync(budgetPath, "utf8");
  const out = [];
  for (const chunk of src.split(/\n\s*\{\s*\n\s*id:\s*"/).slice(1)) {
    const id = chunk.slice(0, chunk.indexOf('"'));
    const label = /label:\s*"([^"]+)"/.exec(chunk)?.[1];
    const cards = Number(/cards:\s*(\d+)/.exec(chunk)?.[1]);
    const line = /slices:\s*(\[[^\n]*\])\s*,/.exec(chunk)?.[1];
    const caps = /playerCaps:\s*(\{[^\n]*\})\s*,/.exec(chunk)?.[1];
    if (!label || !line) continue;
    const slices = JSON.parse(line);
    const preset = {
      id: `budget-${id}`,
      label: `Optimal Budget · ${label}`,
      sport: commonSport(slices),
      cards,
      slices: slices.map((s) => ({ sport: s.sport, season: s.season, players: s.players })),
    };
    if (caps) preset.playerCaps = JSON.parse(caps);
    out.push(preset);
  }
  return out;
}

/** max-searches.ts has the budget shape but no playerCaps. Its presets screen at
 * MAX_SEARCH_FACTOR, so that ceiling rides along as `maxRpr` and the extension
 * bids at the number the shop menu quotes. */
function maxPresets() {
  const src = readFileSync(maxPath, "utf8");
  const factor = factorIn(maxPath, "MAX_SEARCH_FACTOR");
  const out = [];
  for (const chunk of src.split(/\n\s*\{\s*\n\s*id:\s*"/).slice(1)) {
    const id = chunk.slice(0, chunk.indexOf('"'));
    const label = /label:\s*"([^"]+)"/.exec(chunk)?.[1];
    const cards = Number(/cards:\s*(\d+)/.exec(chunk)?.[1]);
    const line = /slices:\s*(\[[^\n]*\])\s*,/.exec(chunk)?.[1];
    if (!label || !line) continue;
    const slices = JSON.parse(line);
    out.push({
      id: `max-${id}`,
      label: `Optimal MAX · ${label}`,
      sport: commonSport(slices),
      cards,
      maxRpr: factor,
      slices: slices.map((s) => ({ sport: s.sport, season: s.season, players: s.players })),
    });
  }
  if (!out.length) throw new Error("no presets parsed out of MAX_SEARCH_PRESETS");
  return out;
}

/** setup-searches.ts is the max-searches shape exactly (hand-written, no
 * playerCaps) — same parse, same `maxRpr` from SETUP_SEARCH_FACTOR, different
 * label prefix. */
function setupPresets() {
  const src = readFileSync(setupPath, "utf8");
  const factor = factorIn(setupPath, "SETUP_SEARCH_FACTOR");
  const out = [];
  for (const chunk of src.split(/\n\s*\{\s*\n\s*id:\s*"/).slice(1)) {
    const id = chunk.slice(0, chunk.indexOf('"'));
    const label = /label:\s*"([^"]+)"/.exec(chunk)?.[1];
    const cards = Number(/cards:\s*(\d+)/.exec(chunk)?.[1]);
    const line = /slices:\s*(\[[^\n]*\])\s*,/.exec(chunk)?.[1];
    if (!label || !line) continue;
    const slices = JSON.parse(line);
    out.push({
      id: `setup-${id}`,
      label: `Optimal Setup · ${label}`,
      sport: commonSport(slices),
      cards,
      maxRpr: factor,
      slices: slices.map((s) => ({ sport: s.sport, season: s.season, players: s.players })),
    });
  }
  if (!out.length) throw new Error("no presets parsed out of SETUP_SEARCH_PRESETS");
  return out;
}

/** daily-pack-searches.ts has the same shape, plus a per-preset rpr ceiling.
 * That ceiling rides along as `maxRpr` so the extension screens at the same
 * number the menu's ×21 search uses instead of the script's own 11. */
function dailyPackPresets() {
  const src = readFileSync(dailyPackPath, "utf8");
  const factor = Number(/DAILY_PACK_FACTOR\s*=\s*(\d+)/.exec(src)?.[1]);
  if (!factor) throw new Error("DAILY_PACK_FACTOR not found in lib/daily-pack-searches.ts");
  const out = [];
  for (const chunk of src.split(/\n\s*\{\s*\n\s*id:\s*"/).slice(1)) {
    const id = chunk.slice(0, chunk.indexOf('"'));
    const label = /label:\s*"([^"]+)"/.exec(chunk)?.[1];
    const cards = Number(/cards:\s*(\d+)/.exec(chunk)?.[1]);
    const line = /slices:\s*(\[[^\n]*\])\s*,/.exec(chunk)?.[1];
    if (!label || !line) continue;
    const slices = JSON.parse(line);
    out.push({
      id: `dailypack-${id}`,
      label: `Daily Pack Buys · ${label}`,
      sport: commonSport(slices),
      cards,
      maxRpr: factor,
      slices: slices.map((s) => ({ sport: s.sport, season: s.season, players: s.players })),
    });
  }
  if (!out.length) throw new Error("no presets parsed out of DAILY_PACK_PRESETS");
  return out;
}

/** deals.ts uses unquoted keys and inline /* … *\/ comments. */
function lowPerRax() {
  const src = readFileSync(dealsPath, "utf8");
  const body = /LOW_PERRAX_SLICES:\s*WalkerOtdSlice\[\]\s*=\s*\[([\s\S]*?)\n\];/.exec(src)?.[1];
  if (!body) throw new Error("LOW_PERRAX_SLICES not found in lib/deals.ts");
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /\{\s*sport:\s*"([^"]+)",\s*season:\s*(\d+),\s*players:\s*\[([^\]]*)\]\s*\}/g;
  const slices = [];
  for (const m of clean.matchAll(re)) {
    slices.push({ sport: m[1], season: Number(m[2]), players: playersIn(m[3]) });
  }
  if (!slices.length) throw new Error("no slices parsed out of LOW_PERRAX_SLICES");
  return [{
    id: "lowperrax",
    label: "Low PerRax",
    sport: "all",
    cards: slices.reduce((n, s) => n + s.players.length, 0),
    slices,
  }];
}

/** A preset whose slices all sit in one sport gets that sport; otherwise "all". */
function commonSport(slices) {
  const set = new Set(slices.map((s) => s.sport));
  return set.size === 1 ? [...set][0] : "all";
}

/** The screening ceiling a family's lib file declares (e.g. SETUP_SEARCH_FACTOR).
 * Baked in as the preset's `maxRpr` so the extension screens at the same number
 * the shop menu quotes — without it the extension falls back to SCRIPT_CAPS
 * (11) and quietly bids looser/tighter than the menu says. */
function factorIn(path, constName) {
  const m = new RegExp(`${constName}\\s*=\\s*(\\d+)`).exec(readFileSync(path, "utf8"));
  if (!m) throw new Error(`${constName} not found in ${path}`);
  return Number(m[1]);
}

const presets = [
  ...lowPerRax(),
  ...budgetPresets(),
  ...maxPresets(),
  ...setupPresets(),
  ...dailyPackPresets(),
];
const block = [
  BEGIN,
  "  const PRESETS = [",
  ...presets.map((p) => `    ${JSON.stringify(p)},`),
  "  ];",
  END,
].join("\n");

const src = readFileSync(target, "utf8");
const before = src.indexOf(BEGIN);
const after = src.indexOf(END);
if (before < 0 || after < 0) throw new Error("preset markers missing from the userscript");
writeFileSync(target, src.slice(0, before) + block + src.slice(after + END.length));

console.log(`wrote ${presets.length} presets into userscripts/walkr-autobid.user.js`);
for (const p of presets) {
  console.log(`  ${p.id.padEnd(20)} sport=${p.sport.padEnd(6)} cards=${String(p.cards).padStart(2)} slices=${p.slices.length}`);
}
