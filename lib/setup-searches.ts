/**
 * "Optimal Setup" search presets — the optimal-ROI upgrade lineups.
 *
 * A third question alongside the other quick-search families:
 *   Optimal Budget  — what is cheap enough to buy (solved at a ceiling)
 *   Optimal MAX     — what is on the market for a hand-picked push list
 *   Optimal Setup   — of the optimal OTD lineup, which cards are still worth
 *                     paying to push to Legendary?
 *
 * Each set is the answer for base -> Legendary at 7,600 rax a card (380 rating x
 * 20 rax), ranked by marginal gain with the top-two-per-day cap recomputed after
 * every upgrade, cut where the next card's payback passes ~1.24 years. It is the
 * highest-ROI upgrades, not the highest-contribution cards.
 *
 *   CBB  8 cards — cut before Keyshawn Hall 2025 (1.49y);         worst kept 1.24y
 *   NHL  9 cards — cut before Andrei Vasilevskiy 2024 (1.34y);    worst kept 1.17y
 *   NBA  5 cards — cut before Giannis Antetokounmpo 2025 (1.32y); worst kept 1.09y
 *   WNBA 6 cards — cut before Alyssa Thomas 2025 (1.44y);         worst kept 1.05y
 *   MLB 14 cards — cut before Chris Sale 2024 (1.40y);            worst kept 1.16y
 *
 * Seasons follow Real's own keys, which differ per sport: NHL / WNBA / MLB by
 * STARTING year (2023 = 2023-24, MLB 2026 = the 2026 season); NBA and CBB by
 * ENDING year (2025 = 2024-25).
 *
 * Screened at SETUP_SEARCH_FACTOR (21 rax/rating) — the same pack-rate screen
 * the Daily Pack Buys search uses, so anything listed is at or under what a pack
 * already costs. Edit by hand; unlike budget-searches.ts this is not generated.
 */
import type { WalkerOtdSlice } from "./deals";

export interface SetupSearchPreset {
  id: string;
  label: string;
  /** How many players the preset searches for. */
  cards: number;
  /** Base rax/yr the lineup is worth (unboosted). */
  best: number;
  slices: WalkerOtdSlice[];
}

/** Rating factor the Optimal Setup searches run at — the pack-rate screen, same
 * as the Daily Pack Buys ceiling. */
export const SETUP_SEARCH_FACTOR = 21;

export const SETUP_SEARCH_PRESETS: SetupSearchPreset[] = [
  {
    id: "cbb",
    label: "CBB",
    cards: 8,
    best: 3633,
    slices: [{"sport": "ncaam","season": 2026,"players": ["Cameron Boozer"]},{"sport": "ncaam","season": 2025,"players": ["Yaxel Lendeborg","Johni Broome","Cooper Flagg","Eric Dixon","Braden Smith"]},{"sport": "ncaam","season": 2024,"players": ["Zach Edey","Mark Sears"]}],
  },
  {
    id: "nhl",
    label: "NHL",
    cards: 9,
    best: 3692,
    slices: [{"sport": "nhl","season": 2025,"players": ["Nathan MacKinnon"]},{"sport": "nhl","season": 2024,"players": ["Leon Draisaitl","Connor Hellebuyck","Sergei Bobrovsky"]},{"sport": "nhl","season": 2023,"players": ["Connor McDavid","Leon Draisaitl","Igor Shesterkin","Sergei Bobrovsky","Jake Oettinger"]}],
  },
  {
    id: "nba",
    label: "NBA",
    cards: 5,
    best: 2352,
    slices: [{"sport": "nba","season": 2026,"players": ["Jalen Brunson"]},{"sport": "nba","season": 2025,"players": ["Shai Gilgeous-Alexander","Nikola Jokic"]},{"sport": "nba","season": 2024,"players": ["Luka Doncic","Nikola Jokic"]}],
  },
  {
    id: "wnba",
    label: "WNBA",
    cards: 6,
    best: 2829,
    slices: [{"sport": "wnba","season": 2026,"players": ["A'ja Wilson"]},{"sport": "wnba","season": 2025,"players": ["A'ja Wilson","Aliyah Boston"]},{"sport": "wnba","season": 2024,"players": ["Napheesa Collier","A'ja Wilson","Breanna Stewart"]}],
  },
  {
    id: "mlb",
    label: "MLB",
    cards: 14,
    best: 5806,
    slices: [{"sport": "mlb","season": 2026,"players": ["Shohei Ohtani","Cam Schlittler","Cristopher Sanchez","Jacob Misiorowski"]},{"sport": "mlb","season": 2025,"players": ["Shohei Ohtani","Yoshinobu Yamamoto","Eric Lauer","Kevin Gausman","Tarik Skubal"]},{"sport": "mlb","season": 2024,"players": ["Shohei Ohtani","Tarik Skubal","Zack Wheeler","Seth Lugo","Logan Gilbert"]}],
  },
];
