/**
 * CFB (college football) pipeline — mirrors the WNBA projection layer using
 * ESPN's public college-football feeds. Real's CFB team/player ids are NOT
 * ESPN's, and Real's schedule only carries team abbreviations ("FSU"), so we
 * map Real team → ESPN team by abbreviation/name, then player pass → ESPN
 * athlete by full name + jersey within that team's roster.
 *
 * Sources (all public, no key):
 *   - slate/status: site.api.espn.com/.../college-football/scoreboard?dates=
 *   - availability: .../college-football/teams/{id}/roster (scheduled games;
 *                   ESPN groups injured players under injuredReserveOrOut)
 *   - who played:   .../college-football/summary?event={id} boxscore (live/final)
 *   - season form:  site.web.api.espn.com/.../college-football/athletes/{id}
 *                   → season totals; divided by the team's completed games
 *                   (.../teams/{id}/schedule) to get per-game production.
 */

import { espnFetch, normName } from "./espn";

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/college-football";
const ESPN_V3 =
  "https://site.web.api.espn.com/apis/common/v3/sports/football/college-football";

const TTL_ROSTER = 15 * 60 * 1000;
const TTL_DAY = 6 * 60 * 60 * 1000;
const TTL_STATS = 6 * 60 * 60 * 1000;

export interface CfbGame {
  gamePk: number; // ESPN event id
  status: string; // STATUS_SCHEDULED / STATUS_IN_PROGRESS / STATUS_FINAL ...
  homeTeamId: number; // ESPN team id
  awayTeamId: number;
}

export interface CfbPlayer {
  id: number;
  name: string; // full display name
  jersey: string;
  pos: string;
}

type TeamsResp = {
  sports: { leagues: { teams: { team: { id: string; abbreviation?: string; displayName: string } }[] }[] }[];
};
/**
 * ESPN CFB team ids by abbreviation ("FSU") — Real's CFB schedule names teams
 * by abbreviation only. Also keeps full display names as a fallback map for
 * teams Real ever names in full.
 */
export async function espnTeamsByAbbrev(): Promise<Map<string, number>> {
  const d = await espnFetch<TeamsResp>(`${ESPN}/teams?limit=2000`, TTL_DAY);
  const byAbbrev = new Map<string, number>();
  for (const t of d.sports[0].leagues[0].teams) {
    const ab = (t.team.abbreviation ?? "").trim().toUpperCase();
    if (ab) {
      // Ambiguous abbreviations (e.g. OSU = Ohio State + Oregon State) resolve
      // later against the actual slate — see resolveRealTeams in cfb-dash.
      byAbbrev.set(ab, byAbbrev.has(ab) ? -1 : Number(t.team.id));
    }
  }
  return byAbbrev;
}

/** ESPN CFB team display names (normalized) → id — fallback when a Real team
 * name is spelled out rather than abbreviated. */
export async function espnTeamsByName(): Promise<Map<string, number>> {
  const d = await espnFetch<TeamsResp>(`${ESPN}/teams?limit=2000`, TTL_DAY);
  const out = new Map<string, number>();
  for (const t of d.sports[0].leagues[0].teams) {
    out.set(normName(t.team.displayName), Number(t.team.id));
  }
  return out;
}

