/**
 * "Daily Pack Buys" search preset — the cards in Walker's `Daily Pack Buys`
 * album, i.e. the ones he is pushing with one 200-rax pack a day.
 *
 * The point of this preset is NOT to bid: it exists so the marketplace can be
 * re-checked for **play cards priced at or under DAILY_PACK_FACTOR rax per
 * rating point**. A pack yields ~10 rating for 200 rax (20 rax/rating), so a
 * listing under 21 rax/rating is cheaper fuel than the pack itself — those are
 * the buys worth making on top of the daily pack.
 *
 * Seasons follow Real's own keys: NHL by STARTING year (2023 = 2023-24), CBB by
 * ENDING year (2024 = 2023-24, 2025 = 2024-25), WNBA by STARTING year.
 *
 * Grouped into {sport, season} slices because a marketplace query is always one
 * sport/season; there is one preset ("All 18") covering every slice at once.
 * Slices stay on one line each so scripts/autobid/export_presets.mjs can lift
 * them into the userscript.
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
    id: "all",
    label: "All 17",
    cards: 17,
    slices: [{"sport": "nhl","season": 2023,"players": ["Connor McDavid","Leon Draisaitl","Vincent Trocheck"]},{"sport": "nhl","season": 2024,"players": ["Connor McDavid","Leon Draisaitl","Nathan MacKinnon"]},{"sport": "nhl","season": 2025,"players": ["Nathan MacKinnon"]},{"sport": "ncaam","season": 2025,"players": ["Yaxel Lendeborg","Johni Broome","Cooper Flagg","Braden Smith","Mark Sears"]},{"sport": "ncaam","season": 2026,"players": ["Cameron Boozer","Bennett Stirtz","Keaton Wagler"]},{"sport": "ncaam","season": 2024,"players": ["Zach Edey"]},{"sport": "wnba","season": 2025,"players": ["A'ja Wilson"]}],
  },
];
