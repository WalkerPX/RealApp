/**
 * WNBA dashboard builder — who's playing (on the current Real slate) and how
 * good a game they project to have. Mirrors the MLB route's output shape so
 * the shared booster-planning tail in the API route just works.
 *
 * Mapping: Real WNBA team/player ids are NOT ESPN's, so: Real team → ESPN team
 * by name (schedule gives short names like "Sun", ESPN gives "Connecticut
 * Sun"); player pass → ESPN athlete by full name / jersey within that team's
 * roster.
 */

import type { DashboardCard, Game, Team, UserPass } from "./types";
import type { PlayerRole } from "./boost-plan";
import {
  espnBox,
  espnRoster,
  espnScoreboard,
  espnSeasonPra,
  espnTeamsByName,
  wnbaScore,
} from "./wnba";

export interface WnbaOutput {
  day: string;
  cards: DashboardCard[];
  candidates: { passId: number; role: PlayerRole; score: number; boosted?: boolean }[];
}

function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function matchEspnTeam(realName: string, byName: Map<string, number>): number | null {
  const rn = normName(realName);
  if (!rn) return null;
  let best: number | null = null;
  let bestLen = Infinity;
  for (const [key, id] of byName) {
    const kn = normName(key);
    if (!kn) continue;
    if (kn === rn) return id; // exact
    if (kn.includes(rn) && kn.length < bestLen) {
      bestLen = kn.length;
      best = id;
    }
  }
  return best;
}

/** Match an ESPN athlete for a Real pass (same team pool). */
function findEspnAthlete(
  players: Map<number, { id: number; name: string; jersey: string; pos: string; active: boolean }>,
  pass: UserPass
): { id: number; name: string; jersey: string; pos: string; active: boolean } | null {
  const firstName = normName(pass.entity.firstName ?? "");
  const lastName = normName(pass.entity.lastName ?? "");
  const jersey = pass.entity.jersey ? String(pass.entity.jersey) : "";
  let best: (typeof players extends Map<number, infer V> ? V : never) | null = null;
  let bestScore = 0;
  for (const p of players.values()) {
    const full = normName(p.name);
    let score = 0;
    if (lastName && full === `${firstName} ${lastName}`) score = 4;
    else if (
      lastName &&
      (full === lastName || full.endsWith(` ${lastName}`)) &&
      (!firstName || full.startsWith(firstName[0]))
    )
      score = 3;
    else if (jersey && p.jersey === jersey) score = 2;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return bestScore >= 2 ? best : null;
}

export async function buildWnbaDashboard(
  passes: UserPass[],
  realSched: { day: string; games: Game[] },
  isSelf: boolean
): Promise<WnbaOutput> {
  const cards: DashboardCard[] = [];
  const candidates: WnbaOutput["candidates"] = [];
  const games = realSched.games;

  // Real team ids that play this slate.
  const realTeamIds = new Set<number>();
  for (const g of games) {
    realTeamIds.add(g.homeTeamId);
    realTeamIds.add(g.awayTeamId);
  }
  const ownedTeams = new Set(
    passes.map((p) => (p.entityType === "team" ? p.entity.id : p.entity.teamId ?? 0))
  );
  const wantedReal = [...realTeamIds].filter((t) => ownedTeams.has(t));
  if (!wantedReal.length) return { day: realSched.day, cards, candidates };

  // ESPN team map + slate (same day; ESPN uses its own date grouping).
  const espnByName = await espnTeamsByName();
  const espnDate = realSched.day.replace(/-/g, "");
  const espnGames = await espnScoreboard(espnDate);
  const espnStatus = new Map<number, string>(); // espn teamId -> status
  const espnEvent = new Map<number, number>(); // espn teamId -> event id
  for (const eg of espnGames) {
    espnStatus.set(eg.homeTeamId, eg.status);
    espnStatus.set(eg.awayTeamId, eg.status);
    espnEvent.set(eg.homeTeamId, eg.gamePk);
    espnEvent.set(eg.awayTeamId, eg.gamePk);
  }

  // Real team -> espn team (by name from the Real schedule objects).
  const realToEspn = new Map<number, number>();
  for (const g of games) {
    for (const [rid, team] of [
      [g.homeTeamId, g.homeTeam],
      [g.awayTeamId, g.awayTeam],
    ] as [number, Team][]) {
      if (!wantedReal.includes(rid) || realToEspn.has(rid)) continue;
      const eid = matchEspnTeam(team.displayName || team.name || "", espnByName);
      if (eid != null && espnStatus.has(eid)) realToEspn.set(rid, eid);
    }
  }

  type Pool = {
    players: Map<number, { id: number; name: string; jersey: string; pos: string; active: boolean }>;
    played: Set<number>;
    started: boolean; // live/final with a real boxscore
  };
  const pools = new Map<number, Pool>();
  for (const [rid, eid] of realToEspn) {
    const status = espnStatus.get(eid) ?? "STATUS_SCHEDULED";
    if (status.includes("POSTPONED") || status.includes("CANCELLED")) continue;
    const started = !status.includes("SCHEDULED") && !status.includes("PRE");
    if (started) {
      const eventId = espnEvent.get(eid)!;
      const box = await espnBox(eventId);
      const played = box?.played.get(eid) ?? new Set<number>();
      if (box && played.size > 0) {
        pools.set(rid, {
          players: box.players.get(eid) ?? new Map(),
          played,
          started: true,
        });
        continue;
      }
    }
    // Scheduled (or live but no box yet): active roster projection.
    const roster = await espnRoster(eid);
    const active = new Map<number, (typeof roster extends Map<number, infer V> ? V : never)>();
    for (const [id, p] of roster) if (p.active) active.set(id, p);
    pools.set(rid, { players: active, played: new Set(), started: false });
  }

  const praCache = new Map<number, number | null>();

  for (const pass of passes) {
    const rid = pass.entityType === "team" ? pass.entity.id : (pass.entity.teamId ?? 0);
    const realGame = games.find(
      (g) => g.homeTeamId === rid || g.awayTeamId === rid
    );
    const opponent = realGame
      ? realGame.homeTeamId === rid
        ? realGame.awayTeam
        : realGame.homeTeam
      : null;
    const pool = pools.get(rid);
    if (!pool) continue;

    if (pass.entityType === "team") {
      cards.push({ pass, game: realGame ?? null, opponent, role: "team", score: null, lineupTbd: false, suggestedBooster: null });
      continue;
    }

    const injury = pass.entity.injuryStatus?.toLowerCase();
    if (injury && injury !== "active" && injury !== "available") continue;

    const ath = findEspnAthlete(pool.players, pass);
    if (!ath) continue;

    let projected: boolean;
    let lineupTbd: boolean;
    if (pool.started) {
      projected = pool.played.has(ath.id);
      lineupTbd = pool.played.size === 0;
    } else {
      projected = true; // active roster on a scheduled slate
      lineupTbd = true;
    }
    if (!projected) continue;

    if (!praCache.has(ath.id)) praCache.set(ath.id, await espnSeasonPra(ath.id));
    const score = wnbaScore(praCache.get(ath.id) ?? null);
    cards.push({
      pass,
      game: realGame ?? null,
      opponent,
      role: "hitter",
      score,
      lineupTbd,
      suggestedBooster: null,
    });
    if (isSelf) {
      candidates.push({
        passId: pass.id,
        role: "hitter",
        score,
        boosted: pass.boostInfo.isCardBoosted === true,
      });
    }
  }

  return { day: realSched.day, cards, candidates };
}
