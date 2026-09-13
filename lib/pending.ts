/**
 * Pending (uncredited) rax — what today's games have earned so far and will
 * land at the next 07:00 ET payout.
 *
 * Real credits PLAYER card performance rax as a single daily lump at 07:00 ET
 * for the *previous* day (`/virtualcurrencyfeed` → `userpassearnings`,
 * `day:"YYYY-MM-DD"`), so the app shows nothing for the current day. Team cards
 * post live, per game; player cards have to be recomputed from live box scores.
 *
 * The formula below was fitted against Real's own settled day breakdowns
 * (`/userpassearnings/day/<day>`, last ~3 days only) and reproduces them
 * exactly — 154/154 card-days across MLB/WNBA/NBA/NFL/CFB/soccer — plus
 * realapp.tools' independently computed MLB rows.
 *
 *   perfRax   = round(boxScore.value × RATING_TO_RAX[sport])
 *   cardMult  = CARD_MULT[pass.boostInfo.level]
 *   boostMult = BOOSTER_MULT[pass.boosterCardInfo.rarity]   (0 when no booster)
 *   statBoost = statValue(boxScore, boosterCardInfo.statBoostKey)
 *               × booster rate for (booster rarity, statBoostKey)
 *   total     = round(perfRax × (cardMult + boostMult) + statBoost)
 *
 * `boostInfo.multiplier` (e.g. "35x · RUYDS") is cardMult + boostMult, so the
 * two can be sanity-checked against what the card itself displays.
 *
 * PACING: reading a day costs one request per game, and Real 429s hard
 * ("high volume") when that fan-out is fast — a single 429 then poisons every
 * later call, which silently blanks whole sports. So: strictly one request at a
 * time through a gate, a long gap between them, and a wall-clock budget per
 * load. Whatever can't be read inside the budget is reported as `deferred` and
 * picked up by the next load, because per-game box scores are cached for
 * minutes — loads converge instead of restarting. Slowness is fine; errors
 * are not.
 */

import {
  getBoosterInventory,
  getGamePlayerBoxScores,
  getTodaysSchedule,
  getUserPasses,
  type PlayerBoxScore,
} from "./real-api";
import { earningsDay } from "./earnings";
import type { Game, Sport, UserPass } from "./types";

/** Season whose passes carry live boosts — every sport keys by starting year. */
const BOOST_SEASONS: Record<string, number> = {
  mlb: 2026,
  wnba: 2026,
  cfb: 2026,
  nfl: 2026,
  fc: 2026,
};

const SPORTS: { id: Sport; label: string }[] = [
  { id: "mlb", label: "MLB" },
  { id: "wnba", label: "WNBA" },
  { id: "cfb", label: "CFB" },
  { id: "nfl", label: "NFL" },
  { id: "fc", label: "FC" },
];

/** Card multiplier by boost level (General, Common, Uncommon, Rare, Epic,
 * Legendary 1-3). Cross-checked against `atRarityEarnings / earnings`. */
const CARD_MULT: Record<number, number> = { 0: 0, 1: 2, 2: 3, 3: 4, 4: 10, 5: 25, 6: 28, 7: 32 };

/** Booster multiplier by booster rarity (Rare / Epic / Legendary). */
const BOOSTER_MULT: Record<number, number> = { 3: 10, 4: 15, 5: 25 };

/** Rax per Real-Rating point, keyed by the sport string Real returns on a pass
 * ("ncaaf"/"soccer", not the app's "cfb"/"fc" tab ids). Pitchers sit on a
 * different rating scale than hitters. */
const RATING_TO_RAX: Record<string, number> = {
  mlb: 2,
  wnba: 2,
  nba: 2,
  ncaaf: 5,
  nfl: 5,
  soccer: 3.5,
};
const PITCHER_K = 3;

/** Real's sport key → the app's tab id. */
const SPORT_ALIAS: Record<string, string> = { ncaaf: "cfb", soccer: "fc" };

const PITCHER_POS = new Set(["P", "SP", "RP"]);

function ratingToRax(sport: string, position?: string | null): number {
  if (sport === "mlb") {
    return PITCHER_POS.has((position ?? "").toUpperCase()) ? PITCHER_K : RATING_TO_RAX.mlb;
  }
  return RATING_TO_RAX[sport] ?? 2;
}

function tabIdOf(sport: string): string {
  return SPORT_ALIAS[sport] ?? sport;
}

