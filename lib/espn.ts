/**
 * Tiny shared ESPN fetch helper (public feeds, no key). Same TTL-cache pattern
 * as lib/mlb.ts / lib/wnba.ts — used by the CFB pipeline.
 */
const ESPN_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  Accept: "application/json",
  Referer: "https://www.espn.com/",
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
