/**
 * "Daily Pack Buys" search presets — the 15 cards in Walker's `Daily Pack Buys`
 * album, i.e. the ones he is pushing to Legendary with one 200-rax pack a day.
 *
 * The point of this preset is NOT to bid: it exists so the marketplace can be
 * re-checked for **play cards priced at or under DAILY_PACK_FACTOR rax per
 * rating point**. A pack yields ~10 rating for 200 rax (20 rax/rating), so a
 * listing under 21 rax/rating is cheaper fuel than the pack itself — those are
 * the buys worth making on top of the daily pack.
 *
 * Seasons follow Real's own keys: NHL by STARTING year (2023 = 2023-24), CBB by
 * ENDING year (2025 = 2024-25).
 *
 * Grouped into {sport, season} slices because a marketplace query is always one
 * sport/season; "All 16" is every slice at once. Slices stay on one line each so
 * scripts/autobid/export_presets.mjs can lift them into the userscript.
 */
import type { WalkerOtdSlice } from "./deals";

export interface DailyPackPreset {
  id: string;
  label: string;
  /** How many players the preset searches for. */
  cards: number;
  slices: WalkerOtdSlice[];
}

/** Ceiling the search flags at, in rax per rating point. */
export const DAILY_PACK_FACTOR = 21;

/** A pack yields ~10 rating for 200 rax, so 20 rax/rating is the pack's own
 * price. Listings under this preset's ceiling beat it. */
export const PACK_RAX_PER_RATING = 20;

export const DAILY_PACK_PRESETS: DailyPackPreset[] = [
  {
    id: "nhl-2023",
    label: "NHL 2023-24",
    cards: 4,
    slices: [{"sport": "nhl","season": 2023,"players": ["Connor McDavid","Leon Draisaitl","Nathan MacKinnon","Vincent Trocheck"]}],
  },
  {
    id: "nhl-2024",
    label: "NHL 2024-25",
    cards: 3,
    slices: [{"sport": "nhl","season": 2024,"players": ["Connor McDavid","Leon Draisaitl","Nathan MacKinnon"]}],
  },
  {
    id: "nhl-2025",
    label: "NHL 2025-26",
    cards: 1,
    slices: [{"sport": "nhl","season": 2025,"players": ["Nathan MacKinnon"]}],
  },
  {
    id: "cbb-2025",
    label: "CBB 2024-25",
    cards: 5,
    slices: [{"sport": "ncaam","season": 2025,"players": ["Yaxel Lendeborg","Johni Broome","Cooper Flagg","Braden Smith","Mark Sears"]}],
  },
  {
    id: "cbb-2026",
    label: "CBB 2025-26",
    cards: 3,
    slices: [{"sport": "ncaam","season": 2026,"players": ["Cameron Boozer","Bennett Stirtz","Keaton Wagler"]}],
  },
  {
    id: "all",
    label: "All 16",
    cards: 16,
    slices: [{"sport": "nhl","season": 2023,"players": ["Connor McDavid","Leon Draisaitl","Nathan MacKinnon","Vincent Trocheck"]},{"sport": "nhl","season": 2024,"players": ["Connor McDavid","Leon Draisaitl","Nathan MacKinnon"]},{"sport": "nhl","season": 2025,"players": ["Nathan MacKinnon"]},{"sport": "ncaam","season": 2025,"players": ["Yaxel Lendeborg","Johni Broome","Cooper Flagg","Braden Smith","Mark Sears"]},{"sport": "ncaam","season": 2026,"players": ["Cameron Boozer","Bennett Stirtz","Keaton Wagler"]}],
  },
];
