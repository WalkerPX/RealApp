import type {
  BoosterInventory,
  Game,
  RealUser,
  Sport,
  UserPass,
} from "./types";
import { requestToken } from "./hashids";

const BASE = "https://web.realapp.com";

// ─────────────────────────────────────────────────────────────
// Auth. Real's web app requires a logged-in session. Two supported modes:
//
//  A) real-* headers (preferred — same model as real-deal-tracker):
//     REAL_AUTH_INFO      localStorage "real-auth-info"  (userId!deviceId!token)
//     REAL_SESSION_TOKEN  localStorage "real-session-token"
//     REAL_DEVICE_TYPE / _NAME / _UUID / REAL_VERSION  (optional headers)
//     A fresh real-request-token is generated per request (hashids of now-ms).
//
//  B) cookie fallback: REAL_AUTH_COOKIE = full Cookie header from a logged-in
//     web.realapp.com session.
// ─────────────────────────────────────────────────────────────
// Device headers the Real API requires (verified working set from
// real-deal-tracker config). Real rejects requests without them, so these
// ship as defaults — env vars still override when they need to rotate.
const DEVICE_DEFAULTS = {
  type: "desktop_web",
  name:
    "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  uuid: "265341f5-e06c-422c-b476-c3bd4507f1a6",
  version: "35",
};

function authHeaders(): HeadersInit {
  const authInfo = process.env.REAL_AUTH_INFO;

  // real-auth-info is the actual credential ("{userId}!{deviceId}!{token}").
  // real-session-token is optional — the tracker client runs without it.
  if (authInfo) {
    const h: Record<string, string> = {
      Accept: "application/json",
      "real-device-type": process.env.REAL_DEVICE_TYPE ?? DEVICE_DEFAULTS.type,
      "real-device-name": process.env.REAL_DEVICE_NAME ?? DEVICE_DEFAULTS.name,
      "real-device-uuid": process.env.REAL_DEVICE_UUID ?? DEVICE_DEFAULTS.uuid,
      "real-version": process.env.REAL_VERSION ?? DEVICE_DEFAULTS.version,
      "real-request-token": requestToken(),
      "real-auth-info": authInfo,
      Origin: "https://realapp.com",
      Referer: "https://realapp.com/",
    };
    if (process.env.REAL_SESSION_TOKEN) {
      h["real-session-token"] = process.env.REAL_SESSION_TOKEN;
    }
    for (const k of Object.keys(h)) if (h[k] === "") delete h[k];
    return h;
  }

  const cookie = process.env.REAL_AUTH_COOKIE;
  if (cookie) {
    return {
      Cookie: cookie,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "application/json",
    };
  }

  throw new Error(
    "No Real session configured. Set REAL_AUTH_INFO + REAL_SESSION_TOKEN " +
      "(preferred) or REAL_AUTH_COOKIE — see README + .env.example."
  );
}

async function realFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: authHeaders(),
    // Live, personalized responses — never cache.
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Real API ${path.split("?")[0]} returned ${res.status}${
        body ? `: ${body.slice(0, 160)}` : ""
      }`
    );
  }
  return res.json() as Promise<T>;
}

export async function searchUsers(query: string): Promise<RealUser[]> {
  const data = await realFetch<{ users: RealUser[] }>(
    `/searchusers?query=${encodeURIComponent(query)}`
  );
  return data.users ?? [];
}

/** Verified live: query is ?sport=mlb[&season=2026] — entityType 400s. */
export async function getUserPasses(
  userId: string,
  sport: Sport,
  season: number
): Promise<UserPass[]> {
  const data = await realFetch<{ passes: UserPass[] }>(
    `/userpasses/${encodeURIComponent(userId)}/passes?sport=${sport}&season=${season}`
  );
  return data.passes ?? [];
}

/** "Today's players" — Real caps this at a curated top-N for the session
 * account (observed: 5 cards, and the `cohort` param is ignored server-side,
 * so pagination would just duplicate the same page). Single call + dedupe. */
export async function getTodaysPasses(
  sport: Sport,
  day: string
): Promise<UserPass[]> {
  const data = await realFetch<{ userPasses: UserPass[] }>(
    `/home/${sport}/boostcontrol?cohort=0&day=${day}`
  );
  const seen = new Set<number>();
  return (data.userPasses ?? []).filter((p) =>
    seen.has(p.id) ? false : (seen.add(p.id), true)
  );
}

/** Booster inventory is account-wide, not card-specific — any owned passId
 * works as the URL anchor. */
export async function getBoosterInventory(
  anchorPassId: number,
  sport: Sport
): Promise<BoosterInventory> {
  const data = await realFetch<{ boosterCardInfo: BoosterInventory }>(
    `/userpassboostercards/${anchorPassId}/entity/player?displayType=userpass&sport=${sport}&version=stat`
  );
  return data.boosterCardInfo ?? { rarityGroups: [] };
}

export async function getTodaysSchedule(sport: Sport): Promise<Game[]> {
  const data = await realFetch<{ latestDayContent: { games?: Game[] } }>(
    `/home/${sport}/next?cohort=0`
  );
  return data.latestDayContent?.games ?? [];
}

/** Opens the card's booster view inside a logged-in web.realapp.com session. */
export function realBoostUrl(passId: number, sport: Sport): string {
  return `${BASE}/userpassboostercards/${passId}/entity/player?displayType=userpass&sport=${sport}&version=stat`;
}
