#!/usr/bin/env node
/**
 * Regenerates the QUICK SEARCH preset block inside userscripts/walkr-autobid.user.js
 * from the two files that already own that data:
 *
 *   lib/budget-searches.ts  BUDGET_SEARCH_PRESETS  (the "Optimal Budget" lineups)
 *   lib/deals.ts            LOW_PERRAX_SLICES      (the Low PerRax tracked players)
 *
 * The userscript runs on realapp.com and can't import either, so its copy has to
 * be baked in. Run this after a budget sweep regenerates budget-searches.ts, or
 * the dropdown will quote lineups the menu no longer agrees with.
 *
 *   node scripts/autobid/export_presets.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const budgetPath = join(root, "lib", "budget-searches.ts");
const dealsPath = join(root, "lib", "deals.ts");
const target = join(root, "userscripts", "walkr-autobid.user.js");

const BEGIN = "  // >>> GENERATED PRESETS";
const END = "  // <<< GENERATED PRESETS";

const playersIn = (s) => (s.match(/"([^"]*)"/g) || []).map((x) => x.slice(1, -1));

/** budget-searches.ts slices are pure JSON on one line each. */
function budgetPresets() {
  const src = readFileSync(budgetPath, "utf8");
  const out = [];
  for (const chunk of src.split(/\n\s*\{\s*\n\s*id:\s*"/).slice(1)) {
    const id = chunk.slice(0, chunk.indexOf('"'));
    const label = /label:\s*"([^"]+)"/.exec(chunk)?.[1];
    const cards = Number(/cards:\s*(\d+)/.exec(chunk)?.[1]);
    const line = /slices:\s*(\[[^\n]*\])\s*,/.exec(chunk)?.[1];
    if (!label || !line) continue;
    const slices = JSON.parse(line);
    out.push({
      id: `budget-${id}`,
      label: `Optimal Budget · ${label}`,
      sport: commonSport(slices),
      cards,
      slices: slices.map((s) => ({ sport: s.sport, season: s.season, players: s.players })),
    });
  }
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

const presets = [...lowPerRax(), ...budgetPresets()];
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
