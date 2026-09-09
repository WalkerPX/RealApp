/**
 * NFL pipeline — mirrors the CFB projection layer using ESPN's public NFL
 * feeds. Real's NFL team ids are NOT ESPN's, so we map Real team → ESPN team
 * by abbreviation/name (slate-disambiguated), then player pass → ESPN athlete
 * by full name + jersey within that team's roster/boxscore.
 *
 * Sources (all public, no key):
 *   - slate/status: site.api.espn.com/.../football/nfl/scoreboard?dates=
 *   - availability: .../football/nfl/teams/{id}/roster (injured players are
 *                   excluded via the injured group / non-active status)
 *   - who played:   .../football/nfl/summary?event={id} boxscore (live/final)
 *   - season form:  site.web.api.espn.com/.../football/nfl/athletes/{id}
 *                   → season totals; divided by completed team games
 *                   (.../teams/{id}/schedule) for per-game production.
 */

import { espnFetch, normName } from "./espn";

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const ESPN_V3 = "https://site.web.api.espn.com/apis/common/v3/sports/football/nfl";

const TTL_ROSTER = 15 * 60 * 1000;
const TTL_DAY = 6 * 60 * 60 * 1000;
const TTL_STATS = 6 * 60 * 60 * 1000;

export interface NflGame {
  gamePk: number; // ESPN event id
  status: string; // STATUS_SCHEDULED / STATUS_IN_PROGRESS / STATUS_FINAL ...
  homeTeamId: number; // ESPN team id
  awayTeamId: number;
}

export interface NflPlayer {
  id: number;
  name: string; // full display name
  jersey: string;
  pos: string;
}

type TeamsResp = {
  sports: { leagues: { teams: { team: { id: string; abbreviation?: string; displayName: string } }[] }[] }[];
};
/** ESPN NFL team ids by abbreviation ("KC") — plus full display names as the
 * fallback map for teams Real names in full or by short name. */
export async function espnTeamsByAbbrev(): Promise<Map<string, number>> {
  const d = await espnFetch<TeamsResp>(`${ESPN}/teams?limit=200`, TTL_DAY);
  const byAbbrev = new Map<string, number>();
  for (const t of d.sports[0].leagues[0].teams) {
    const ab = (t.team.abbreviation ?? "").trim().toUpperCase();
    if (ab) {
      byAbbrev.set(ab, byAbbrev.has(ab) ? -1 : Number(t.team.id));
    }
  }
  return byAbbrev;
}

