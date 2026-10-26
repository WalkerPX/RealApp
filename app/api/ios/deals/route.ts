import { NextRequest, NextResponse } from "next/server";
import { scanDeals } from "@/lib/deal-scan";
import { RealHashids } from "@/lib/hashids";
import {
  DEAL_SEASONS,
  DEAL_SPORTS,
  seasonLabel,
  type DealFilters,
  type DealListingType,
  type DealMode,
  type DealSport,
} from "@/lib/deals";

/**
 * iOS-only deal feed for the Made sideload layer (`/api/ios/deals`).
 *
 * Identical query surface to `/api/deals`, plus `numBids` on every row so the
 * app can price the *real* cost of entering an auction — a listing that
 * already has bids requires +10 rax over the current price, one with no bids
 * does not.
 *
 * Deliberately self-contained: the website's `/api/deals` response shape is
 * untouched. Bid counts are read from the single-listing endpoint
 * (`/cardmarketplacelistings/{id}`) for just the rows that survived the scan.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const VALID_RARITIES = new Set([1, 2, 3, 4, 5, 6, 7]);
const VALID_TYPES = new Set<DealListingType>(["userpassfull", "card"]);

const REAL_BASE = "https://web.realapp.com";

/** Rows per response we're willing to look up bids for. Deal rows are already
 * narrow, so this is a safety rail, not a normal limit. */
const MAX_BID_LOOKUPS = 120;
const BID_CONCURRENCY = 5;
const BID_TIMEOUT_MS = 5000;
/** Bid counts move only when someone bids; a short TTL collapses repeat scans. */
const BID_TTL_MS = 60_000;

const bidCache = new Map<number, { t: number; v: number | null }>();

function err(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

function pickDeviceName(): string {
  return (
    process.env.REAL_DEVICE_NAME ??
    "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
  );
}

function chromeMajor(): string {
  return /Chrome\/(\d+)/.exec(pickDeviceName())?.[1] ?? "151";
}

/** Real rejects a replayed `real-request-token` (first call 200, the rest
 * 400), so every lookup needs its own token. `requestToken()` hashes Date.now()
 * at ms resolution, which collides for parallel calls — so hand out strictly
 * increasing stamps instead of trusting the clock. */
const _TOKENS = new RealHashids("realwebapp", 16);
let lastStamp = 0;
function freshToken(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return _TOKENS.encode(lastStamp);
}

function listingHeaders(token: string): Record<string, string> {
  const v = chromeMajor();
  const h: Record<string, string> = {
    "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "sec-ch-ua": `"Chromium";v="${v}", "Google Chrome";v="${v}", "Not:A-Brand";v="24"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    Priority: "u=1, i",
    Origin: "https://realapp.com",
    Referer: "https://realapp.com/",
    "real-device-type": process.env.REAL_DEVICE_TYPE ?? "desktop_web",
    "real-device-name": pickDeviceName(),
    "real-device-uuid":
      process.env.REAL_DEVICE_UUID ?? "265341f5-e06c-422c-b476-c3bd4507f1a6",
    "real-version": process.env.REAL_VERSION ?? "35",
    "real-request-token": token,
  };
  if (process.env.REAL_AUTH_INFO) h["real-auth-info"] = process.env.REAL_AUTH_INFO;
  if (process.env.REAL_SESSION_TOKEN) {
    h["real-session-token"] = process.env.REAL_SESSION_TOKEN;
  }
  if (process.env.REAL_AUTH_COOKIE) h.Cookie = process.env.REAL_AUTH_COOKIE;
  for (const k of Object.keys(h)) if (h[k] === "") delete h[k];
  return h;
}

/** Bids already on a listing. `null` = unknown (lookup failed); callers should
 * treat unknown as "bids may exist" and assume the +10 step. */
async function fetchNumBids(listingId: number): Promise<number | null> {
  const hit = bidCache.get(listingId);
  if (hit && hit.t > Date.now()) return hit.v;

  let value: number | null = null;
  try {
    const res = await fetch(`${REAL_BASE}/cardmarketplacelistings/${listingId}`, {
      headers: listingHeaders(freshToken()),
      cache: "no-store",
      signal: AbortSignal.timeout(BID_TIMEOUT_MS),
    });
    if (!res.ok) console.warn(`bid lookup ${listingId} -> ${res.status}`);
    if (res.ok) {
      const body = (await res.json()) as {
        listing?: { numBids?: number | string | null };
      };
      const n = Number(body.listing?.numBids);
      value = Number.isFinite(n) ? n : null;
    }
  } catch {
    value = null;
  }

  bidCache.set(listingId, { t: Date.now() + BID_TTL_MS, v: value });
  if (bidCache.size > 4000) {
    const now = Date.now();
    for (const [k, e] of bidCache) if (e.t < now) bidCache.delete(k);
  }
  return value;
}

/** Fixed-size worker pool — keeps the burst inside Real's tolerance. */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  const sportRaw = (sp.get("sport") ?? "mlb").toLowerCase();
  if (!DEAL_SPORTS.some((s) => s.id === sportRaw)) {
    return err(`Unsupported sport "${sportRaw}"`);
  }
  const sport = sportRaw as DealSport;

  const season = Number(sp.get("season") ?? "");
  if (!Number.isInteger(season) || !DEAL_SEASONS[sport].includes(season)) {
    return err(`Invalid season "${sp.get("season")}" for ${sport}`);
  }

  const listingTypes = (sp.get("types") ?? "userpassfull")
    .split(",")
    .filter((t): t is DealListingType => VALID_TYPES.has(t as DealListingType));
  if (!listingTypes.length) return err("No valid card types (userpassfull|card)");

  const rarities = (sp.get("rarities") ?? "7,6,5")
    .split(",")
    .map((r) => Number(r))
    .filter((r) => VALID_RARITIES.has(r))
    .sort((a, b) => b - a);
  if (!rarities.length) return err("No valid rarities (1..7)");

  const players = (sp.get("players") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 25);

  const minDiscountPct = Math.min(90, Math.max(0, Number(sp.get("minDisc") ?? 20)));
  const auctionOnly = sp.get("auctions") !== "0";
  const mode: DealMode = sp.get("mode") === "rating" ? "rating" : "discount";
  const factorRaw = Number(sp.get("factor") ?? 12);
  const ratingFactor = Number.isFinite(factorRaw)
    ? Math.min(1000, Math.max(1, factorRaw))
    : 12;

  const filters: DealFilters = {
    sport,
    season,
    listingTypes,
    rarities,
    players,
    minDiscountPct: Number.isFinite(minDiscountPct) ? minDiscountPct : 20,
    auctionOnly,
    mode,
    ratingFactor,
  };

  try {
    const res = await scanDeals(filters);
    const rows = res.deals.slice(0, MAX_BID_LOOKUPS);

    const bids = await mapLimited(rows, BID_CONCURRENCY, (d) =>
      fetchNumBids(d.listingId)
    );

    const deals = res.deals.map((d, i) => {
      const numBids = i < rows.length ? bids[i] : null;
      // Entry cost: with bids on it you must clear the current price by 10;
      // a bid-less auction costs the asking price. Unknown → assume bids.
      const step = numBids === 0 ? 0 : 10;
      return {
        ...d,
        numBids,
        nextBid: step || null,
        entry: d.price + step,
      };
    });

    return NextResponse.json({
      ...res,
      deals,
      sport,
      season,
      seasonLabel: seasonLabel(sport, season),
      bidLookups: rows.length,
      bidUnknown: deals.filter((d) => d.numBids === null).length,
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Scan failed" },
      { status: 502 }
    );
  }
}
