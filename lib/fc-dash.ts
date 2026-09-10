/**
 * FC (soccer) dashboard builder — Real data only. The /home/soccer/next slate
 * lists every club playing today, so a pass is in play when its club appears
 * on that slate; no external stat feed is wired up for soccer, so cards carry
 * no projection score and the booster tier follows the card's own rarity.
 * Booster stat preference is per position: keepers take saves, everyone else
 * goals/assists/duels (Real's soccer stat keys 1 GOAL · 2 AST · 17 SAVE · 29 DUEL).
 *
 * Output shape mirrors the other sport builders so the shared booster-planning
 * tail in the API route works unchanged.
 */

import type { DashboardCard, Game, Team, UserPass } from "./types";
import type { PlayerRole } from "./boost-plan";

export interface FcOutput {
  day: string;
  cards: DashboardCard[];
  candidates: {
    passId: number;
    role: PlayerRole;
    score: number;
    boosted?: boolean;
    statPrefs?: string[];
  }[];
}

const OUTFIELD_STATS = ["1", "2", "29"];
const KEEPER_STATS = ["17"];

/** Card rarity → booster tier, so a Legendary card draws Legendary stock and
 * a common card draws Rare stock. Deterministic, no projections involved. */
const RARITY_SCORE: [string, number][] = [
  ["iconic", 98],
  ["mystic", 92],
  ["legendary", 85],
  ["epic", 70],
  ["rare", 55],
  ["uncommon", 40],
  ["common", 30],
];

function statPrefsFor(infoDetail?: string | null): string[] {
  return (infoDetail ?? "").toUpperCase() === "G" ? KEEPER_STATS : OUTFIELD_STATS;
}

function rarityScore(label?: string | null): number {
  const k = (label ?? "").toLowerCase();
  for (const [key, score] of RARITY_SCORE) if (k.includes(key)) return score;
  return 40;
}

export async function buildFcDashboard(
  passes: UserPass[],
  realSched: { day: string; games: Game[] },
  isSelf: boolean
): Promise<FcOutput> {
  const cards: DashboardCard[] = [];
  const candidates: FcOutput["candidates"] = [];

  // Club → today's game (a club plays at most once a day).
  const byTeam = new Map<number, Game>();
  for (const g of realSched.games) {
    byTeam.set(g.homeTeamId, g);
    byTeam.set(g.awayTeamId, g);
  }

  for (const pass of passes) {
    const teamId = pass.entityType === "team" ? pass.entity.id : pass.entity.teamId ?? 0;
    const game = byTeam.get(teamId);
    if (!game) continue; // club isn't on today's slate
    const opponent: Team = game.homeTeamId === teamId ? game.awayTeam : game.homeTeam;

    if (pass.entityType === "team") {
      cards.push({
        pass,
        game,
        opponent,
        role: "team",
        score: null,
        lineupTbd: false,
        suggestedBooster: null,
      });
      continue;
    }

    const injury = pass.entity.injuryStatus?.toLowerCase();
    if (injury && injury !== "active" && injury !== "available") continue;

    cards.push({
      pass,
      game,
      opponent,
      role: "hitter",
      score: null,
      lineupTbd: false,
      suggestedBooster: null,
    });
    if (isSelf) {
      candidates.push({
        passId: pass.id,
        role: "hitter",
        score: rarityScore(pass.boostInfo?.rarityLabel),
        boosted: pass.boostInfo.isCardBoosted === true,
        statPrefs: statPrefsFor(pass.infoDetail),
      });
    }
  }

  return { day: realSched.day, cards, candidates };
}
