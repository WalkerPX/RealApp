/**
 * Tiny shared ESPN fetch helper (public feeds, no key). Same TTL-cache pattern
 * as lib/mlb.ts / lib/wnba.ts — used by the CFB pipeline.
 *
 * Header note: ESPN's WAF 403s browser-ish and bare Node user agents on
 * site.api.espn.com from server IPs — a curl UA passes. Keep it that way.
 */
const ESPN_HEADERS = {
  "User-Agent": "curl/8.5.0",
  Accept: "application/json",
};

const cache = new Map<string, { t: number; v: unknown }>();

export async function espnFetch<T>(url: string, ttlMs: number): Promise<T> {
  const hit = cache.get(url);
  if (hit && hit.t > Date.now()) return hit.v as T;
  const res = await fetch(url, { headers: ESPN_HEADERS, cache: "no-store" });
  if (!res.ok) throw new Error(`ESPN ${new URL(url).pathname} -> ${res.status}`);
  const data = (await res.json()) as T;
  cache.set(url, { t: Date.now() + ttlMs, v: data });
  if (cache.size > 250) {
    const now = Date.now();
    for (const [k, e] of cache) if (e.t < now) cache.delete(k);
  }
  return data;
}

/** Lowercase, alphanumerics only, generation suffixes stripped. */
export function normName(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
