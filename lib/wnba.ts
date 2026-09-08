/**
 * WNBA pipeline — mirrors the MLB projection layer using ESPN's public WNBA
 * feeds (Real's WNBA team/player ids are NOT ESPN's, so we map by team name,
 * then by player name + jersey per team roster).
 *
 * Sources (all public, no key):
 *   - slate/status:   site.api.espn.com/.../wnba/scoreboard?dates=YYYYMMDD
 *   - availability:   .../wnba/teams/{id}/roster (scheduled games)
 *   - who played:     .../wnba/summary?event={id} boxscore (live/final)
 *   - season form:    site.web.api.espn.com/apis/common/v3/sports/basketball/
 *                     wnba/athletes/{id} → athlete.statsSummary (PPG/RPG/APG)
 */

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba";
const ESPN_V3 = "https://site.web.api.espn.com/apis/common/v3/sports/basketball/wnba";

export interface WnbaGame {
  gamePk: number; // ESPN event id
  status: string; // STATUS_SCHEDULED / IN_PROGRESS / FINAL ...
  homeTeamId: number; // ESPN team id
  awayTeamId: number;
}

export interface WnbaPlayer {
  id: number; // ESPN id
  name: string; // full display name
  jersey: string;
  pos: string;
  active: boolean;
  /** Per-game production: pts + reb + ast (season averages). */
  pra: number | null;
}

export interface WnbaBox {
  playedIds: Map<number, Set<number>>; // espn teamId -> espn player ids who played
  players: Map<number, Map<number, WnbaPlayer>>;
}

// ── tiny TTL cache (same pattern as lib/mlb.ts) ──
const cache = new Map<string, { t: number; v: unknown }>();
async function espnFetch<T>(url: string, ttlMs: number): Promise<T> {
  const hit = cache.get(url);
  if (hit && hit.t > Date.now()) return hit.v as T;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
      Accept: "application/json",
      Referer: "https://www.espn.com/",
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`ESPN ${new URL(url).pathname} -> ${res.status}`);
  const data = (await res.json()) as T;
  cache.set(url, { t: Date.now() + ttlMs, v: data });
  if (cache.size > 200) {
    const now = Date.now();
    for (const [k, e] of cache) if (e.t < now) cache.delete(k);
  }
  return data;
}
const TTL_ROSTER = 15 * 60 * 1000;
const TTL_DAY = 6 * 60 * 60 * 1000;
const TTL_STATS = 6 * 60 * 60 * 1000;

type TeamsResp = {
  sports: { leagues: { teams: { team: { id: string; displayName: string } }[] }[] }[];
};
/** ESPN WNBA team id by normalized name (e.g. "aces", "golden state valkyries"). */
export async function espnTeamsByName(): Promise<Map<string, number>> {
  const d = await espnFetch<TeamsResp>(`${ESPN}/teams`, TTL_DAY);
  const out = new Map<string, number>();
  for (const t of d.sports[0].leagues[0].teams) {
    out.set(t.team.displayName.toLowerCase().replace(/[^a-z0-9 ]/g, ""), Number(t.team.id));
  }
  return out;
}

type ScoreboardResp = {
  events: {
    id: string;
    status: { type: { name: string } };
    competitions: { competitors: { homeAway: string; team: { id: string; displayName: string } }[] }[];
  }[];
};
/** ESPN slate for a YYYYMMDD date. */
export async function espnScoreboard(dateYYYYMMDD: string): Promise<WnbaGame[]> {
  const d = await espnFetch<ScoreboardResp>(
    `${ESPN}/scoreboard?dates=${dateYYYYMMDD}`,
    TTL_DAY
  );
  return (d.events ?? []).map((e) => {
    const cs = e.competitions[0]?.competitors ?? [];
    const home = cs.find((c) => c.homeAway === "home");
    const away = cs.find((c) => c.homeAway === "away");
    return {
      gamePk: Number(e.id),
      status: e.status?.type?.name ?? "STATUS_SCHEDULED",
      homeTeamId: Number(home?.team?.id ?? 0),
      awayTeamId: Number(away?.team?.id ?? 0),
    };
  });
}

