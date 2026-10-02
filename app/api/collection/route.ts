import { NextRequest, NextResponse } from "next/server";
import { getUserCollection, searchUsers } from "@/lib/real-api";
import {
  DEAL_SPORTS,
  RARITY_LABELS,
  seasonLabel,
  walkerOtdKey,
  type DealSport,
} from "@/lib/deals";

export const dynamic = "force-dynamic";

/** Real's own sport keys → the app's deals/OTD-menu vocabulary. Sports with no
 * deal season (golf) are dropped: a player menu entry that can't be scanned
 * has no business being offered. */
const SPORT_BY_API: Record<string, DealSport> = {
  mlb: "mlb",
  wnba: "wnba",
  nba: "nba",
  ncaaf: "ncaaf",
  ncaam: "ncaam",
  nfl: "nfl",
  nhl: "nhl",
  soccer: "soccer",
};

export interface CollectionPlayer {
  /** Player name as the card prints it — what the deals scan resolves. */
  name: string;
  /** `${sport}|${season}|${name}` — same key the preset lists use, so checked
   * names feed "Scan market" exactly like the fixed OTD list does. */
  key: string;
  rarity: number;
  rarityLabel: string;
  level: number;
  /** Rarity wins, level breaks the tie — this is the order inside a season. */
  copies: number;
}

export interface CollectionSeason {
  season: number;
  label: string;
  players: CollectionPlayer[];
}

export interface CollectionSport {
  id: DealSport;
  label: string;
  count: number;
  seasons: CollectionSeason[];
}

/**
 * The account's own player cards, grouped sport → season, rarest first.
 *
 * One Real call covers the whole collection (`/userpasses/<id>/passes`
 * unfiltered). Within a sport+season a player is listed once, at their highest
 * rarity, so a card you own twice doesn't show twice; ties break on boost
 * level, then name.
 */
export async function GET(req: NextRequest) {
  const username = req.nextUrl.searchParams.get("username")?.trim();
  const session = process.env.REAL_AUTH_INFO?.split("!")[0] ?? null;

  try {
    let userId = session;
    if (username) {
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
      userId = user.id;
    }
    if (!userId) {
      return NextResponse.json({ error: "Missing username" }, { status: 400 });
    }

    const passes = await getUserCollection(userId);

    // sport → season → (name → rarest copy)
    const grouped = new Map<
      DealSport,
      Map<number, Map<string, CollectionPlayer>>
    >();

    for (const p of passes) {
      if (p.entityType !== "player") continue;
      const sport = SPORT_BY_API[String(p.sport ?? "")];
      if (!sport) continue;
      const season = Number(p.season ?? 0);
      if (!season) continue;
      const name = String(p.label ?? "").trim();
      if (!name) continue;

      const rarity = Number(p.boostInfo?.baseRarity ?? 1) || 1;
      const level = Number(p.boostInfo?.level ?? 0) || 0;
      const rarityLabel = RARITY_LABELS[rarity] ?? p.boostInfo?.rarityLabel ?? "";

      let seasons = grouped.get(sport);
      if (!seasons) grouped.set(sport, (seasons = new Map()));
      let players = seasons.get(season);
      if (!players) seasons.set(season, (players = new Map()));

      const seen = players.get(name);
      if (seen) {
        seen.copies += 1;
        // Keep the best copy: rarity first, then level.
        if (rarity > seen.rarity || (rarity === seen.rarity && level > seen.level)) {
          seen.rarity = rarity;
          seen.rarityLabel = rarityLabel;
          seen.level = level;
        }
        continue;
      }
      players.set(name, {
        name,
        key: walkerOtdKey(sport, season, name),
        rarity,
        rarityLabel,
        level,
        copies: 1,
      });
    }

    const out: CollectionSport[] = [];
    for (const { id, label } of DEAL_SPORTS) {
      const seasons = grouped.get(id);
      if (!seasons) continue;
      const rows: CollectionSeason[] = [];
      let count = 0;
      for (const season of [...seasons.keys()].sort((a, b) => b - a)) {
        const players = [...seasons.get(season)!.values()].sort(
          (a, b) =>
            b.rarity - a.rarity ||
            b.level - a.level ||
            a.name.localeCompare(b.name)
        );
        count += players.length;
        rows.push({ season, label: seasonLabel(id, season), players });
      }
      out.push({ id, label, count, seasons: rows });
    }

    return NextResponse.json({
      userId,
      sports: out,
      total: out.reduce((a, s) => a + s.count, 0),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 502 }
    );
  }
}