export async function espnTeamsByName(): Promise<Map<string, number>> {
  const d = await espnFetch<TeamsResp>(`${ESPN}/teams?limit=200`, TTL_DAY);
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
/** ESPN NFL slate for a YYYYMMDD date. */
export async function espnScoreboard(dateYYYYMMDD: string): Promise<NflGame[]> {
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
type FlatRosterAthlete = {
  id: string;
  displayName?: string;
  fullName?: string;
  jersey?: string;
  position?: { abbreviation?: string } | string;
  status?: { type?: string } | string;
};
type RosterResp = { athletes?: (RosterGroup | FlatRosterAthlete)[] };
/** Active roster (drops injured / non-active players; NFL and CFB roster
 * shapes differ slightly, so both grouped and flat layouts are handled). */
export async function espnRoster(espnTeamId: number): Promise<Map<number, NflPlayer>> {
  const d = await espnFetch<RosterResp>(
    `${ESPN}/teams/${espnTeamId}/roster?limit=200`,
    TTL_ROSTER
  );
  const out = new Map<number, NflPlayer>();
  for (const a of d.athletes ?? []) {
    const items = Array.isArray((a as RosterGroup).items)
      ? ((a as RosterGroup).items ?? []).map((it) => ({
          id: it.id,
          displayName: it.displayName,
          jersey: it.jersey,
          posAbbr: it.position?.abbreviation ?? "",
          statusType: it.status?.type,
        }))
      : [
          {
            id: (a as FlatRosterAthlete).id,
            displayName: (a as FlatRosterAthlete).displayName ?? (a as FlatRosterAthlete).fullName,
            jersey: (a as FlatRosterAthlete).jersey,
            posAbbr:
              typeof (a as FlatRosterAthlete).position === "string"
                ? ((a as FlatRosterAthlete).position as string)
                : ((a as FlatRosterAthlete).position as { abbreviation?: string } | undefined)
                    ?.abbreviation ?? "",
            statusType:
              typeof (a as FlatRosterAthlete).status === "string"
                ? ((a as FlatRosterAthlete).status as string)
                : ((a as FlatRosterAthlete).status as { type?: string } | undefined)?.type,
          },
        ];
    const groupName = ((a as RosterGroup).position ?? "").toLowerCase();
    if (groupName.includes("injured") || groupName.includes("out")) continue;
    for (const it of items) {
      const statusType = (it.statusType ?? "").toUpperCase();
      if (statusType && statusType !== "ACTIVE") continue;
      const id = Number(it.id);
      if (!id) continue;
      out.set(id, {
        id,
        name: it.displayName ?? "",
        jersey: it.jersey ?? "",
        pos: it.posAbbr,
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
): Promise<{ played: Map<number, Set<number>>; players: Map<number, Map<number, NflPlayer>> } | null> {
  let d: BoxResp;
  try {
    d = await espnFetch<BoxResp>(`${ESPN}/summary?event=${eventId}`, TTL_ROSTER);
  } catch {
    return null;
  }
  const played = new Map<number, Set<number>>();
  const players = new Map<number, Map<number, NflPlayer>>();
  for (const g of d.boxscore?.players ?? []) {
    const tid = Number(g.team?.id ?? 0);
    if (!tid) continue;
    const playedSet = played.get(tid) ?? new Set<number>();
    const pmap = players.get(tid) ?? new Map<number, NflPlayer>();
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

export interface NflTotals {
  passYds: number;
  passTds: number;
  passerRating: number;
  rushYds: number;
  recYds: number;
  soloTackles: number;
}
type V3Resp = { athlete?: { statsSummary?: { statistics?: { name?: string; value?: number }[] } } };
/** Season stat totals for one athlete (empty object when none logged). NFL
 * names its summary stats slightly differently from CFB (passerRating instead
 * of QBR), so both are tolerated where they overlap. */
export async function espnAthleteTotals(espnId: number): Promise<NflTotals> {
  const t: NflTotals = { passYds: 0, passTds: 0, passerRating: 0, rushYds: 0, recYds: 0, soloTackles: 0 };
  let d: V3Resp;
  try {
    d = await espnFetch<V3Resp>(`${ESPN_V3}/athletes/${espnId}`, TTL_STATS);
  } catch {
    return t;
  }
  for (const s of d.athlete?.statsSummary?.statistics ?? []) {
    const v = s.value ?? 0;
    switch (s.name) {
      case "passingYards":
        t.passYds = v;
        break;
      case "passingTouchdowns":
      case "passingTDs":
        t.passTds = v;
        break;
      case "passerRating":
      case "qbr":
      case "adjQBR":
        t.passerRating = v;
        break;
      case "rushingYards":
        t.rushYds = v;
        break;
      case "receivingYards":
        t.recYds = v;
        break;
      case "soloTackles":
      case "tacklesSolo":
      case "totalTackles":
        t.soloTackles = v;
        break;
    }
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
 *   QBs → passer rating scaled (0-158.3 → 0-100).
 *   Passers (no rating) → passing yds/game: 150 → 0, ~400+ → 100.
 *   Ball-carriers/receivers → scrimmage yds/game: 40 → 0, ~170+ → 100.
 *   Defenders → solo tackles/game: 2 → 0, ~10+ → 100.
 *   Anyone with no stat line yet → 0 (listed, but no form signal). */
export function nflScore(t: NflTotals, teamGamesPlayed: number): number {
  const gp = Math.max(1, teamGamesPlayed);
  if (t.passerRating > 0) {
    return Math.round(Math.min(100, Math.max(0, t.passerRating / 1.583)));
  }
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
