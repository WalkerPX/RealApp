import { NextRequest, NextResponse } from "next/server";
import { buildPending } from "@/lib/pending";

export const dynamic = "force-dynamic";

/** Reading a day costs one Real request per game, paced slowly on purpose
 * (Real 429s hard and stickily on a fast fan-out). The handler keeps itself to
 * an internal 40s budget and reports the remainder as `deferred`, so this
 * ceiling is only a backstop. */
export const maxDuration = 60;

/** Session account id (prefix of real-auth-info) — pending earnings are
 * recomputed from that account's own cards' live box scores. */
function sessionUserId(): string | null {
  return process.env.REAL_AUTH_INFO?.split("!")[0] ?? null;
}

/**
 * Rax earned by the account's cards in today's games so far — the amount that
 * lands at the next 07:00 ET payout.
 *
 * Real only publishes a player card's day earnings after the day rolls
 * (`/userpassearnings/day/<day>`), so this is recomputed from live box scores.
 *
 * Query: `force=1` to bypass the short in-process cache.
 */
export async function GET(req: NextRequest) {
  const userId = sessionUserId();
  if (!userId) {
    return NextResponse.json(
      { error: "No Real session configured (REAL_AUTH_INFO missing)" },
      { status: 500 }
    );
  }

  const force = req.nextUrl.searchParams.get("force") === "1";

  try {
    const pending = await buildPending(userId, { force });
    return NextResponse.json(pending);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 502 }
    );
  }
}
