import { NextRequest, NextResponse } from "next/server";
import {
  getBoosterInventory,
  getTodaysSchedule,
  getUserPasses,
  searchUsers,
} from "@/lib/real-api";
import {
  batterScore,
  getBoxScore,
  getRoster,
  getTodaysMlbGames,
  getTopK9Ids,
  pitcherScore,
  type MlbPlayerStats,
} from "@/lib/mlb";
import { planBoosts, type PlayerRole } from "@/lib/boost-plan";
import { buildWnbaDashboard } from "@/lib/wnba-dash";
import { buildCfbDashboard } from "@/lib/cfb-dash";
import { buildNflDashboard } from "@/lib/nfl-dash";
import { buildFcDashboard } from "@/lib/fc-dash";
import {
  SUPPORTED_SPORTS,
  type DashboardCard,
  type Sport,
  type UserPass,
} from "@/lib/types";

export const dynamic = "force-dynamic";

const SPORT_IDS = new Set(SUPPORTED_SPORTS.map((s) => s.id));

// Game hasn't started: use active-roster projection, not a (404) boxscore.
// MLB reports these as "Scheduled" early, then "Pre-Game"/"Warmup" close to
// first pitch — all three must take the roster path or starters vanish.
const UPCOMING = new Set(["Scheduled", "Pre-Game", "Warmup"]);

