/** Optimal OTD — pick the K cards whose On-This-Day claims earn the most rax.
 *
 * Rules the model encodes (all verified against Real):
 *   - a card claims on the same month-day every year, so its claim calendar is
 *     a set of 366 month-days with an amount on each;
 *   - you get at most 2 claims per sport per day, so only the two best cards of
 *     a sport count towards that day's total;
 *   - card amounts scale linearly with the card's level, so the winning SET is
 *     the same at every rarity/level — only the reported numbers change.
 *
 * Objective: maximise, over the 366 month-days, the sum of each sport's top-two
 * card values. Plain greedy on that (submodular) objective, then swap-based
 * local search, lands on the optimum in practice.
 */
import { OTD_DATA } from "./otd-optimal-data";
import {
  OTD_BUDGET_ASOF,
  OTD_BUDGET_DATA,
  OTD_BUDGET_META,
} from "./otd-budget-data";
import { LEVEL_MULT, RARITY_TIERS, LINEUP_SIZES } from "./otd-levels";

export { LEVEL_MULT, RARITY_TIERS, LINEUP_SIZES };

const DIM = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const MONTH_DAYS: string[] = (() => {
  const out: string[] = [];
  DIM.forEach((n, m) => {
    for (let d = 1; d <= n; d++) {
      out.push(`${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
  });
  return out;
})();
const DAYS = MONTH_DAYS.length;

interface RawSport {
  label: string;
  cards: [string, number, number, [number, number][]][];
}
const RAW = JSON.parse(OTD_DATA) as Record<string, RawSport>;

export interface OtdSportMeta {
  id: string;
  label: string;
  cards: number;
  seasonList: number[];
}

export const OTD_SPORTS: OtdSportMeta[] = Object.entries(RAW)
  .map(([id, v]) => ({
    id,
    label: v.label,
    cards: v.cards.length,
    seasonList: Array.from(new Set(v.cards.map((c) => c[1]))).sort((a, b) => a - b),
  }))
  .sort((a, b) => b.cards - a.cards);

export function sportLabel(id: string): string {
  return RAW[id]?.label ?? id.toUpperCase();
}

export function seasonLabel(sport: string, season: number): string {
  // CBB (ncaam) cards are keyed by ending year; everyone else by starting year.
  if (sport === "ncaam" || sport === "nba") {
    return `${season - 1}-${String(season % 100).padStart(2, "0")}`;
  }
  return `${season}-${String((season % 100) + 1).padStart(2, "0")}`;
}

// ── budget filter ────────────────────────────────────────────
// "Budget" lines a lineup up with what can actually be bought: a card only
// qualifies if it has MULTIPLE (>= 2) live marketplace listings at or under
// `maxRpr` rax per rating point. Prices are a SNAPSHOT (see BUDGET_ASOF) —
// marketplace listings turn over within hours, so this is a guide, not a
// guarantee at the moment of purchase.
type BudgetSport = Record<string, Record<string, [number, (string | number)[]]>>;
const BUDGET = JSON.parse(OTD_BUDGET_DATA) as Record<string, BudgetSport>;

export const BUDGET_ASOF = OTD_BUDGET_ASOF;
export const BUDGET_META = OTD_BUDGET_META;

/** Sports whose marketplace depth has been swept. */
export function budgetSports(): string[] {
  return Object.keys(BUDGET).filter((s) => BUDGET[s] && Object.keys(BUDGET[s]).length);
}

/** Cheap listings this exact card has at or under `maxRpr` rax/rating.
 * Only the cheapest 20 values are stored, which is exact for any threshold:
 * either the count is under 20 (exact) or it is already >= 2 (all we ask). */
export function budgetCheapListings(
  sport: string,
  season: number,
  playerId: number,
  maxRpr: number
): number {
  const row = BUDGET[sport]?.[String(season)]?.[String(playerId)];
  if (!row) return 0;
  let n = 0;
  for (const v of row[1]) if (Number(v) <= maxRpr) n++;
  return n;
}

/** Total live listings this card had at sweep time. */
export function budgetListingCount(
  sport: string,
  season: number,
  playerId: number
): number {
  return BUDGET[sport]?.[String(season)]?.[String(playerId)]?.[0] ?? 0;
}

/** A card is budget-eligible when it has at least two cheap listings — one
 * cheap listing is not enough to actually get the card. */
export function budgetEligible(
  sport: string,
  season: number,
  playerId: number,
  maxRpr: number
): boolean {
  return budgetCheapListings(sport, season, playerId, maxRpr) >= 2;
}

/** Flat, solver-friendly view of every card. */
interface Card {
  sport: string;
  name: string;
  season: number;
  playerId: number;
  days: Int16Array; // 366, base rax (0 = no claim that month-day)
  yearTotal: number;
  /** Month-days the card has any claim at all (its season's games). */
  seasonDays: number;
}

let CACHE: Card[] | null = null;
function allCards(): Card[] {
  if (CACHE) return CACHE;
  const out: Card[] = [];
  for (const [sport, v] of Object.entries(RAW)) {
    for (const [name, season, playerId, pairs] of v.cards) {
      const days = new Int16Array(DAYS);
      let total = 0;
      let played = 0;
      for (const [i, val] of pairs) {
        days[i] = val;
        total += val;
        if (val > 0) played++;
      }
      out.push({ sport, name, season, playerId, days, yearTotal: total, seasonDays: played });
    }
  }
  CACHE = out;
  return out;
}

/** Per sport, the second-highest card value on each month-day. Adding a card
 * with value v to a set raises that day's top-two sum by max(0, v - second). */
function seconds(sports: string[], set: Card[]): Map<string, Int16Array> {
  const out = new Map<string, Int16Array>();
  for (const s of sports) out.set(s, new Int16Array(DAYS));
  const big = new Map<string, Int16Array>();
  for (const s of sports) big.set(s, new Int16Array(DAYS));
  for (const c of set) {
    const second = out.get(c.sport);
    const first = big.get(c.sport);
    if (!second || !first) continue;
    for (let i = 0; i < DAYS; i++) {
      const v = c.days[i];
      if (v > first[i]) {
        second[i] = first[i];
        first[i] = v;
      } else if (v > second[i]) {
        second[i] = v;
      }
    }
  }
  return out;
}

/** Top-two sum per sport per month-day, totalled. */
function objective(sports: string[], set: Card[]): number {
  let total = 0;
  for (const s of sports) {
    const cards = set.filter((c) => c.sport === s);
    if (!cards.length) continue;
    const big = new Int16Array(DAYS);
    const second = new Int16Array(DAYS);
    for (const c of cards) {
      for (let i = 0; i < DAYS; i++) {
        const v = c.days[i];
        if (v > big[i]) {
          second[i] = big[i];
          big[i] = v;
        } else if (v > second[i]) {
          second[i] = v;
        }
      }
    }
    for (let i = 0; i < DAYS; i++) total += big[i] + second[i];
  }
  return total;
}

export interface OtdClaim {
  sport: string;
  name: string;
  season: number;
  playerId: number;
  value: number;
}

export interface OtdCardRow {
  sport: string;
  sportLabel: string;
  name: string;
  season: number;
  playerId: number;
  /** Base rax this card is actually claimed for over a year. */
  contribBase: number;
  /** Month-days where it wins one of its sport's two daily claims. */
  claimedDays: number;
  /** Month-days it has any claim at all (i.e. its season's games). */
  seasonDays: number;
  /** Live listings at or under the budget ceiling (null when budget is off). */
  budgetListings: number | null;
  /** Total live listings, whatever the price (null when budget is off). */
  budgetTotal: number | null;
}

export interface OtdSolution {
  sports: string[];
  /** Requested lineup size — per sport when `perSport` is set. */
  k: number;
  /** true = k cards for EACH selected sport; false = k cards in total. */
  perSport: boolean;
  /** Rax-per-rating ceiling when the budget filter is on, else null. */
  budget: number | null;
  /** Sports dropped because no marketplace depth has been swept for them. */
  budgetExcluded: string[];
  /** Cards that passed the budget filter (0 when the filter is off). */
  budgetPool: number;
  /** When the marketplace depth snapshot was taken. */
  budgetAsof: string | null;
  /** Cards actually selected (k × sports when per-sport). */
  totalCards: number;
  totalBase: number;
  cards: OtdCardRow[];
  /** month-day -> that day's total base rax from the lineup. */
  byDay: Record<string, number>;
  /** month-day -> who earned it that day. */
  dayClaims: Record<string, OtdClaim[]>;
}

/** Greedy + swap local search over one pool. `sportList` is the set of sports
 * the objective sums over — the whole selection in total mode, a single sport
 * when solving per sport. */
function solvePool(sportList: string[], pool: Card[], k: number): Card[] {
  const set: Card[] = [];
  for (let step = 0; step < k && set.length < pool.length; step++) {
    const t2 = seconds(sportList, set);
    let bestGain = 0;
    let bestCard: Card | null = null;
    for (const c of pool) {
      if (set.includes(c)) continue;
      const t = t2.get(c.sport)!;
      let g = 0;
      for (let i = 0; i < DAYS; i++) {
        const v = c.days[i];
        if (v > t[i]) g += v - t[i];
      }
      if (g > bestGain) {
        bestGain = g;
        bestCard = c;
      }
    }
    if (!bestCard) break;
    set.push(bestCard);
  }

  let current = objective(sportList, set);
  for (let pass = 0; pass < 40; pass++) {
    let improved = false;
    for (let r = 0; r < set.length; r++) {
      const rest = set.filter((_, i) => i !== r);
      const t2 = seconds(sportList, rest);
      let bestGain = 0;
      let bestCard: Card | null = null;
      for (const c of pool) {
        if (set.includes(c)) continue;
        const t = t2.get(c.sport)!;
        let g = 0;
        for (let i = 0; i < DAYS; i++) {
          const v = c.days[i];
          if (v > t[i]) g += v - t[i];
        }
        if (g > bestGain) {
          bestGain = g;
          bestCard = c;
        }
      }
      if (bestCard) {
        const cand = [...rest, bestCard];
        const val = objective(sportList, cand);
        if (val > current) {
          set.length = 0;
          set.push(...cand);
          current = val;
          improved = true;
          break;
        }
      }
    }
    if (!improved) break;
  }
  return set;
}

export function solveOtd(
  sports: string[] | null,
  k: number,
  perSport = false,
  budget: number | null = null
): OtdSolution {
  const cards = allCards();
  let active = (sports && sports.length ? sports : OTD_SPORTS.map((s) => s.id)).filter(
    (s) => RAW[s]
  );

  // Budget drops any sport whose marketplace depth hasn't been swept — a sport
  // with no price data can't honour the filter, and silently ignoring it would
  // put unbuyable cards in a "budget" lineup.
  let excluded: string[] = [];
  if (budget != null) {
    const swept = new Set(budgetSports());
    excluded = active.filter((s) => !swept.has(s));
    active = active.filter((s) => swept.has(s));
  }
  const eligible = (c: Card) =>
    budget == null || budgetEligible(c.sport, c.season, c.playerId, budget);

  // The objective is separable by sport — each sport keeps its own two claims a
  // day and never competes with another sport for them — so "k cards per sport"
  // is exactly k independent single-sport solves. No interaction to trade off.
  let set: Card[];
  if (perSport) {
    set = [];
    for (const s of active) {
      const sportPool = cards.filter((c) => c.sport === s && eligible(c));
      set.push(...solvePool([s], sportPool, k));
    }
  } else {
    const pool = cards.filter((c) => active.includes(c.sport) && eligible(c));
    set = solvePool(active, pool, k);
  }
  const budgetPool = budget == null ? 0 : cards.filter(
    (c) => active.includes(c.sport) && eligible(c)
  ).length;

  // Accounting: each month-day, the two best cards of each sport claim.
  const byDay: Record<string, number> = {};
  const dayClaims: Record<string, OtdClaim[]> = {};
  const contrib = new Map<Card, number>();
  const claimDays = new Map<Card, number>();
  for (const c of set) {
    contrib.set(c, 0);
    claimDays.set(c, 0);
  }
  let total = 0;
  for (let i = 0; i < DAYS; i++) {
    const md = MONTH_DAYS[i];
    let dayTotal = 0;
    const claims: OtdClaim[] = [];
    for (const s of active) {
      const contenders = set.filter((c) => c.sport === s && c.days[i] > 0);
      if (!contenders.length) continue;
      contenders.sort((a, b) => b.days[i] - a.days[i]);
      for (const c of contenders.slice(0, 2)) {
        const v = c.days[i];
        contrib.set(c, (contrib.get(c) ?? 0) + v);
        claimDays.set(c, (claimDays.get(c) ?? 0) + 1);
        dayTotal += v;
        claims.push({ sport: s, name: c.name, season: c.season, playerId: c.playerId, value: v });
      }
    }
    if (dayTotal > 0) {
      byDay[md] = dayTotal;
      dayClaims[md] = claims;
      total += dayTotal;
    }
  }

  const rows: OtdCardRow[] = set
    .map((c) => ({
      sport: c.sport,
      sportLabel: sportLabel(c.sport),
      name: c.name,
      season: c.season,
      playerId: c.playerId,
      contribBase: contrib.get(c) ?? 0,
      claimedDays: claimDays.get(c) ?? 0,
      seasonDays: c.seasonDays,
      budgetListings:
        budget == null ? null : budgetCheapListings(c.sport, c.season, c.playerId, budget),
      budgetTotal:
        budget == null ? null : budgetListingCount(c.sport, c.season, c.playerId),
    }))
    .sort((a, b) => b.contribBase - a.contribBase);

  return {
    sports: active,
    k,
    perSport,
    budget,
    budgetExcluded: excluded,
    budgetPool,
    budgetAsof: budget == null ? null : BUDGET_ASOF,
    totalCards: set.length,
    totalBase: total,
    cards: rows,
    byDay,
    dayClaims,
  };
}
