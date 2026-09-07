import { NextRequest, NextResponse } from "next/server";
import {
  getBoosterInventory,
  getTodaysPasses,
  getTodaysSchedule,
  getUserPasses,
  searchUsers,
} from "@/lib/real-api";
import { suggestBestBooster } from "@/lib/suggest";
import { SUPPORTED_SPORTS, type DashboardCard, type Sport } from "@/lib/types";

export const dynamic = "force-dynamic";

const SPORT_IDS = new Set(SUPPORTED_SPORTS.map((s) => s.id));

/** Real days roll at midnight ET — compute "today" there, not UTC. */
function todayET(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function GET(req: NextRequest) {
  const username = req.nextUrl.searchParams.get("username")?.trim();
  const sportRaw = req.nextUrl.searchParams.get("sport") ?? "mlb";
  const sport = (sportRaw.toLowerCase() as Sport);

  if (!username) {
    return NextResponse.json({ error: "Missing username" }, { status: 400 });
  }
  if (!SPORT_IDS.has(sport)) {
    return NextResponse.json(
      { error: `Unsupported sport "${sportRaw}"` },
      { status: 400 }
    );
  }

  try {
    const matches = await searchUsers(username);
    const user = matches.find(
      (u) => u.userName.toLowerCase() === username.toLowerCase()
    );
    if (!user) {
      return NextResponse.json(
        { error: `No exact match for "${username}"`, suggestions: matches },
        { status: 404 }
      );
    }

    const day = todayET();
    const season = new Date().getFullYear();

    const [allPasses, todaysPasses, schedule] = await Promise.all([
      getUserPasses(user.id, sport, season),
      getTodaysPasses(sport, day),
      getTodaysSchedule(sport),
    ]);

    // boostcontrol is scoped to the session's own account, so intersect with
    // the looked-up user's full collection to keep the dashboard honest.
    const ownedIds = new Set(allPasses.map((p) => p.id));
    const playingToday = todaysPasses.filter((p) => ownedIds.has(p.id));

    const teamsById = new Map<number, (typeof schedule)[number]>();
    for (const game of schedule) {
      teamsById.set(game.homeTeamId, game);
      teamsById.set(game.awayTeamId, game);
    }

    let suggestion = null;
    if (playingToday.length > 0) {
      const inventory = await getBoosterInventory(playingToday[0].id, sport);
      suggestion = suggestBestBooster(inventory);
    }

    const cards: DashboardCard[] = playingToday
      .map((pass) => {
        const game = teamsById.get(pass.entity.teamId) ?? null;
        const opponent = game
          ? game.homeTeamId === pass.entity.teamId
            ? game.awayTeam
            : game.homeTeam
          : null;
        return {
          pass,
          game,
          opponent,
          suggestedBooster: pass.boostInfo.isCardBoosted ? null : suggestion,
        };
      })
      // Unboosted cards first (those are the actionable ones), then biggest
      // earners first.
      .sort((a, b) => {
        if (a.pass.boostInfo.isCardBoosted !== b.pass.boostInfo.isCardBoosted) {
          return a.pass.boostInfo.isCardBoosted ? 1 : -1;
        }
        return (
          parseFloat(b.pass.boostValue ?? "0") -
          parseFloat(a.pass.boostValue ?? "0")
        );
      });

    return NextResponse.json({
      user,
      sport,
      day,
      cards,
      totalOwned: allPasses.length,
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 502 }
    );
  }
}
