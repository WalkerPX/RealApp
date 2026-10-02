/**
 * NHL dashboard builder — who's playing (on the current Real slate) and how
 * good a game they project to have. Mirrors the NFL builder's output shape so
 * the shared booster-planning tail in the API route just works.
 *
 * Mapping: Real team → ESPN team by hockey abbreviation (`key`, e.g. "VGK"),
 * name fallback behind that; player pass → ESPN athlete by full name / jersey
 * within that team's roster or boxscore. Goalies (Real position "G") take
 * save-side booster stats and are scored on save %; skaters take
 * goals/assists/points/shots and are scored on points per game.
 */

import type { DashboardCard, Game, Team, UserPass } from "./types";
import type { PlayerRole } from "./boost-plan";
import { normName } from "./espn";
import {
  espnNhlBox,
  espnNhlForm,
  espnNhlRoster,
  espnNhlScoreboard,
  espnNhlTeamsByAbbrev,
  espnNhlTeamsByName,
  mapRealTeamToEspn,
  nhlGoalieScore,
  nhlSkaterScore,
  type NhlPlayer,
} from "./nhl";

export interface NhlOutput {
  day: string;
  cards: DashboardCard[];
  candidates: {
    passId: number;
    role: PlayerRole;
    score: number;
    boosted?: boolean;
    statPrefs?: string[];
    strictStats?: boolean;
  }[];
}

/** Real's hockey booster stat keys — read off the live booster inventory and
 * the web bundle's stat enum: 1 PTS · 2 GOAL · 3 AST · 24 SV · 24_61 SV+BLKS ·
 * 26 SHO · 27 W. Goalies can't earn goals and skaters can't earn saves, so
 * both sides are strict (no unrelated-stat last resort). A blocked shot is a
 * skater stat, so SV+BLKS stays on the skater list — last, since it's worth far
 * less to a forward than a goal or an assist. */
const SKATER_STATS = ["2", "1", "3", "24_61"];
const GOALIE_STATS = ["24", "24_61", "26", "27"];

function findEspnAthlete(
  players: Map<number, NhlPlayer>,
  pass: UserPass
): NhlPlayer | null {
  const firstName = normName(pass.entity.firstName ?? "");
  const lastName = normName(pass.entity.lastName ?? "");
  const jersey = pass.entity.jersey ? String(pass.entity.jersey) : "";
  let best: NhlPlayer | null = null;
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

export async function buildNhlDashboard(
  passes: UserPass[],
  realSched: { day: string; games: Game[] },
  isSelf: boolean
): Promise<NhlOutput> {
  const cards: DashboardCard[] = [];
  const candidates: NhlOutput["candidates"] = [];
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
    espnNhlTeamsByAbbrev(),
    espnNhlTeamsByName(),
    espnNhlScoreboard(espnDate),
  ]);
  if (espnGames.length === 0) return { day: realSched.day, cards, candidates };

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

  const realToEspn = new Map<number, number>();
  for (const g of games) {
    for (const [rid, team] of [
      [g.homeTeamId, g.homeTeam],
      [g.awayTeamId, g.awayTeam],
    ] as [number, Team][]) {
      if (!wantedReal.includes(rid) || realToEspn.has(rid)) continue;
      const eid = mapRealTeamToEspn(
        (team.key ?? "").trim().toUpperCase(),
        team.displayName || team.name || "",
        byAbbrev,
        byName,
        slateEspnTeams
      );
      if (eid != null) realToEspn.set(rid, eid);
    }
  }

  type Pool = {
    players: Map<number, NhlPlayer>;
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
      const box = await espnNhlBox(eventId);
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
    const roster = await espnNhlRoster(eid);
    pools.set(rid, { players: roster, played: new Set(), started: false });
  }

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

    const isGoalie =
      (pass.infoDetail ?? "").toUpperCase() === "G" || ath.pos.toUpperCase() === "G";
    const form = await espnNhlForm(ath.id);
    const score = isGoalie
      ? nhlGoalieScore(form.savePct)
      : nhlSkaterScore(form.points, form.games);

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
        statPrefs: isGoalie ? GOALIE_STATS : SKATER_STATS,
        strictStats: true,
      });
    }
  }

  return { day: realSched.day, cards, candidates };
}
