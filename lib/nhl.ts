/**
 * NHL pipeline — ESPN's public hockey feeds, mirroring the NFL layer.
 *
 * Real's NHL team ids are NOT ESPN's, but a Real team entity carries the
 * hockey-media abbreviation (`key`, e.g. "VGK"), so Real → ESPN is an
 * abbreviation lookup for almost every club. ESPN shortens five of them
 * (LAK→LA, NJD→NJ, SJS→SJ, TBL→TB, UTA→UTAH), so those are aliased, with a
 * display-name fallback behind that. Player pass → ESPN athlete by full name /
 * jersey within the team's roster or boxscore.
 *
 * Sources (public, no key):
 *   - slate/status: site.api.espn.com/.../hockey/nhl/scoreboard?dates=
 *   - availability: .../hockey/nhl/teams/{id}/roster
 *   - who played:   .../hockey/nhl/summary?event={id} boxscore (live/final)
 *   - season form:  site.web.api.espn.com/.../hockey/nhl/athletes/{id}/stats
 *                   → per-season totals (games + goals/assists/points, or
 *                   saves / save % for goalies).
 */

import { espnFetch, normName } from "./espn";

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl";
const ESPN_V3 = "https://site.web.api.espn.com/apis/common/v3/sports/hockey/nhl";

const TTL_ROSTER = 15 * 60 * 1000;
const TTL_DAY = 6 * 60 * 60 * 1000;
const TTL_STATS = 6 * 60 * 60 * 1000;

/** Real abbreviation → ESPN abbreviation, for the clubs ESPN shortens. */
const ABBREV_ALIAS: Record<string, string> = {
  LAK: "LA",
  NJD: "NJ",
  SJS: "SJ",
  TBL: "TB",
  UTA: "UTAH",
};

export interface NhlGame {
  gamePk: number; // ESPN event id
  status: string; // STATUS_SCHEDULED / STATUS_IN_PROGRESS / STATUS_FINAL ...
  homeTeamId: number; // ESPN team id
  awayTeamId: number;
}

export interface NhlPlayer {
  id: number;
  name: string; // full display name
  jersey: string;
  pos: string;
}

type TeamsResp = {
  sports: { leagues: { teams: { team: { id: string; abbreviation?: string; displayName: string } }[] }[] }[];
};
/** ESPN NHL team ids by abbreviation ("VGK"). */
export async function espnNhlTeamsByAbbrev(): Promise<Map<string, number>> {
  const d = await espnFetch<TeamsResp>(`${ESPN}/teams?limit=200`, TTL_DAY);
  const byAbbrev = new Map<string, number>();
  for (const t of d.sports[0].leagues[0].teams) {
    const ab = (t.team.abbreviation ?? "").trim().toUpperCase();
    if (ab) byAbbrev.set(ab, byAbbrev.has(ab) ? -1 : Number(t.team.id));
  }
  return byAbbrev;
}

/** ESPN NHL team ids by normalized full display name ("los angeles kings"). */
export async function espnNhlTeamsByName(): Promise<Map<string, number>> {
  const d = await espnFetch<TeamsResp>(`${ESPN}/teams?limit=200`, TTL_DAY);
  const out = new Map<string, number>();
  for (const t of d.sports[0].leagues[0].teams) {
    out.set(normName(t.team.displayName), Number(t.team.id));
  }
  return out;
}

/** Resolve a Real team to its ESPN id: aliased abbreviation first, then full
 * name, then — only when exactly one slate club matches — the short name
 * ("Kings" → "Los Angeles Kings"). Slate-scoped so it can never pick a club
 * that isn't playing today. */
export function mapRealTeamToEspn(
  abbrev: string,
  displayName: string,
  byAbbrev: Map<string, number>,
  byName: Map<string, number>,
  slateEspnTeams: Set<number>
): number | null {
  const ab = (ABBREV_ALIAS[abbrev] ?? abbrev).trim().toUpperCase();
  const cand = ab ? byAbbrev.get(ab) : undefined;
  if (cand && cand > 0) return cand;
  if (cand === -1) {
    for (const [a, id] of byAbbrev) {
      if (a === ab && slateEspnTeams.has(id)) return id;
    }
  }
  const norm = normName(displayName);
  if (norm) {
    const full = byName.get(norm);
    if (full != null && slateEspnTeams.has(full)) return full;
    const short = norm.split(" ").pop() ?? "";
    const matches = [...byName]
      .filter(([k, id]) => k.endsWith(` ${short}`) && slateEspnTeams.has(id))
      .map(([, id]) => id);
    if (matches.length === 1) return matches[0];
  }
  return null;
}

