import { NextRequest, NextResponse } from "next/server";
import { scanDeals } from "@/lib/deal-scan";
import {
  DEAL_SEASONS,
  DEAL_SPORTS,
  seasonLabel,
  type DealFilters,
  type DealListingType,
  type DealSport,
} from "@/lib/deals";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const VALID_RARITIES = new Set([1, 2, 3, 4, 5, 6, 7]);
const VALID_TYPES = new Set<DealListingType>(["userpassfull", "card"]);
const ALL_SEASONS = new Set(
  Object.values(DEAL_SEASONS).flat()
);

function err(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  const sportRaw = (sp.get("sport") ?? "mlb").toLowerCase();
  if (!DEAL_SPORTS.some((s) => s.id === sportRaw)) {
    return err(`Unsupported sport "${sportRaw}"`);
  }
  const sport = sportRaw as DealSport;

  const season = Number(sp.get("season") ?? "");
  if (!Number.isInteger(season) || !ALL_SEASONS.has(season)) {
    return err(`Invalid season "${sp.get("season")}"`);
  }

  const typeRaw = (sp.get("types") ?? "userpassfull").split(",");
  const listingTypes = typeRaw.filter((t): t is DealListingType =>
    VALID_TYPES.has(t as DealListingType)
  );
  if (!listingTypes.length) return err("No valid card types (userpassfull|card)");

  const rarityRaw = (sp.get("rarities") ?? "7,6,5").split(",");
  const rarities = rarityRaw
    .map((r) => Number(r))
    .filter((r) => VALID_RARITIES.has(r))
    .sort((a, b) => b - a);
  if (!rarities.length) return err("No valid rarities (1..7)");

  const playersRaw = sp.get("players") ?? "";
  const players = playersRaw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 25);

  const minDiscountPct = Math.min(90, Math.max(0, Number(sp.get("minDisc") ?? 20)));
  const auctionOnly = sp.get("auctions") !== "0";

  const filters: DealFilters = {
    sport,
    season,
    listingTypes,
    rarities,
    players,
    minDiscountPct: Number.isFinite(minDiscountPct) ? minDiscountPct : 20,
    auctionOnly,
  };

  try {
    const res = await scanDeals(filters);
    return NextResponse.json({
      ...res,
      sport,
      season,
      seasonLabel: seasonLabel(sport, season),
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Scan failed" },
      { status: 502 }
    );
  }
}
