import { NextRequest, NextResponse } from "next/server";
import { buildRax, earningsDay } from "@/lib/earnings";
import { searchUsers } from "@/lib/real-api";

export const dynamic = "force-dynamic";

/** Session account id (prefix of real-auth-info). */
function sessionUserId(): string | null {
  return process.env.REAL_AUTH_INFO?.split("!")[0] ?? null;
}

/**
 * Rax earned by an account's cards, per day.
 *
 * Query: `username=walkr` (optional — defaults to the signed-in account) and
 * `day=YYYY-MM-DD` (optional — defaults to Real's eastern day).
 *
 * Real publishes historical earnings only for the account the session belongs
 * to (`/cardhistoricalearnings*` takes no user parameter — verified: passing
 * one returns the session account's rows unchanged), so a lookup for anyone
 * else resolves the name and reports `otherUser: true` instead of pretending
 * to have their numbers.
 */
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("day")?.trim();
  const day = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : earningsDay();
  const username = req.nextUrl.searchParams.get("username")?.trim();

  const session = sessionUserId();

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

    const isSelf = userId !== null && userId === session;
    if (!isSelf) {
      return NextResponse.json({
        userName,
        otherUser: true,
        day,
        today: earningsDay(),
        total: 0,
        detail: { dayDisplay: day, isActiveDay: null, sports: [], total: 0, cards: 0 },
        calendar: {},
        calendarTotal: 0,
        bestDay: null,
        etHour: 0,
        etMinute: 0,
        rollover: "07:00 ET",
      });
    }

    const rax = await buildRax(day);
    return NextResponse.json({ ...rax, userName, otherUser: false });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 502 }
    );
  }
}
