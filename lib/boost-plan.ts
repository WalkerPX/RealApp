import type { BoosterInventory, BoosterRarityGroup, SuggestedBooster } from "./types";

export type PlayerRole = "pitcher" | "hitter";

export interface PlanCandidate {
  passId: number;
  role: PlayerRole;
  score: number; // 0-100 projection
}

interface StatPick {
  statBoostKey: string;
  statLabel: string;
  boostValue: string;
  remaining: number;
}

/** In-place budget: picks a stat within a rarity group, consuming one unit. */
function takeStat(
  group: BoosterRarityGroup,
  preferredKeys: string[]
): StatPick | null {
  for (const key of preferredKeys) {
    const entry = group.statBoostKeyInfo.find(
      (s) => s.statBoostKey === key && s.count > 0
    );
    if (entry) {
      entry.count -= 1;
      return {
        statBoostKey: key,
        statLabel: entry.info.map((i) => i.label).join(" + "),
        boostValue: entry.info.map((i) => i.boostValue).join(" / "),
        remaining: entry.count,
      };
    }
  }
  // Any in-stock stat as last resort
  const any = group.statBoostKeyInfo.find((s) => s.count > 0);
  if (any) {
    any.count -= 1;
    return {
      statBoostKey: any.statBoostKey,
      statLabel: any.info.map((i) => i.label).join(" + "),
      boostValue: any.info.map((i) => i.boostValue).join(" / "),
      remaining: any.count,
    };
  }
  return null;
}

function takeFromRarity(
  groups: BoosterRarityGroup[],
  rarity: number,
  role: PlayerRole
): { pick: StatPick; group: BoosterRarityGroup } | null {
  const group = groups.find((g) => g.rarity === rarity && g.count > 0);
  if (!group) return null;
  // Pitchers boost on strikeouts (stat key "70"). Hitters prefer power
  // (HR/3B) then 2B, RBI, R — whatever the card's own stats are worth most.
  const preferred =
    role === "pitcher" ? ["70", "3", "5"] : ["2_11", "10", "3", "5", "70"];
  const pick = takeStat(group, preferred);
  if (!pick) return null;
  group.count -= 1;
  return { pick, group };
}

/**
 * Plan booster allocations across all projected cards.
 *
 * Tiers by projection score:
 *   hitters:  ≥80 → Legendary · ≥58 → Epic · else Rare
 *   pitchers: score ≥75 → Legendary, else Epic — pitchers are reserved for
 *   the strongest boosters (their stat hits are rare, so multipliers matter
 *   most). A pitcher only falls to Rare when score ≥60 and no Epic stock is
 *   left, or when nothing better remains for anyone.
 *
 * Higher projection → bigger boost, by construction: we process cards in
 * descending score order and grant the strongest stock first.
 */
export function planBoosts(
  candidates: PlanCandidate[],
  inventory: BoosterInventory
): Map<number, SuggestedBooster> {
  const groups = inventory.rarityGroups.map((g) => ({ ...g, statBoostKeyInfo: g.statBoostKeyInfo.map((s) => ({ ...s })) }));
  const tiers = (role: PlayerRole, score: number): number[] => {
    if (role === "pitcher") {
      if (score >= 75) return [5, 4, 3];
      if (score >= 60) return [4, 5, 3];
      return [4, 3, 5]; // weak pitchers shouldn't eat Legendary stock
    }
    if (score >= 80) return [5, 4, 3];
    if (score >= 58) return [4, 5, 3];
    return [3, 4, 5];
  };

  const out = new Map<number, SuggestedBooster>();
  const ranked = [...candidates].sort((a, b) => b.score - a.score);

  for (const c of ranked) {
    for (const rarity of tiers(c.role, c.score)) {
      const taken = takeFromRarity(groups, rarity, c.role);
      if (!taken) continue;
      const { pick, group } = taken;
      out.set(c.passId, {
        rarity: group.rarity,
        rarityLabel: group.label,
        multiplierDisplay: group.multiplierDisplay,
        statLabel: pick.statLabel,
        boostValue: pick.boostValue,
        remainingCount: pick.remaining,
      });
      break;
    }
  }
  return out;
}
