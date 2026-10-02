/** Optimal OTD constants safe to ship to the browser — deliberately kept out of
 * lib/optimal-otd.ts, whose module body pulls in the (large) calendar blob. */

/** Base amount x LEVEL_MULT[level] = the card's at-level claim amount. */
export const LEVEL_MULT: Record<number, number> = {
  1: 2, 2: 3, 3: 4, 4: 10, 5: 25, 6: 28, 7: 32, 8: 35, 9: 40, 10: 75,
  11: 79, 12: 83, 13: 87, 14: 91, 15: 95, 16: 98, 17: 101, 18: 103, 19: 105,
  20: 150, 21: 153, 22: 156, 23: 159, 24: 163, 25: 167, 26: 171, 27: 175,
  28: 180, 29: 185, 30: 190, 31: 196, 32: 202, 33: 208, 34: 214, 35: 220,
  36: 226, 37: 233, 38: 240, 39: 250,
};

/** The rarity tiers the UI offers (level, label). */
export const RARITY_TIERS: { level: number; label: string }[] = [
  { level: 1, label: "Common" },
  { level: 2, label: "Uncommon" },
  { level: 3, label: "Rare" },
  { level: 4, label: "Epic" },
  { level: 5, label: "Legendary" },
  { level: 10, label: "Mystic" },
  { level: 20, label: "Iconic" },
];

/** Lineup sizes the UI offers. */
export const LINEUP_SIZES = [5, 10, 15, 20];
