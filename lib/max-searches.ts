/**
 * "Optimal MAX" search presets — the uncapped counterpart to Optimal Budget.
 *
 * Optimal Budget lineups are solved to cards you can actually buy cheap
 * (>= 2 live listings at or under a small rax-per-rating ceiling). Optimal MAX
 * is the other question: for a hand-picked push lineup, is any of it on the
 * market at the price a daily pack already gives you? So these screen at
 * MAX_SEARCH_FACTOR (21 rax/rating — the Daily Pack Buys ceiling), and the shop's
 * own rax/rating column tells you which listings to take.
 *
 * The lineups are named by hand, not solved, so unlike budget-searches.ts this
 * file is not generated — edit it directly. Slices stay on one line each so
 * scripts/autobid/export_presets.mjs can lift them into the userscript.
 */
import type { WalkerOtdSlice } from "./deals";

export interface MaxSearchPreset {
  id: string;
  label: string;
  /** How many players the preset searches for. */
  cards: number;
  /** Base rax/yr the lineup is worth (unboosted). */
  best: number;
  slices: WalkerOtdSlice[];
}

/** Rating factor the Optimal MAX searches run at — matched to the Daily Pack
 * Buys screen (21 rax/rating). A pack is 200 rax for ~10 rating (20 rax/rating),
 * so a 21 screen lists only fuel that matches or beats a daily pack. */
export const MAX_SEARCH_FACTOR = 21;

export const MAX_SEARCH_PRESETS: MaxSearchPreset[] = [
  {
    id: "cbb",
    label: "CBB",
    cards: 7,
    best: 3113,
    slices: [{"sport": "ncaam","season": 2026,"players": ["Cameron Boozer","Yaxel Lendeborg"]},{"sport": "ncaam","season": 2025,"players": ["Johni Broome","Cooper Flagg","Mark Sears","Braden Smith"]},{"sport": "ncaam","season": 2024,"players": ["Zach Edey"]}],
  },
];