type RosterResp = {
  athletes: {
    id: string;
    displayName?: string;
    jersey?: string;
    position?: { abbreviation?: string } | string;
    status?: { type?: string; name?: string } | string;
  }[];
};
/** Active roster. */
export async function espnRoster(espnTeamId: number): Promise<Map<number, WnbaPlayer>> {
  const d = await espnFetch<RosterResp>(
    `${ESPN}/teams/${espnTeamId}/roster`,
    TTL_ROSTER
  );
  const out = new Map<number, WnbaPlayer>();
  for (const r of d.athletes ?? []) {
    const pos =
      typeof r.position === "string" ? r.position : (r.position?.abbreviation ?? "");
    const status = typeof r.status === "string" ? r.status : (r.status?.name ?? "");
    const active =
      status === "" || status === "Active" || status === "ACT" || status === "active";
    out.set(Number(r.id), {
      id: Number(r.id),
      name: r.displayName ?? "",
      jersey: r.jersey ?? "",
      pos,
      active,
      pra: null,
    });
  }
  return out;
}

type BoxResp = {
  boxscore?: {
    players?: {
      team: { id: string };
      statistics?: {
        athlete?: { id?: string; displayName?: string; jersey?: string };
        stats?: { name?: string; value?: number }[];
      }[];
    }[];
  };
};
/** Who appeared (live/final games only). */
export async function espnBox(
  eventId: number
): Promise<{ played: Map<number, Set<number>>; players: Map<number, Map<number, WnbaPlayer>> } | null> {
  let d: BoxResp;
  try {
    d = await espnFetch<BoxResp>(`${ESPN}/summary?event=${eventId}`, TTL_ROSTER);
  } catch {
    return null;
  }
  const played = new Map<number, Set<number>>();
  const players = new Map<number, Map<number, WnbaPlayer>>();
  for (const g of d.boxscore?.players ?? []) {
    const tid = Number(g.team?.id ?? 0);
    if (!tid) continue;
    const playedSet = played.get(tid) ?? new Set<number>();
    const pmap = players.get(tid) ?? new Map<number, WnbaPlayer>();
    for (const r of g.statistics ?? []) {
      const a = r.athlete ?? {};
      const id = Number(a.id ?? 0);
      if (!id) continue;
      // Boxscore rows carry per-game stats — presence == appeared.
      playedSet.add(id);
      pmap.set(id, {
        id,
        name: a.displayName ?? "",
        jersey: a.jersey ?? "",
        pos: "",
        active: true,
        pra: null,
      });
    }
    if (playedSet.size) played.set(tid, playedSet);
    if (pmap.size) players.set(tid, pmap);
  }
  return { played, players };
}

type V3Resp = {
  athlete?: {
    statsSummary?: {
      statistics?: { name?: string; value?: number }[];
    };
  };
};
/** Season per-game production (pts + reb + ast). */
export async function espnSeasonPra(espnId: number): Promise<number | null> {
  let d: V3Resp;
  try {
    d = await espnFetch<V3Resp>(
      `${ESPN_V3}/athletes/${espnId}`,
      TTL_STATS
    );
  } catch {
    return null;
  }
  const stats = d.athlete?.statsSummary?.statistics ?? [];
  let pts = 0;
  let reb = 0;
  let ast = 0;
  for (const s of stats) {
    if (s.name === "avgPoints") pts = s.value ?? 0;
    else if (s.name === "avgRebounds") reb = s.value ?? 0;
    else if (s.name === "avgAssists") ast = s.value ?? 0;
  }
  const pra = pts + reb + ast;
  return pra > 0 ? pra : null;
}

/** Season form → 0-100: ~10 PRA/game → 0, ~40 PRA/game → 100. */
export function wnbaScore(pra: number | null): number {
  if (pra == null) return 0;
  return Math.round(100 * Math.min(1, Math.max(0, (pra - 10) / 30)));
}
