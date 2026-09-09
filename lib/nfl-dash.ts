/**
 * NFL dashboard builder — who's playing (on the current Real slate) and how
 * good a game they project to have. Mirrors the CFB builder's output shape so
 * the shared booster-planning tail in the API route just works.
 *
 * Mapping: Real NFL team ids are NOT ESPN's, so: Real team → ESPN team by
 * abbreviation, full display name, or unambiguous short name ("Chiefs" →
 * "Kansas City Chiefs", resolved against the slate); player pass → ESPN
 * athlete by full name / jersey within that team's active roster.
 */

import type { DashboardCard, Game, Team, UserPass } from "./types";
import type { PlayerRole } from "./boost-plan";
import { normName } from "./espn";
import {
  espnAthleteTotals,
  espnBox,
  espnRoster,
  espnScoreboard,
  espnTeamGamesPlayed,
  espnTeamsByAbbrev,
  espnTeamsByName,
  nflScore,
} from "./nfl";

export interface NflOutput {
  day: string;
  cards: DashboardCard[];
  candidates: { passId: number; role: PlayerRole; score: number; boosted?: boolean }[];
}

function findEspnAthlete(
  players: Map<number, { id: number; name: string; jersey: string; pos: string }>,
  pass: UserPass
): { id: number; name: string; jersey: string; pos: string } | null {
  const firstName = normName(pass.entity.firstName ?? "");
  const lastName = normName(pass.entity.lastName ?? "");
  const jersey = pass.entity.jersey ? String(pass.entity.jersey) : "";
  let best: { id: number; name: string; jersey: string; pos: string } | null = null;
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

export async function buildNflDashboard(
  passes: UserPass[],
  realSched: { day: string; games: Game[] },
  isSelf: boolean
): Promise<NflOutput> {
  const cards: DashboardCard[] = [];
  const candidates: NflOutput["candidates"] = [];
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

  const espnDate = realSched.day.replace(/-/g, "");
  const [byAbbrev, byName, espnGames] = await Promise.all([
    espnTeamsByAbbrev(),
    espnTeamsByName(),
    espnScoreboard(espnDate),
  ]);

  const espnStatus = new Map<number, string>(); // espn teamId -> status
  const espnEvent = new Map<number, number>(); // espn teamId -> event id
  const slateEspnTeams = new Set<number>();
  for (const eg of espnGames) {
    espnStatus.set(eg.homeTeamId, eg.status);
    espnStatus.set(eg.awayTeamId, eg.status);
    espnEvent.set(eg.homeTeamId, eg.gamePk);
    espnEvent.set(eg.awayTeamId, eg.gamePk);
    slateEspnTeams.add(eg.homeTeamId);
    slateEspnTeams.add(eg.awayTeamId);
  }
  if (espnGames.length === 0) return { day: realSched.day, cards, candidates };

  // Real team -> ESPN team: abbreviation, full display name, then unambiguous
  // short name ("Chiefs") — always slate-checked.
  const realToEspn = new Map<number, number>();
  for (const g of games) {
    for (const [rid, team] of [
      [g.homeTeamId, g.homeTeam],
      [g.awayTeamId, g.awayTeam],
    ] as [number, Team][]) {
      if (!wantedReal.includes(rid) || realToEspn.has(rid)) continue;
      const abbrev = (team.displayName || team.name || "").trim().toUpperCase();
      const realNorm = normName(team.displayName || team.name || "");
      const cand = abbrev ? byAbbrev.get(abbrev) : undefined;
      let eid: number | null = null;
      if (cand && cand > 0) {
        eid = cand; // unique abbreviation
      } else if (cand === -1) {
        // Ambiguous abbreviation — pick the one on this slate.
        for (const [ab2, id] of byAbbrev) {
          if (ab2 === abbrev && slateEspnTeams.has(id)) {
            eid = id;
            break;
          }
        }
      }
      if (eid == null && realNorm) {
        // Full display name, then short-name suffix ("Chiefs" → "…chiefs").
        const dn = byName.get(realNorm);
        if (dn != null && espnStatus.has(dn)) eid = dn;
        else {
          const short = realNorm.split(" ").pop() ?? "";
          const matches = [...byName]
            .filter(([k, id]) => k.endsWith(` ${short}`) && slateEspnTeams.has(id))
            .map(([, id]) => id);
          if (matches.length === 1) eid = matches[0];
        }
      }
      if (eid != null && espnStatus.has(eid)) realToEspn.set(rid, eid);
    }
  }

  type Pool = {
    players: Map<number, { id: number; name: string; jersey: string; pos: string }>;
    played: Set<number>;
    started: boolean; // live/final with a real boxscore
  };
  const pools = new Map<number, Pool>();
  for (const [rid, eid] of realToEspn) {
    const status = espnStatus.get(eid) ?? "STATUS_SCHEDULED";
    const s = status.toUpperCase();
    const upcoming =
      s.includes("SCHEDULED") || s.includes("DELAYED") || s.includes("PRE") ||
      s.includes("POSTPONED") || s.includes("CANCELLED");
    if (!upcoming) {
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
    // Scheduled / delayed (or live with no stats yet): active-roster projection.
    const roster = await espnRoster(eid);
    pools.set(rid, { players: roster, played: new Set(), started: false });
  }

  // Per-game divisor: completed team games this season (fetched once per team).
  const gamesPlayedCache = new Map<number, number>();
  const totalsCache = new Map<number, ReturnType<typeof espnAthleteTotals> extends Promise<infer T> ? T : never>();

  for (const pass of passes) {
    const rid = pass.entityType === "team" ? pass.entity.id : (pass.entity.teamId ?? 0);
    const realGame = games.find((g) => g.homeTeamId === rid || g.awayTeamId === rid);
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

    if (!totalsCache.has(ath.id)) totalsCache.set(ath.id, await espnAthleteTotals(ath.id));
    let gp = gamesPlayedCache.get(rid);
    if (gp === undefined) {
      gp = await espnTeamGamesPlayed(realToEspn.get(rid)!, new Date().getFullYear());
      gamesPlayedCache.set(rid, gp);
    }
    const score = nflScore(totalsCache.get(ath.id)!, gp);
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