export interface PendingCardRow {
  passId: number;
  entityId: number;
  label: string;
  sport: string;
  sportLabel: string;
  position?: string | null;
  opponent?: string | null;
  gameStatus?: string | null;
  rarityLabel?: string | null;
  /** Real Rating for today's game so far. */
  rating: number;
  /** Base performance rax before multipliers. */
  perfRax: number;
  cardMult: number;
  boosterMult: number;
  /** Booster stat line that added rax, e.g. { label: "RUYDS", value: 114, boost: 57 }. */
  statBoost: { label: string; value: number; rate: number; amount: number } | null;
  /** rax that will land at the next 07:00 ET payout. */
  total: number;
}

export interface PendingSportRow {
  sport: string;
  label: string;
  total: number;
  cards: PendingCardRow[];
}

export interface PendingResponse {
  /** Real's eastern day the pending rax belongs to. */
  day: string;
  /** ISO timestamp of this snapshot — games in progress keep accruing. */
  generatedAt: string;
  total: number;
  cards: number;
  sports: PendingSportRow[];
  /** Cards whose player is on today's slate but hasn't appeared yet. */
  awaiting: number;
  payout: string;
  cached: boolean;
  /** True when the request ran out of its time budget with games still to read. */
  partial: boolean;
  /** Games still to read — a follow-up load continues from here. */
  deferred: number;
  /** Per-sport source trace, for when a sport comes back empty. */
  debug: string[];
}

// ── pacing ───────────────────────────────────────────────────
/** One request at a time, this far apart. Deliberately slow: a 429 is sticky
 * and blanks whole sports, so waiting beats retrying. */
const MIN_GAP_MS = 600;
/** Wall-clock budget for reading box scores in one load. Vercel's function
 * limit is the only hard ceiling; this stays well under it and hands the rest
 * to the next load. */
const TIME_BUDGET_MS = 40_000;
const BOX_TTL = 5 * 60_000;
const SLATE_TTL = 5 * 60_000;
const RATES_TTL = 6 * 60 * 60_000;
/** Short-lived whole-response cache so a double-click doesn't refetch. */
const RESPONSE_TTL = 20_000;

let gate: Promise<void> = Promise.resolve();
let lastStart = 0;

/** Serializes every Real call in this module through one slow queue. */
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const slot = gate.then(async () => {
    const wait = lastStart + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastStart = Date.now();
  });
  gate = slot.catch(() => undefined);
  return slot.then(fn);
}

/** Retries only on 429, and only a couple of times. If it still 429s we stop
 * and surface the error rather than piling more requests on. */
