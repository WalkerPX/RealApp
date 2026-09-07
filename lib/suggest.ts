import type { BoosterInventory, SuggestedBooster } from "./types";

// Pick the best available booster: highest rarity with stock first, then the
// highest boost value within that rarity. Read-only suggestion — applying it
// is left to the person in the actual Real app.
export function suggestBestBooster(
  inventory: BoosterInventory
): SuggestedBooster | null {
  const groupsWithStock = inventory.rarityGroups.filter((g) => g.count > 0);
  if (groupsWithStock.length === 0) return null;

  const bestGroup = groupsWithStock.reduce((best, g) =>
    g.rarity > best.rarity ? g : best
  );

  const inStockStats = bestGroup.statBoostKeyInfo.filter((s) => s.count > 0);
  if (inStockStats.length === 0) return null;

  const bestStat = inStockStats.reduce((best, s) => {
    const bestVal = parseFloat(best.info[0]?.boostValue ?? "0");
    const val = parseFloat(s.info[0]?.boostValue ?? "0");
    return val > bestVal ? s : best;
  });

  return {
    rarity: bestGroup.rarity,
    rarityLabel: bestGroup.label,
    multiplierDisplay: bestGroup.multiplierDisplay,
    statLabel: bestStat.info.map((i) => i.label).join(" + "),
    boostValue: bestStat.info.map((i) => i.boostValue).join(" / "),
    remainingCount: bestStat.count,
  };
}
