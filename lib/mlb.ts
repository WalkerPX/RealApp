/**
 * MLB StatsAPI client (public, no key) — lineup/boxscore reality + season
 * stats used to project "is this player likely to have a good game today".
 *
 * Real's team ids ARE MLB team ids (110 = BAL Orioles, etc.), so no mapping
 * is needed. Players match by team + jersey number.
 */

const BASE = "https://statsapi.mlb.com/api/v1";

export interface MlbGame {
  gamePk: number;
  status: string; // Scheduled / Live / Final ...
  homeTeamId: number;
  awayTeamId: number;
  homeProbable: number | null;
  awayProbable: number | null;
}

export interface MlbPlayerStats {
  id: number;
  name: string; // fullName, for fuzzy match when jerseys drift
  jersey: string;
  posAbbr: string;
  statusCode: string;
  bat: { games: number; obp: number; slg: number } | null;
  pit: { games: number; ip: number; so: number; era: number } | null;
}

interface BoxScore {
  playedIds: Set<number>;
  players: Map<number, MlbPlayerStats>;
}

// ── tiny TTL cache (per serverless instance; pruned on overflow) ──
const cache = new Map<string, { ttl: number; data: unknown }>();
const TTL_FINAL = 6 * 60 * 60 * 1000;
const TTL_LIVE = 2 * 60 * 1000;
const TTL_SCHED = 15 * 60 * 1000;

async function mlbFetch<T>(path: string, ttlMs: number): Promise<T> {
  const hit = cache.get(path);
  if (hit && hit.ttl > Date.now()) return hit.data as T;
  const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`MLB StatsAPI ${path.split("?")[0]} -> ${res.status}`);
  const data = (await res.json()) as T;
  cache.set(path, { ttl: Date.now() + ttlMs, data });
  if (cache.size > 150) {
    const now = Date.now();
    for (const [k, v] of cache) if (v.ttl < now) cache.delete(k);
  }
  return data;
}

function ttlFor(status: string): number {
  if (status === "Final") return TTL_FINAL;
  if (status === "Scheduled") return TTL_SCHED;
  return TTL_LIVE;
}

type SchedResp = {
  dates: { games: {
    gamePk: number;
    status: { detailedState: string };
    teams: {
      home: { team: { id: number }; probablePitcher?: { id: number } };
      away: { team: { id: number }; probablePitcher?: { id: number } };
    };
  }[] }[];
};

export async function getTodaysMlbGames(dateISO: string): Promise<MlbGame[]> {
  const d = await mlbFetch<SchedResp>(
    `/schedule?sportId=1&date=${dateISO}&hydrate=probablePitcher`,
    TTL_SCHED
  );
  return (d.dates?.[0]?.games ?? []).map((g) => ({
    gamePk: g.gamePk,
    status: g.status.detailedState,
    homeTeamId: g.teams.home.team.id,
    awayTeamId: g.teams.away.team.id,
    homeProbable: g.teams.home.probablePitcher?.id ?? null,
    awayProbable: g.teams.away.probablePitcher?.id ?? null,
  }));
}

type BoxResp = {
  teams: Record<"home" | "away", {
    team: { id: number };
    batters: number[];
    pitchers: number[];
    players: Record<string, {
      person: { id: number; fullName?: string };
      jerseyNumber: string;
      position: { abbreviation: string };
      status: { code: string };
      seasonStats: {
        batting?: { gamesPlayed?: number; obp?: string; slg?: string };
        pitching?: { gamesPlayed?: number; inningsPitched?: string; strikeOuts?: number; era?: string };
      };
    }>;
  }>;
};

export async function getBoxScore(gamePk: number, status: string): Promise<BoxScore | null> {
  let d: BoxResp;
  try {
    d = await mlbFetch<BoxResp>(`/game/${gamePk}/boxscore`, ttlFor(status));
  } catch {
    return null; // boxscore not available yet (pre-game)
  }
  const playedIds = new Set<number>();
  const players = new Map<number, MlbPlayerStats>();
  for (const side of ["home", "away"] as const) {
    const t = d.teams[side];
    for (const id of [...(t.batters ?? []), ...(t.pitchers ?? [])]) playedIds.add(id);
    for (const p of Object.values(t.players ?? {})) {
      const ss = p.seasonStats ?? {};
      players.set(p.person.id, {
        id: p.person.id,
        name: p.person.fullName ?? "",
        jersey: p.jerseyNumber,
        posAbbr: p.position?.abbreviation ?? "",
        statusCode: p.status?.code ?? "",
        bat: ss.batting?.gamesPlayed
          ? {
              games: ss.batting.gamesPlayed,
              obp: parseFloat(ss.batting.obp ?? "0"),
              slg: parseFloat(ss.batting.slg ?? "0"),
            }
          : null,
        pit: ss.pitching?.gamesPlayed
          ? {
              games: ss.pitching.gamesPlayed,
              ip: parseFloat(ss.pitching.inningsPitched ?? "0"),
              so: ss.pitching.strikeOuts ?? 0,
              era: parseFloat(ss.pitching.era ?? "99"),
            }
          : null,
      });
    }
  }
  return { playedIds, players };
}