async function paced<T>(fn: () => Promise<T>, tries = 2): Promise<T> {
  let delay = 3_000;
  for (let i = 0; ; i++) {
    try {
      return await throttled(fn);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (i >= tries - 1 || !msg.includes("429")) throw e;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

// ── caches ───────────────────────────────────────────────────
const ratesCache = new Map<string, { at: number; rates: Record<string, number> }>();
const slateCache = new Map<string, { at: number; day: string; games: Game[] }>();
const boxCache = new Map<number, { at: number; rows: PlayerBoxScore[] }>();

function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  // Some stats arrive as strings, e.g. "6/9" (h/ab).
  const n = parseFloat(String(v ?? "").split("/")[0]);
  return Number.isFinite(n) ? n : 0;
}

/** (booster rarity | statBoostKey) → rax per stat unit, straight from Real's
 * own booster inventory (per sport). One call per sport per six hours. */
async function boosterRates(passId: number, sport: Sport): Promise<Record<string, number>> {
  const hit = ratesCache.get(sport);
  if (hit && hit.at > Date.now()) return hit.rates;
  const inv = await paced(() => getBoosterInventory(passId, sport));
  const rates: Record<string, number> = {};
  for (const g of inv.rarityGroups ?? []) {
    for (const row of g.statBoostKeyInfo ?? []) {
      // A key can carry several stats ("HR · 3B") — each contributes.
      for (const info of row.info ?? []) {
        rates[`${g.rarity}|${row.statBoostKey}`] = Number(info.boostValue) || 0;
      }
    }
  }
  ratesCache.set(sport, { at: Date.now() + RATES_TTL, rates });
  return rates;
}

/** Today's slate for a sport, cached for minutes. */
async function slate(sport: Sport): Promise<{ day: string; games: Game[] }> {
  const hit = slateCache.get(sport);
  if (hit && hit.at > Date.now()) return hit;
  const sched = await paced(() => getTodaysSchedule(sport));
  const entry = { at: Date.now() + SLATE_TTL, day: sched.day, games: sched.games ?? [] };
  slateCache.set(sport, entry);
  return entry;
}

/** Per-game box scores, cached so a follow-up load never refetches a game —
 * this is what makes a budget-limited load resumable instead of a restart. */
async function gameBox(sport: Sport, gameId: number): Promise<PlayerBoxScore[]> {
  const hit = boxCache.get(gameId);
  if (hit && hit.at > Date.now()) return hit.rows;
  const rows = await paced(() => getGamePlayerBoxScores(sport, gameId));
  boxCache.set(gameId, { at: Date.now() + BOX_TTL, rows });
  return rows;
}

/** A booster statBoostKey can be a compound like "2_11" (HR · 3B) — every part
 * contributes, so sum the matching box score stats. */
function statBoostFor(
  bs: PlayerBoxScore,
  statKey: string | undefined,
  rates: Record<string, number>,
  rarity: number
): PendingCardRow["statBoost"] {
  if (!statKey) return null;
  let value = 0;
  let rate = 0;
  const labels: string[] = [];
  for (const part of statKey.split("_")) {
    const r = rates[`${rarity}|${part}`] ?? rates[`${rarity}|${statKey}`] ?? 0;
    const stat = (bs.statValues ?? []).find((s) => String(s.type) === String(part));
    if (!stat) continue;
    value += num(stat.value);
    rate += r;
    if (stat.label) labels.push(stat.label.toUpperCase());
  }
  const amount = value * rate;
  if (!amount) return null;
  return { label: labels.join(" · ") || statKey, value, rate, amount };
}

function scoreCard(
  bs: PlayerBoxScore,
  pass: UserPass,
  rates: Record<string, number>,
  game: { opponent: string | null; status: string | null }
): PendingCardRow | null {
  const sport = String(pass.sport ?? "");
  const value = num(bs.value);
  const perfRax = Math.round(value * ratingToRax(sport, pass.infoDetail ?? bs.position));
  const cardMult = CARD_MULT[pass.boostInfo?.level ?? 0] ?? 0;
  const rarity = Number(pass.boosterCardInfo?.rarity ?? 0);
  const boosterMult = BOOSTER_MULT[rarity] ?? 0;
  const statBoost = statBoostFor(bs, pass.boosterCardInfo?.statBoostKey, rates, rarity);
  const total = Math.round(perfRax * (cardMult + boosterMult) + (statBoost?.amount ?? 0));
  if (!total) return null;
  return {
    passId: pass.id,
    entityId: pass.entityId,
    label: pass.label,
    sport,
    sportLabel: SPORTS.find((s) => s.id === tabIdOf(sport))?.label ?? sport.toUpperCase(),
    position: pass.infoDetail ?? bs.position ?? null,
    opponent: game.opponent,
    gameStatus: game.status,
    rarityLabel: pass.boostInfo?.rarityLabel ?? null,
    rating: Math.round(value * 1000) / 1000,
    perfRax,
    cardMult,
    boosterMult,
    statBoost,
    total,
  };
}

function gameForTeam(games: Game[], teamId: number): Game | undefined {
  return games.find((g) => g.homeTeamId === teamId || g.awayTeamId === teamId);
}

function opponentOf(game: Game | undefined, teamId: number): string | null {
  if (!game) return null;
  const t = game.homeTeamId === teamId ? game.awayTeam : game.homeTeam;
  return t?.displayName || t?.name || null;
}

let responseCache: { at: number; day: string; data: PendingResponse } | null = null;

/** Reset the caches — used by the "Refresh" button's force path for the
 * response cache only; box scores are deliberately kept so a reload resumes
 * instead of restarting. */
export function clearPendingResponseCache(): void {
  responseCache = null;
}

/** Everything the Pending tab needs. Loads are resumable: anything the time
 * budget cuts off comes back as `deferred` and the next call picks it up from
 * the box-score cache. */
export async function buildPending(
  userId: string,
  opts: { day?: string; force?: boolean } = {}
): Promise<PendingResponse> {
  if (!opts.force && responseCache && responseCache.at > Date.now()) {
    return { ...responseCache.data, cached: true };
  }

  const deadline = Date.now() + TIME_BUDGET_MS;
  const today = earningsDay();
  const sports: PendingSportRow[] = [];
  const debug: string[] = [];
  let awaiting = 0;
  let deferred = 0;
  let day = opts.day ?? today;

  for (const { id: sport, label } of SPORTS) {
    if (Date.now() > deadline) {
      debug.push(`${label}: skipped — out of time budget`);
      continue;
    }

    let passes: UserPass[] = [];
    try {
      passes = (
        await paced(() =>
          getUserPasses(userId, sport, BOOST_SEASONS[sport] ?? new Date().getFullYear())
        )
      ).filter((p) => p.entityType === "player");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      debug.push(`${label}: passes failed — ${msg}`);
      if (msg.includes("429")) throw e;
      continue;
    }
    if (passes.length === 0) {
      debug.push(`${label}: no player passes`);
      continue;
    }

    let rates: Record<string, number> = {};
    try {
      rates = await boosterRates(passes[0].id, sport);
    } catch (e) {
      debug.push(
        `${label}: booster table failed — ${e instanceof Error ? e.message : String(e)}`
      );
    }

    const teamIds = new Set(passes.map((p) => p.entity?.teamId ?? 0).filter((id) => id > 0));
    if (teamIds.size === 0) {
      debug.push(`${label}: ${passes.length} passes but no team ids`);
      continue;
    }

    let slateDay = "";
    let games: Game[] = [];
    try {
      const s = await slate(sport);
      slateDay = s.day;
      // "Pending" means today's games. Real's slate can point past today (NFL on
      // a Saturday returns Sunday's card), and a game that hasn't started has no
      // box score to read — skipping both keeps the fan-out small.
      const now = Date.now();
      games = s.games.filter((g) => {
        const gd = g.day || s.day;
        if (gd && gd !== today) return false;
        if (g.dateTime && Date.parse(g.dateTime) > now) return false;
        return teamIds.has(g.homeTeamId) || teamIds.has(g.awayTeamId);
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      debug.push(`${label}: slate failed — ${msg}`);
      if (msg.includes("429")) throw e;
      continue;
    }

    if (games.length === 0) {
      debug.push(`${label}: no games today involving your teams (slate ${slateDay})`);
      continue;
    }

    const box = new Map<string, PlayerBoxScore>();
    const failures: string[] = [];
    let stillToRead = 0;

    // Strictly one game at a time, and only while there's budget left.
    for (const g of games) {
      const cached = boxCache.get(g.id);
      if (!cached || cached.at <= Date.now()) {
        if (Date.now() > deadline) {
          stillToRead += 1;
          continue;
        }
      }
      try {
        for (const b of await gameBox(sport, g.id)) {
          if (b.didNotPlay) continue;
          box.set(String(b.playerId), b);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failures.push(`${g.id}: ${msg}`);
        if (msg.includes("429")) {
          deferred += 1;
          break; // stop this sport rather than hammer a throttled API
        }
      }
    }
    deferred += stillToRead;

    if (box.size === 0) {
      debug.push(
        `${label}: ${games.length} games today with your teams, no box scores read yet` +
          (stillToRead ? ` (${stillToRead} deferred)` : "")
      );
      for (const f of failures.slice(0, 2)) debug.push(`${label} error ${f}`);
      continue;
    }

    const cards: PendingCardRow[] = [];
    for (const p of passes) {
      const bs = box.get(String(p.entityId));
      if (!bs) {
        if (p.entity?.teamId && gameForTeam(games, p.entity.teamId)) awaiting += 1;
        continue;
      }
      const teamId = bs.teamId || p.entity?.teamId || 0;
      const row = scoreCard(bs, p, rates, {
        opponent: opponentOf(gameForTeam(games, teamId), teamId),
        status: gameForTeam(games, teamId)?.status ?? null,
      });
      if (row) cards.push(row);
    }

    if (cards.length === 0) {
      debug.push(`${label}: ${box.size} box scores but no scoring cards`);
      continue;
    }
    debug.push(
      `${label}: ${passes.length} passes · ${games.length} games · ${box.size} box scores → ` +
        `${cards.length} cards${stillToRead ? ` (${stillToRead} games deferred)` : ""}`
    );
    cards.sort((a, b) => b.total - a.total);
    sports.push({ sport, label, total: cards.reduce((a, c) => a + c.total, 0), cards });
  }

  sports.sort((a, b) => b.total - a.total);
  const data: PendingResponse = {
    day,
    generatedAt: new Date().toISOString(),
    total: sports.reduce((a, s) => a + s.total, 0),
    cards: sports.reduce((a, s) => a + s.cards.length, 0),
    sports,
    awaiting,
    payout: "07:00 ET",
    cached: false,
    partial: deferred > 0,
    deferred,
    debug,
  };
  // Only cache a complete pass — a partial one should keep filling in.
  if (!data.partial) responseCache = { at: Date.now() + RESPONSE_TTL, day, data };
  return data;
}
