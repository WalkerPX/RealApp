/**
 * Real marketplace deal engine (web-friendly port of real-deal-tracker's
 * real_deals.py). Pure GETs against the Real web API — no LLM anywhere.
 *
 * The cron tracker scans everything market-wide with disk caches + a long
 * budget; a Vercel function can't. So this engine takes an explicit filter
 * (sport + season + card types + rarities + optional player names) and scans
 * only that slice, time-boxed (~20s) with in-memory FMV caching.
 */

export type DealSport = "nfl" | "ncaaf" | "ncaam" | "nba" | "nhl" | "mlb" | "wnba" | "soccer";
export type DealListingType = "userpassfull" | "card";

export const DEAL_SPORTS: { id: DealSport; label: string }[] = [
  { id: "mlb", label: "MLB" },
  { id: "wnba", label: "WNBA" },
  { id: "nba", label: "NBA" },
  { id: "ncaaf", label: "CFB" },
  { id: "ncaam", label: "CBB" },
  { id: "nfl", label: "NFL" },
  { id: "nhl", label: "NHL" },
  { id: "soccer", label: "FC" },
];

/** Season per sport (API stores every season as its starting year). */
export const DEAL_SEASONS: Record<DealSport, number[]> = {
  // MLB verified live bulk listings: 2024-2026 (current), 2023 (1+), 2022 (5+); 2021 has none.
  mlb: [2026, 2025, 2024, 2023, 2022],
  wnba: [2026, 2025, 2024],
  // NBA keys by ENDING year like CBB (param 2026 = the 2025-26 set). 2023
  // (2022-23) has live listings; 2022 (2021-22) has none.
  nba: [2026, 2025, 2024, 2023],
  ncaaf: [2026, 2025, 2024, 2023],
  // CBB is keyed by ENDING year: season param 2026 = the 2025-26 set (Real
  // stores CBB as "2025-26" cards; cf. ncaaf which is starting-year 2026 =
  // 2026-27). 2026-27 (param 2027) has no cards until the season launches.
  ncaam: [2026, 2025, 2024],
  nfl: [2025, 2024, 2023],
  // NHL keys by STARTING year (2025 = 2025-26); 2026-27 has no cards yet.
  nhl: [2025, 2024, 2023],
  // FC keys by STARTING year (2026 = 2026-27, opened Sep 2026; 2025 = 2025-26).
  soccer: [2026, 2025],
};

/** Seasons still in progress — cards have no future OTD claim dates yet, so
 * the "pays for itself" (ROI) check only applies to past seasons. */
export const CURRENT_SEASONS: Partial<Record<DealSport, number>> = {
  mlb: 2026,
  wnba: 2026,
  ncaaf: 2026,
};

export const RARITY_LABELS: Record<number, string> = {
  1: "Common",
  2: "Uncommon",
  3: "Rare",
  4: "Epic",
  5: "Legendary",
  6: "Mystic",
  7: "Iconic",
};

export function seasonLabel(sport: DealSport, season: number): string {
  // MLB/WNBA key by calendar year.
  if (sport === "mlb" || sport === "wnba") return String(season);
  // CBB/NBA key by ending year (2026 = 2025-26); everyone else keys by start.
  if (sport === "ncaam" || sport === "nba") return `${season - 1}-${String(season).slice(-2)}`;
  return `${season}-${String((season % 100) + 1).padStart(2, "0")}`;
}

export const LISTING_TYPE_META: Record<
  DealListingType,
  { label: string; short: string }
> = {
  userpassfull: { label: "Bulk rating cards", short: "BULK" },
  card: { label: "Play cards", short: "PLAY" },
};

/** One wlkr-OTD scan slice: a sport/season bucket + the players to watch for
 * (rare→iconic bulk passes). Mirrors the tracker's major-sale watchlist. */
export interface WalkerOtdSlice {
  sport: DealSport;
  season: number;
  players: string[];
}

