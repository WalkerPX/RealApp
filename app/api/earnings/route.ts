import { NextRequest, NextResponse } from "next/server";
import { buildRax, earningsDay } from "@/lib/earnings";

export const dynamic = "force-dynamic";

/**
 * Rax earned by the account's cards, per day.
 *
 * Query: `day=YYYY-MM-DD` (optional; defaults to Real's eastern day).
 *
 * The earnings data is auth-scoped to the configured Real account, so this is
 * always the signed-in account's own rax.
 */
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("day")?.trim();
  const day = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : earningsDay();

  try {
    const rax = await buildRax(day);
    return NextResponse.json(rax);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 502 }
    );
  }
}