type ScoreboardResp = {
  events: {
    id: string;
    status: { type: { name: string } };
    competitions: { competitors: { homeAway: string; team: { id: string } }[] }[];
  }[];
};
/** ESPN NHL slate for a YYYYMMDD date. */
export async function espnNhlScoreboard(dateYYYYMMDD: string): Promise<NhlGame[]> {
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
  position: string; // "Centers" | "Left Wings" | ... | "Goalies"
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
/** Active roster (drops injured / non-active players). Hockey rosters come
 * back grouped by position line, but the flat shape is tolerated too. */
export async function espnNhlRoster(espnTeamId: number): Promise<Map<number, NhlPlayer>> {
  const d = await espnFetch<RosterResp>(
    `${ESPN}/teams/${espnTeamId}/roster?limit=200`,
    TTL_ROSTER
  );
  const out = new Map<number, NhlPlayer>();
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
export async function espnNhlBox(
  eventId: number
): Promise<{ played: Map<number, Set<number>>; players: Map<number, Map<number, NhlPlayer>> } | null> {
  let d: BoxResp;
  try {
    d = await espnFetch<BoxResp>(`${ESPN}/summary?event=${eventId}`, TTL_ROSTER);
  } catch {
    return null;
  }
  const played = new Map<number, Set<number>>();
  const players = new Map<number, Map<number, NhlPlayer>>();
  for (const g of d.boxscore?.players ?? []) {
    const tid = Number(g.team?.id ?? 0);
    if (!tid) continue;
    const playedSet = played.get(tid) ?? new Set<number>();
    const pmap = players.get(tid) ?? new Map<number, NhlPlayer>();
    for (const row of g.statistics ?? []) {
      for (const e of row.athletes ?? []) {
        const a = e.athlete ?? {};
        const id = Number(a.id ?? 0);
        if (!id) continue;
        playedSet.add(id);
        pmap.set(id, { id, name: a.displayName ?? "", jersey: a.jersey ?? "", pos: "" });
      }
    }
    if (playedSet.size) played.set(tid, playedSet);
    if (pmap.size) players.set(tid, pmap);
  }
  return { played, players };
}

export interface NhlForm {
  games: number;
  /** Skaters */
  goals: number;
  assists: number;
  points: number;
  /** Goalies */
  saves: number;
  savePct: number;
  wins: number;
}

type StatsResp = {
  categories?: {
    name: string;
    names?: string[];
    statistics?: { season?: { year?: number; displayName?: string }; stats?: (string | number)[] }[];
  }[];
};

/** Games below this are early-season noise (2 games in, a hot start would
 * outrank an established star), so form prefers the newest season with a real
 * sample and only falls back to a thin one when nothing better exists. */
const MIN_FORM_GAMES = 5;

const formCache = new Map<number, { t: number; v: NhlForm }>();

/** Season form for one athlete. ESPN hands back every season they've played;
 * we take the newest row with a real sample (or the newest row at all). */
export async function espnNhlForm(espnId: number): Promise<NhlForm> {
  const hit = formCache.get(espnId);
  if (hit && hit.t > Date.now()) return hit.v;

  const out: NhlForm = { games: 0, goals: 0, assists: 0, points: 0, saves: 0, savePct: 0, wins: 0 };
  let d: StatsResp;
  try {
    d = await espnFetch<StatsResp>(`${ESPN_V3}/athletes/${espnId}/stats`, TTL_STATS);
  } catch {
    return out;
  }
  const names = d.categories?.[0]?.names ?? [];
  const rows = d.categories?.[0]?.statistics ?? [];
  const pick =
    [...rows].reverse().find((r) => {
      const i = names.indexOf("games");
      return i >= 0 && Number(r.stats?.[i] ?? 0) >= MIN_FORM_GAMES;
    }) ?? rows[rows.length - 1];
  if (pick) {
    const val = (name: string): number => {
      const i = names.indexOf(name);
      const n = i >= 0 ? Number(pick.stats?.[i]) : NaN;
      return Number.isFinite(n) ? n : 0;
    };
    out.games = val("games");
    out.goals = val("goals");
    out.assists = val("assists");
    out.points = val("points");
    out.saves = val("saves");
    out.savePct = val("savePct");
    out.wins = val("wins");
  }
  formCache.set(espnId, { t: Date.now() + TTL_STATS, v: out });
  if (formCache.size > 400) {
    const now = Date.now();
    for (const [k, e] of formCache) if (e.t < now) formCache.delete(k);
  }
  return out;
}

/** Season form → 0-100.
 *   Skaters  → points per game: 0.30 → 0, 1.40+ → 100 (elite first-liners sit
 *              high, depth forwards low).
 *   Goalies  → save %: .880 → 0, .930+ → 100.
 *   No sample → 0 (listed, but no form signal). */
export function nhlSkaterScore(points: number, games: number): number {
  if (games <= 0) return 0;
  const ppg = points / games;
  return Math.round(100 * Math.min(1, Math.max(0, (ppg - 0.3) / 1.1)));
}

export function nhlGoalieScore(savePct: number): number {
  return Math.round(100 * Math.min(1, Math.max(0, (savePct - 0.88) / 0.05)));
}