export const WALKER_OTD_SLICES: WalkerOtdSlice[] = [
  { sport: "mlb", season: 2025, players: ["Ben Rice", "Shohei Ohtani"] },
  { sport: "wnba", season: 2025, players: ["Gabby Williams", "Erica Wheeler", "A'ja Wilson"] },
  { sport: "soccer", season: 2025, players: ["Kylian Mbappe", "Lamine Yamal", "Michael Olise", "Erling Haaland", "Harry Kane", "Lionel Messi"] },
  { sport: "nfl", season: 2025, players: ["Christian McCaffrey"] },
  { sport: "nfl", season: 2024, players: ["Saquon Barkley"] },
  { sport: "ncaaf", season: 2025, players: ["Kiael Kelly", "Eric Weatherly", "Fernando Mendoza", "Nick Minicucci", "Cam Cook"] },
  { sport: "ncaaf", season: 2024, players: ["Cam Skattebo", "Ashton Jeanty"] },
  { sport: "ncaaf", season: 2023, players: ["Michael Wiley"] },
  { sport: "ncaam", season: 2026, players: ["Braden Smith", "Darius Acuff Jr.", "Bennett Stirtz", "Keaton Wagler", "Yaxel Lendeborg", "Cameron Boozer"] },
  { sport: "ncaam", season: 2025, players: ["Braden Smith", "Cooper Flagg", "Mark Sears", "Yaxel Lendeborg", "Johnie Broome"] },
  { sport: "ncaam", season: 2024, players: ["Zach Edey"] },
  { sport: "nba", season: 2024, players: ["Buddy Hield"] }, // 2024 = 2023-24 (ending-year key)
];

/** wlkr-Active scan slices: current-season (2026-27) watchlist, scanned by
 * the "wlkr Active scan" button exactly like the OTD sweep but with live
 * players instead of bulk-earnings targets. */
export const WALKER_ACTIVE_SLICES: WalkerOtdSlice[] = [
  {
    sport: "ncaaf",
    season: 2026,
    players: [
      "Jackson Arnold",
      "Trinidad Chambliss",
      "Jeremiah Smith",
      "Dante Moore",
      "Julian Sayin",
      "Josh Hoover",
      "Rocco Becht",
      "Nate Sheppard",
      "Arch Manning",
      "KJ Duff",
      "Demond Williams Jr.",
      "Charlie Becker",
      "CJ Carr",
      "Ryan Browne",
      "Bryce Underwood",
      "Dakorien Moore",
      "Fame Ijeboi",
      "Turbo Richard",
      "Asaad Waseem",
      "JJ Buchanan",
      "Bo Jackson",
      "Jeremiah McClellan",
      "Xavier Townsend",
      "Nick Marsh",
      "Rolijah Hardy",
      "Chris Henry Jr.",
      "Jerrick Gibson",
      "Charles Correa",
      "Andrew Marsh",
      "Ricky Sampson",
      "Darian Mensah",
      "Isiah Jones",
    ],
  },
];

/** One selectable player occurrence in the tracked-player menu:
 * `sport|season|player` — unique per (sport, season) group. */
export function walkerOtdKey(sport: DealSport, season: number, player: string): string {
  return `${sport}|${season}|${player}`;
}

export interface WalkerOtdMenuPlayer {
  name: string;
  key: string;
}

export interface WalkerOtdMenuSeason {
  season: number;
  label: string;
  players: WalkerOtdMenuPlayer[];
}

export interface WalkerOtdMenuSport {
  sport: DealSport;
  label: string;
  seasons: WalkerOtdMenuSeason[];
}

/** Players from WALKER_OTD_SLICES grouped by sport, then season (slice
 * order preserved, players de-duped per season). */
export function walkerOtdMenu(): WalkerOtdMenuSport[] {
  const sports: WalkerOtdMenuSport[] = [];
  const seenSport = new Map<DealSport, WalkerOtdMenuSport>();
  for (const s of WALKER_OTD_SLICES) {
    let sportGroup = seenSport.get(s.sport);
    if (!sportGroup) {
      const label = DEAL_SPORTS.find((d) => d.id === s.sport)?.label ?? s.sport;
      sportGroup = { sport: s.sport, label, seasons: [] };
      seenSport.set(s.sport, sportGroup);
      sports.push(sportGroup);
    }
    let seasonGroup = sportGroup.seasons.find((g) => g.season === s.season);
    if (!seasonGroup) {
      seasonGroup = {
        season: s.season,
        label: seasonLabel(s.sport, s.season),
        players: [],
      };
      sportGroup.seasons.push(seasonGroup);
    }
    for (const p of s.players) {
      if (seasonGroup.players.some((x) => x.name === p)) continue;
      seasonGroup.players.push({
        name: p,
        key: walkerOtdKey(s.sport, s.season, p),
      });
    }
  }
  return sports;
}

export interface DealFilters {
  sport: DealSport;
  season: number;
  listingTypes: DealListingType[];
  rarities: number[];
  /** Plain player names (norm-matched against the listing player). */
  players?: string[];
  minDiscountPct: number;
  auctionOnly: boolean;
}

