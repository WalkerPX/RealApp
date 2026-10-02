import { NextRequest, NextResponse } from "next/server";
import { buildPending } from "@/lib/pending";
import { searchUsers } from "@/lib/real-api";

export const dynamic = "force-dynamic";

/** Reading a day costs one Real request per game, paced slowly on purpose
 * (Real 429s hard and stickily on a fast fan-out). The handler keeps itself to
 * an internal 40s budget and reports the remainder as `deferred`, so this
 * ceiling is only a backstop. */
export const maxDuration = 60;

/** Session account id (prefix of real-auth-info). */
function sessionUserId(): string | null {
  return process.env.REAL_AUTH_INFO?.split("!")[0] ?? null;
}

/**
 * Rax earned by an account's cards in today's games so far — the amount that
 * lands at the next 07:00 ET payout.
 *
 * Real only publishes a player card's day earnings after the day rolls
 * (`/userpassearnings/day/<day>`), so this is recomputed from live box scores.
 * Box scores are plain game data (not account-scoped), so any username works:
 * we read that user's passes and price them with their own booster table.
 *
 * Query: `username=walkr` (optional — defaults to the signed-in account) and
 * `force=1` to bypass the short in-process cache.
 */
export async function GET(req: NextRequest) {
  const session = sessionUserId();
  if (!session) {
    return NextResponse.json(
      { error: "No Real session configured (REAL_AUTH_INFO missing)" },
      { status: 500 }
    );
  }

  const force = req.nextUrl.searchParams.get("force") === "1";
  const username = req.nextUrl.searchParams.get("username")?.trim();

  try {
    let userId = session;
    let userName: string | null = null;

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
      userName = user.userName;
    }

    const pending = await buildPending(userId, { force });
    return NextResponse.json({
      ...pending,
      userName,
      otherUser: userId !== session,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 502 }
    );
  }
}