function todayET(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function teamIdOf(pass: UserPass): number {
  return pass.entityType === "team" ? pass.entity.id : (pass.entity.teamId ?? 0);
}

/** Session account id (prefix of real-auth-info) — booster inventory is
 * scoped to that account, so suggestions only apply when looking up self. */
function sessionUserId(): string | null {
  return process.env.REAL_AUTH_INFO?.split("!")[0] ?? null;
}

/** Match an MLB player for a Real pass (same team pool). Names first —
 * players change jersey numbers, which silently mis-matches otherwise.
 * Suffixes (Jr., III) are stripped before comparing. */
function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findMlbPlayer(
  players: Map<number, MlbPlayerStats>,
  pass: UserPass
): MlbPlayerStats | null {
  const firstName = normName(pass.entity.firstName ?? "");
  const lastName = normName(pass.entity.lastName ?? "");
  const jersey = pass.entity.jersey ? String(pass.entity.jersey) : "";

  let best: MlbPlayerStats | null = null;
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

export async function GET(req: NextRequest) {
  const username = req.nextUrl.searchParams.get("username")?.trim();
  const sportRaw = req.nextUrl.searchParams.get("sport") ?? "mlb";
  const sport = sportRaw.toLowerCase() as Sport;

  if (!username) return NextResponse.json({ error: "Missing username" }, { status: 400 });
  if (!SPORT_IDS.has(sport)) {
    return NextResponse.json({ error: `Unsupported sport "${sportRaw}"` }, { status: 400 });
  }
  if (
    sport !== "mlb" &&
    sport !== "wnba" &&
    sport !== "cfb" &&
    sport !== "nfl" &&
    sport !== "fc"
  ) {
    return NextResponse.json(
      { error: "Only MLB, WNBA, CFB, NFL and FC are implemented so far" },
      { status: 400 }
    );
  }

  try {
    const matches = await searchUsers(username);
    const user = matches.find((u) => u.userName.toLowerCase() === username.toLowerCase());
    if (!user) {
      return NextResponse.json(
        { error: `No exact match for "${username}"`, suggestions: matches },
        { status: 404 }
      );
    }

    const day = todayET();
    // Season whose passes we boost. Every sport keys by starting year; NFL
    // boost season is the 2026-27 set (bulk player passes live at season
    // start — Play cards drop later, but boosts carry over between seasons).
    const BOOST_SEASONS: Partial<Record<Sport, number>> = {
      mlb: 2026,
      wnba: 2026,
      cfb: 2026,
      nfl: 2026,
      fc: 2026,
    };
    const season = BOOST_SEASONS[sport] ?? new Date().getFullYear();
    const isSelf = sessionUserId() !== null && sessionUserId() === user.id;

    const [allPasses, sched] = await Promise.all([
      getUserPasses(user.id, sport, season),
      getTodaysSchedule(sport),
    ]);
    const realGames = sched.games;

    // Team ids that play today (Real + MLB share team id space)
    const teamsById = new Map<number, (typeof realGames)[number]>();
    for (const g of realGames) {
      teamsById.set(g.homeTeamId, g);
      teamsById.set(g.awayTeamId, g);
    }
    const playingTeamPasses = allPasses.filter((p) => teamsById.has(teamIdOf(p)));

    // ── per-sport reality / projection layer ──────────────────
    const cards: DashboardCard[] = [];
    const candidates: { passId: number; role: PlayerRole; score: number; boosted?: boolean; kTop25?: boolean }[] = [];
    let respDay = day;

    if (sport === "mlb") {
      const mlbGames = await getTodaysMlbGames(day);
      const mlbByTeam = new Map<number, (typeof mlbGames)[number]>();
      for (const g of mlbGames) {
        mlbByTeam.set(g.homeTeamId, g);
        mlbByTeam.set(g.awayTeamId, g);
      }
      const probableByTeam = new Map<number, number>();
      for (const g of mlbGames) {
        if (g.homeProbable) probableByTeam.set(g.homeTeamId, g.homeProbable);
        if (g.awayProbable) probableByTeam.set(g.awayTeamId, g.awayProbable);
      }

      // Per-team MLB player pool: boxscore when started, roster when scheduled.
      const playerPool = new Map<number, { players: Map<number, MlbPlayerStats>; played: Set<number>; status: string; lineupTbd: boolean }>();
      const wantedTeams = new Set(playingTeamPasses.map(teamIdOf).filter((t) => mlbByTeam.has(t)));
      const teamsByStatus = new Map<number, string>();
      for (const teamId of wantedTeams) teamsByStatus.set(teamId, mlbByTeam.get(teamId)!.status);

      const finalOrLive = [...teamsByStatus.entries()].filter(([, s]) => !UPCOMING.has(s));
      await Promise.all(
        finalOrLive.map(async ([teamId, status]) => {
          const game = mlbByTeam.get(teamId)!;
          const box = await getBoxScore(game.gamePk, status);
          if (box && box.players.size > 0) {
            playerPool.set(teamId, { players: box.players, played: box.playedIds, status, lineupTbd: false });
          } else {
            playerPool.set(teamId, { players: new Map(), played: new Set(), status, lineupTbd: true });
          }
        })
      );
      const scheduledTeams = [...teamsByStatus.entries()].filter(([, s]) => UPCOMING.has(s));
      await Promise.all(
        scheduledTeams.map(async ([teamId, status]) => {
          const roster = await getRoster(teamId);
          playerPool.set(teamId, { players: roster, played: new Set(), status, lineupTbd: true });
        })
      );

      // Elite strikeout arms — only they may get K booster suggestions.
      const topK9 = isSelf ? await getTopK9Ids(season) : new Set<number>();

      for (const pass of playingTeamPasses) {
        const teamId = teamIdOf(pass);
        const realGame = teamsById.get(teamId) ?? null;
        const opponent = realGame
          ? realGame.homeTeamId === teamId
            ? realGame.awayTeam
            : realGame.homeTeam
          : null;
        const pool = playerPool.get(teamId);

        // Team passes: show whenever their team plays; no lineup concept.
        if (pass.entityType === "team") {
          if (pool) {
            cards.push({ pass, game: realGame, opponent, role: "team", score: null, lineupTbd: false, suggestedBooster: null });
          }
          continue;
        }

        // Players: hurt? → skip. Not on a real MLB team today? → skip.
        if (!pool || !mlbByTeam.has(teamId)) continue;
        const injury = pass.entity.injuryStatus?.toLowerCase();
        if (injury && injury !== "active" && injury !== "available") continue;

        const isTwoWay = (pass.infoDetail ?? "").toUpperCase() === "TWP";
        const mlbPlayer = findMlbPlayer(pool.players, pass);
        if (!mlbPlayer) continue; // not on active roster / no MLB data

        const realPosPitcher = (pass.infoDetail ?? "").toUpperCase() === "P";
        const posPitcher = !isTwoWay && (realPosPitcher || mlbPlayer.posAbbr === "P");
        const finalRole: PlayerRole = posPitcher ? "pitcher" : "hitter";
        let projected = false;
        let lineupTbd = false;
        let score = 0;

        if (!UPCOMING.has(pool.status)) {
          projected = pool.played.has(mlbPlayer.id);
          lineupTbd = pool.played.size === 0; // game not started yet
          if (projected) score = finalRole === "pitcher" ? pitcherScore(mlbPlayer.pit!) : batterScore(mlbPlayer.bat!);
          if (!projected && pool.played.size === 0) {
            // Game live/final but nobody listed yet (weather etc.) — keep roster fallback
            projected = mlbPlayer.statusCode === "A";
            lineupTbd = true;
            score = finalRole === "pitcher" ? pitcherScore(mlbPlayer.pit!) : batterScore(mlbPlayer.bat!);
          }
        } else {
          if (mlbPlayer.statusCode !== "A") continue; // IL/minors
          if (finalRole === "pitcher") {
            projected = probableByTeam.get(teamId) === mlbPlayer.id; // only the starter
          } else {
            projected = true; // lineup not posted yet
            lineupTbd = true;
          }
          score = finalRole === "pitcher" ? pitcherScore(mlbPlayer.pit!) : batterScore(mlbPlayer.bat!);
        }

        if (!projected) continue;
        cards.push({ pass, game: realGame, opponent, role: finalRole, score, lineupTbd, suggestedBooster: null });
        if (isSelf) candidates.push({ passId: pass.id, role: finalRole, score, boosted: pass.boostInfo.isCardBoosted === true, kTop25: finalRole === "pitcher" && topK9.has(mlbPlayer.id) });
      }
    } else if (sport === "wnba") {
      // ── WNBA layer (ESPN mapping; no pitchers — all hitters) ──
      const wn = await buildWnbaDashboard(allPasses, sched, isSelf);
      respDay = wn.day;
      for (const c of wn.cards) cards.push(c);
      for (const c of wn.candidates) candidates.push(c);
    } else if (sport === "cfb") {
      // ── CFB layer (ESPN mapping by abbreviation/name; all players) ──
      const cf = await buildCfbDashboard(allPasses, sched, isSelf);
      respDay = cf.day;
      for (const c of cf.cards) cards.push(c);
      for (const c of cf.candidates) candidates.push(c);
    } else if (sport === "nfl") {
      // ── NFL layer (ESPN mapping by abbreviation/name; all players) ──
      const nf = await buildNflDashboard(allPasses, sched, isSelf);
      respDay = nf.day;
      for (const c of nf.cards) cards.push(c);
      for (const c of nf.candidates) candidates.push(c);
    } else {
      // ── FC layer (soccer; Real slate only — club plays today) ──
      const fc = await buildFcDashboard(allPasses, sched, isSelf);
      respDay = fc.day;
      for (const c of fc.cards) cards.push(c);
      for (const c of fc.candidates) candidates.push(c);
    }

    // ── Booster plan (own account only: inventory is session-scoped) ──
    if (isSelf && candidates.length > 0) {
      const anchorPass = playingTeamPasses.find((p) => p.entityType === "player") ?? playingTeamPasses[0];
      const inventory = await getBoosterInventory(anchorPass.id, sport);
      const plan = planBoosts(candidates, inventory);
      for (const c of cards) {
        // Keep the suggestion even when already boosted — it still shows what
        // to play next; the UI marks boosted cards with a BOOSTED tag.
        c.suggestedBooster = plan.get(c.pass.id) ?? null;
      }
    }

    cards.sort((a, b) => {
      if (a.pass.boostInfo.isCardBoosted !== b.pass.boostInfo.isCardBoosted) {
        return a.pass.boostInfo.isCardBoosted ? 1 : -1;
      }
      return (b.score ?? -1) - (a.score ?? -1);
    });

    return NextResponse.json({
      user,
      sport,
      day: respDay,
      cards,
      totalOwned: allPasses.length,
      projectedCount: cards.filter((c) => c.role !== "team").length,
      suggestionsForSelf: isSelf,
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 502 }
    );
  }
}