export interface Deal {
  listingId: number;
  type: DealListingType;
  rarity: number;
  rarityLabel: string;
  boost: string; // e.g. "Legendary 2" (bulk) or "" (play)
  player: string;
  price: number;
  median: number | null;
  discountPct: number | null;
  /** Rax still collectable from today onward (past seasons only). */
  remaining: number | null;
  endsAt: string | null;
  canBid: boolean;
  url: string;
  isDiscountDeal: boolean;
  isRoiDeal: boolean;
  upside: number;
}

export interface DealsResult {
  deals: Deal[];
  scanned: number;
  lookedUp: number;
  timedOut: boolean;
  elapsedMs: number;
}

/** Lowercase alphanumerics only — "A'ja Wilson" == "Aja Wilson". */
export function normName(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function playerMatches(label: string, queries: string[]): boolean {
  if (!queries.length) return true;
  const nl = normName(label);
  const tokens = label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return queries.some((q) => {
    const nq = normName(q);
    if (!nq) return false;
    if (nl === nq) return true; // full name match ("Ezequiel Tovar")
    // play-card names come abbreviated ("E. Tovar") — last-name match
    return tokens.some((t) => t === nq && nq.length >= 3);
  });
}

export { playerMatches };

export function fmtRax(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString("en-US");
}

/** If a message names a missing/invalid season (Real 400s like "Season not
 * found"), return it trimmed — else null. Lets the scanner abort hard on a
 * bad sport/season slice instead of silently skipping it. */
export function seasonErrorMessage(msg: string): string | null {
  const m = String(msg ?? "").trim();
  if (!m) return null;
  return /season/i.test(m) &&
    /(not found|invalid|doesn.?t exist|no such|not valid|not supported)/i.test(m)
    ? m
    : null;
}

export interface RawListing {
  id: number;
  cardId: number;
  playerId?: number | null;
  entityType?: string;
  rarity: number;
  endsAt?: string | null;
  canBid?: boolean;
  buyNowPrice?: number | null;
  currentBidAmount?: number | null;
  minBidPrice?: number | null;
  card?: {
    label?: string | null;
    entityLabel?: string | null;
    primaryPlayer?: { displayName?: string | null } | null;
    boostInfo?: { rarityLabel?: string | null; level?: number | null } | null;
  } | null;
}

/** Best human player label for a listing. */
export function listingPlayerLabel(l: RawListing): string {
  const c = l.card ?? {};
  if (c.label) return c.label;
  if (c.primaryPlayer?.displayName) return c.primaryPlayer.displayName;
  if (c.entityLabel) return c.entityLabel;
  return `card ${l.cardId}`;
}

export function listingPrice(l: RawListing): number | null {
  if (l.buyNowPrice != null) return Number(l.buyNowPrice);
  if (l.currentBidAmount != null) return Number(l.currentBidAmount);
  if (l.minBidPrice != null) return Number(l.minBidPrice);
  return null;
}

export function boostLabel(l: RawListing): string {
  return l.card?.boostInfo?.rarityLabel ?? "";
}

/** Median FMV from /marketplace/fmv summaryInfo. */
export function parseFmvMedian(data: {
  summaryInfo?: { header?: string; value?: unknown }[];
}): number | null {
  for (const si of data.summaryInfo ?? []) {
    if (si.header === "Median" && si.value != null) {
      const v = Number(String(si.value).replace(/,/g, ""));
      if (!Number.isNaN(v)) return v;
    }
  }
  return null;
}

/** Sum earnings at the card's level; remaining = dates still ahead (US/Eastern). */
export function splitEarnings(
  earnings: { day?: string; atRarityEarnings?: unknown; earnings?: unknown }[],
  nowEt: Date
): { total: number; remaining: number } {
  let total = 0;
  let remaining = 0;
  const todayMd = (nowEt.getMonth() + 1) * 100 + nowEt.getDate();
  for (const e of earnings ?? []) {
    const raw = e.atRarityEarnings ?? e.earnings;
    if (raw == null) continue;
    const v = Number(raw);
    if (Number.isNaN(v)) continue;
    total += v;
    if (e.day) {
      const d = new Date(e.day + "T00:00:00Z");
      if (!Number.isNaN(d.getTime())) {
        const md = (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
        if (md >= todayMd) remaining += v;
      }
    } else {
      remaining += v;
    }
  }
  return { total, remaining };
}
