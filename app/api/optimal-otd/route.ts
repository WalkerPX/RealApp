import { NextRequest, NextResponse } from "next/server";
import { solveOtd, OTD_SPORTS, sportLabel } from "@/lib/optimal-otd";

export const dynamic = "force-dynamic";
/** The solver is pure CPU on a ~1.3k-card table — needs the Node runtime. */
export const runtime = "nodejs";

/** GET /api/optimal-otd?sports=nhl,ncaam&k=10&mode=total|persport
 *  `sports` omitted (or `all`) spans every sport we have calendars for.
 *  `mode=persport` takes k cards for EACH selected sport (k × sports total);
 *  `mode=total` (default) takes k cards across all of them.
 *  Claim amounts come back as BASE rax; multiply by LEVEL_MULT[level] for an
 *  at-level figure (the winning set is identical at every level). */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const raw = (url.searchParams.get("sports") ?? "").trim();
  const sports =
    !raw || raw === "all"
      ? null
      : raw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s && s !== "all");

  const kRaw = Number(url.searchParams.get("k") ?? 10);
  const k = Number.isFinite(kRaw) ? Math.min(20, Math.max(1, Math.round(kRaw))) : 10;
  const perSport = (url.searchParams.get("mode") ?? "total") === "persport";

  try {
    const sol = solveOtd(sports, k, perSport);
    return NextResponse.json({
      ...sol,
      sportsMeta: sol.sports.map((id) => ({
        id,
        label: sportLabel(id),
        cards: OTD_SPORTS.find((s) => s.id === id)?.cards ?? 0,
      })),
      available: OTD_SPORTS,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Optimal OTD failed" },
      { status: 500 }
    );
  }
}