type ScoreboardResp = {
  events: {
    id: string;
    status: { type: { name: string } };
    competitions: { competitors: { homeAway: string; team: { id: string } }[] }[];
  }[];
};
/** ESPN CFB slate for a YYYYMMDD date. */
export async function espnScoreboard(dateYYYYMMDD: string): Promise<CfbGame[]> {
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

type RosterGroup = {
  position: string; // "offense" | "defense" | "specialTeam" | "injuredReserveOrOut"
  items?: {
    id: string;
    displayName?: string;
    jersey?: string;
    position?: { abbreviation?: string };
    status?: { type?: string };
  }[];
};
type RosterResp = { athletes?: RosterGroup[] };
/** Active roster (excludes the injuredReserveOrOut group ESPN tracks). */
export async function espnRoster(espnTeamId: number): Promise<Map<number, CfbPlayer>> {
  const d = await espnFetch<RosterResp>(
    `${ESPN}/teams/${espnTeamId}/roster?limit=200`,
    TTL_ROSTER
  );
  const out = new Map<number, CfbPlayer>();
  for (const g of d.athletes ?? []) {
    if (g.position === "injuredReserveOrOut") continue;
    for (const a of g.items ?? []) {
      const statusType = a.status?.type;
      if (statusType && statusType !== "active") continue;
      out.set(Number(a.id), {
        id: Number(a.id),
        name: a.displayName ?? "",
        jersey: a.jersey ?? "",
        pos: a.position?.abbreviation ?? "",
      });
    }
  }
  return out;
}

type BoxResp = {
  boxscore?: {
    players?: {
      team?: { id: string };
      statistics?: {
        athletes?: { athlete?: { id?: string; displayName?: string; jersey?: string } }[];
      }[];
    }[];
  };
};
/** Who appeared in a live/final game (any boxscore stat row). */
export async function espnBox(
  eventId: number
): Promise<{ played: Map<number, Set<number>>; players: Map<number, Map<number, CfbPlayer>> } | null> {
  let d: BoxResp;
  try {
    d = await espnFetch<BoxResp>(`${ESPN}/summary?event=${eventId}`, TTL_ROSTER);
  } catch {
    return null;
  }
  const played = new Map<number, Set<number>>();
  const players = new Map<number, Map<number, CfbPlayer>>();
  for (const g of d.boxscore?.players ?? []) {
    const tid = Number(g.team?.id ?? 0);
    if (!tid) continue;
    const playedSet = played.get(tid) ?? new Set<number>();
    const pmap = players.get(tid) ?? new Map<number, CfbPlayer>();
    for (const row of g.statistics ?? []) {
      for (const e of row.athletes ?? []) {
        const a = e.athlete ?? {};
        const id = Number(a.id ?? 0);
        if (!id) continue;
        playedSet.add(id);
        pmap.set(id, {
          id,
          name: a.displayName ?? "",
          jersey: a.jersey ?? "",
          pos: "",
        });
      }
    }
    if (playedSet.size) played.set(tid, playedSet);
    if (pmap.size) players.set(tid, pmap);
  }
  return { played, players };
}

type AthTotals = {
  passYds: number;
  passTds: number;
  adjQbr: number;
  rushYds: number;
  recYds: number;
  soloTackles: number;
};
type V3Resp = { athlete?: { statsSummary?: { statistics?: { name?: string; value?: number }[] } } };
/** Season stat totals for one athlete (empty object when none logged). */
export async function espnAthleteTotals(espnId: number): Promise<AthTotals> {
  const t: AthTotals = { passYds: 0, passTds: 0, adjQbr: 0, rushYds: 0, recYds: 0, soloTackles: 0 };
  let d: V3Resp;
  try {
    d = await espnFetch<V3Resp>(`${ESPN_V3}/athletes/${espnId}`, TTL_STATS);
  } catch {
    return t;
  }
  for (const s of d.athlete?.statsSummary?.statistics ?? []) {
    const v = s.value ?? 0;
    if (s.name === "passingYards") t.passYds = v;
    else if (s.name === "passingTouchdowns") t.passTds = v;
    else if (s.name === "adjQBR") t.adjQbr = v;
    else if (s.name === "rushingYards") t.rushYds = v;
    else if (s.name === "receivingYards") t.recYds = v;
    else if (s.name === "soloTackles") t.soloTackles = v;
  }
  return t;
}

type SchedResp = { events?: { status?: { type?: { completed?: boolean } } }[] };
/** Completed games this season — divisor for per-game production. */
export async function espnTeamGamesPlayed(espnTeamId: number, season: number): Promise<number> {
  try {
    const d = await espnFetch<SchedResp>(
      `${ESPN}/teams/${espnTeamId}/schedule?season=${season}`,
      TTL_DAY
    );
    return (d.events ?? []).filter((e) => e.status?.type?.completed === true).length;
  } catch {
    return 0;
  }
}

/** Season form → 0-100 (per-game, position-aware by whichever stat keys the
 * athlete actually has logged):
 *   QBs with an ESPN QBR → QBR itself (0-100 scale).
 *   Passers (no QBR) → passing yds/game: 150 → 0, ~400+ → 100.
 *   Ball-carriers/receivers → scrimmage yds/game: 40 → 0, ~170+ → 100.
 *   Defenders → solo tackles/game: 2 → 0, ~10+ → 100.
 *   Anyone with no stat line yet → 0 (listed, but no form signal). */
export function cfbScore(
  t: AthTotals,
  teamGamesPlayed: number
): number {
  const gp = Math.max(1, teamGamesPlayed);
  if (t.adjQbr > 0) return Math.round(Math.min(100, Math.max(0, t.adjQbr)));
  if (t.passYds > 0 || t.passTds > 0) {
    const ypg = t.passYds / gp;
    return Math.round(100 * Math.min(1, Math.max(0, (ypg - 150) / 250)));
  }
  const scrim = t.rushYds + t.recYds;
  if (scrim > 0) {
    const ypg = scrim / gp;
    return Math.round(100 * Math.min(1, Math.max(0, (ypg - 40) / 130)));
  }
  if (t.soloTackles > 0) {
    const perG = t.soloTackles / gp;
    return Math.round(100 * Math.min(1, Math.max(0, (perG - 2) / 8)));
  }
  return 0;
}
