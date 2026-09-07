import type {
  BoosterInventory,
  Game,
  RealUser,
  Sport,
  UserPass,
} from "./types";
import { RealHashids, requestToken } from "./hashids";
import {
  listingPlayerLabel,
  listingPrice,
  parseFmvMedian,
  splitEarnings,
  type RawListing,
} from "./deals";

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

/** Removed getTodaysPasses: boostcontrol's top-5 list is a fixed curated set
 * (ignores day/cohort/offset params), not "who plays today". "Playing today"
 * is now computed in the route by joining the full collection with the
 * schedule. */

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

/** Real's share-link encoder (salt "routing", min length 11). Player booster
 * page route shape — decode-verified against a real share link (Ohtani →
 * realapp.com/k3tvTvFwRow): [type=2, sport=4 (MLB), 0, playerEntityId].
 * Public URL — unlike the web.realapp.com API path, opens without a session. */
const _ROUTING_HASH = new RealHashids("routing", 11);

export function realBoostUrl(playerEntityId: number): string {
  return `https://www.realapp.com/${_ROUTING_HASH.encode([2, 4, 0, playerEntityId])}`;
}

/** Marketplace listing share link (type=30 route, decode-verified). */
export function realListingUrl(listingId: number): string {
  return `https://www.realapp.com/${_ROUTING_HASH.encode([30, 0, 0, listingId])}`;
}

// ── marketplace (deals) ──────────────────────────────────────
// Deals scans fan out over many listings; a tiny per-instance TTL cache keeps
// repeat FMV/earnings lookups within a scan (and across scans) cheap.
const mktCache = new Map<string, { t: number; v: unknown }>();
const MKT_TTL = 6 * 60 * 60 * 1000;

async function mktFetch<T>(path: string): Promise<T> {
  const hit = mktCache.get(path);
  if (hit && hit.t > Date.now()) return hit.v as T;
  const res = await fetch(`${BASE}${path}`, {
    headers: authHeaders(),
    cache: "no-store",
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error("Real API auth rejected (401)");
    throw new Error(`Real API ${path.split("?")[0]} -> ${res.status}`);
  }
  const data = (await res.json()) as T;
  mktCache.set(path, { t: Date.now() + MKT_TTL, v: data });
  if (mktCache.size > 400) {
    const now = Date.now();
    for (const [k, e] of mktCache) if (e.t < now) mktCache.delete(k);
  }
  return data;
}

export async function fetchMarketplaceListings(params: {
  sport: string;
  season: number;
  rarity: number;
  listingType: string;
  beforeEndsAt?: string;
}): Promise<RawListing[]> {
  const q = new URLSearchParams({
    sport: params.sport,
    season: String(params.season),
    rarity: String(params.rarity),
    offset: "0",
    listingType: params.listingType,
  });
  if (params.beforeEndsAt) q.set("beforeEndsAt", params.beforeEndsAt);
  const d = await mktFetch<{ listings?: RawListing[] }>(
    `/cardmarketplacelistings?${q}`
  );
  return d.listings ?? [];
}

export async function fetchFmvMedian(
  cardId: number,
  listingType: string
): Promise<number | null> {
  const d = await mktFetch<{ summaryInfo?: { header?: string; value?: unknown }[] }>(
    `/marketplace/fmv/${cardId}?listingType=${encodeURIComponent(listingType)}`
  );
  return parseFmvMedian(d);
}

/** Earnings calendar for a player pass at its boost level. */
export async function fetchPlayerEarnings(
  sport: string,
  season: number,
  playerId: number,
  level?: number | null
): Promise<{ total: number; remaining: number } | null> {
  const q = new URLSearchParams();
  if (level) q.set("level", String(level));
  const path = `/userpassearnings/${sport}/season/${season}/entity/player/${playerId}${q.size ? `?${q}` : ""}`;
  try {
    const d = await mktFetch<{ earnings?: unknown[] }>(path);
    const earnings = (d.earnings ?? []) as {
      day?: string;
      atRarityEarnings?: unknown;
      earnings?: unknown;
    }[];
    if (!earnings.length) return null;
    const et = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
    );
    return splitEarnings(earnings, et);
  } catch {
    return null; // no calendar / lookup failure — fall back to FMV-only
  }
}