type RosterResp = {
  roster: {
    person: {
      id: number;
      fullName?: string;
      stats?: { group: { displayName: string }; splits: { stat: Record<string, string | number> }[] }[];
    };
    jerseyNumber: string;
    position: { abbreviation: string };
    status: { code: string };
  }[];
};

/** Full active roster with season stats — for games that haven't started. */
export async function getRoster(teamId: number): Promise<Map<number, MlbPlayerStats>> {
  const d = await mlbFetch<RosterResp>(
    `/teams/${teamId}/roster?season=${new Date().getFullYear()}` +
      `&hydrate=person(stats(group=%5Bhitting,pitching%5D,type=%5Bseason%5D,season=${new Date().getFullYear()}))`,
    TTL_SCHED
  );
  const out = new Map<number, MlbPlayerStats>();
  for (const r of d.roster ?? []) {
    const statOf = (kind: "batting" | "pitching") => {
      // MLB hydrate names the group "hitting", season-stats calls it
      // "batting" — accept either.
      const g = (r.person.stats ?? []).find((s) => {
        const dn = s.group.displayName.toLowerCase();
        return kind === "pitching" ? dn.startsWith("pitch") : dn.startsWith("hitt") || dn.startsWith("batt");
      });
      const st = g?.splits?.[0]?.stat ?? {};
      return st;
    };
    const b = statOf("batting");
    const p = statOf("pitching");
    out.set(r.person.id, {
      id: r.person.id,
      name: r.person.fullName ?? "",
      jersey: r.jerseyNumber,
      posAbbr: r.position?.abbreviation ?? "",
      statusCode: r.status?.code ?? "",
      bat: Number(b.gamesPlayed ?? 0) > 0
        ? { games: Number(b.gamesPlayed), obp: parseFloat(String(b.obp ?? "0")), slg: parseFloat(String(b.slg ?? "0")) }
        : null,
      pit: Number(p.gamesPlayed ?? 0) > 0 && Number(p.inningsPitched ?? 0) > 0
        ? { games: Number(p.gamesPlayed), ip: parseFloat(String(p.inningsPitched)), so: Number(p.strikeOuts ?? 0), era: parseFloat(String(p.era ?? "99")) }
        : null,
    });
  }
  return out;
}

type LeadersResp = {
  stats: { splits: { player: { id: number }; stat: Record<string, unknown> }[] }[];
};

/** Top-25 qualified pitchers by K/9 this season (sorted desc; min 50 IP skips
 * openers/position players). K booster suggestions are reserved for these. */
export async function getTopK9Ids(season: number): Promise<Set<number>> {
  const d = await mlbFetch<LeadersResp>(
    `/stats?stats=season&group=pitching&gameType=R&sportIds=1&season=${season}&sortStat=strikeOutsPer9Inn&limit=60`,
    TTL_SCHED
  );
  const ranked: number[] = [];
  for (const s of d.stats?.[0]?.splits ?? []) {
    const ip = Number(s.stat.inningsPitched ?? 0);
    if (ip >= 50) ranked.push(s.player.id);
    if (ranked.length >= 25) break;
  }
  return new Set(ranked);
}

// ── projection scores (season form → 0-100) ──────────────────

/** Batters: OPS-based. ~.620 → 0, ~1.040 → 100. */
export function batterScore(s: NonNullable<MlbPlayerStats["bat"]>): number {
  if (!s || s.games < 10) return 0;
  const ops = s.obp + s.slg;
  return Math.round(100 * Math.min(1, Math.max(0, (ops - 0.62) / 0.42)));
}

/** Pitchers: K/9 (60%) + ERA (40%). */
export function pitcherScore(s: NonNullable<MlbPlayerStats["pit"]>): number {
  if (!s || s.ip < 20) return 0;
  const k9 = (s.so * 9) / s.ip;
  const kPart = Math.min(1, Math.max(0, (k9 - 5.5) / 7));
  const ePart = Math.min(1, Math.max(0, (4.8 - s.era) / 2.6));
  return Math.round(100 * (0.55 * kPart + 0.45 * ePart));
}
