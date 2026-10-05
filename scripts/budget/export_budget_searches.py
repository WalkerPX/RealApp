#!/usr/bin/env python3
"""Emit lib/budget-searches.ts — the Optimal Budget search presets.

For each sport, solve the best K-card lineup at the budget ceiling (same rule the
Optimal OTD panel uses: >= 2 live listings at or under the ceiling), then emit one
preset per sport plus an "All Sports" preset holding every sport's cards.

The shop's quick-search buttons feed exactly these players into the existing
scan, so the presets and the OTD panel can never drift apart: re-run this after a
sweep.

usage: export_budget_searches.py [K] [CEILING]
"""
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
K = int(sys.argv[1]) if len(sys.argv) > 1 else 5
CEIL = int(sys.argv[2]) if len(sys.argv) > 2 else 10

# menu order requested by the user, then CFB — All Sports is 5 per sport across
# all 7, so CFB's lineup has to be there for the 35 to add up.
ORDER = ["nba", "nhl", "nfl", "ncaam", "mlb", "wnba", "ncaaf"]
LABEL = {"nba": "NBA", "nhl": "NHL", "nfl": "NFL", "ncaam": "CBB",
         "mlb": "MLB", "wnba": "WNBA", "ncaaf": "CFB"}

# Cards a lineup keeps on purpose even though the solver wouldn't pick them, each
# with the ceiling it is bought at. These are the deep-market cards: a few extra
# rax per rating buys a lot more copies, which is what levels a card to Legendary
# quickly. Everyone else in that sport still screens at CEIL.
EXTRA = {"nhl": [("Jack Eichel", 2025, 15), ("Filip Forsberg", 2023, 15)]}


def load(ts_path: Path, name: str) -> str:
    s = ts_path.read_text()
    lit = s[s.index(name) + len(name):].strip().split("\n")[0].strip().rstrip(";").strip()
    return lit.strip("'").replace("\\'", "'").replace('\\"', '"')


raw = json.loads(load(REPO / "lib" / "otd-optimal-data.ts", "OTD_DATA ="))
bdata = json.loads(load(REPO / "lib" / "otd-budget-data.ts", "OTD_BUDGET_DATA ="))

DAYS = 366


def base_obj(sel):
    """Per-day top-two sum: what a lineup actually claims (2 claims/sport/day)."""
    t = 0
    for i in range(DAYS):
        a = b2 = 0
        for c in sel:
            x = c[3][i]
            if x > a:
                b2, a = a, x
            elif x > b2:
                b2 = x
        t += a + b2
    return t


def card_of(sport, name, season):
    """The (name, season, pid, vec) tuple for one card, or None."""
    for nm, se, pid, pairs in raw[sport]["cards"]:
        if nm == name and se == season:
            vec = [0] * DAYS
            for i, val in pairs:
                vec[i] = val
            return (nm, se, pid, vec)
    return None


def solve(sport):
    def elig(season, pid):
        row = bdata.get(sport, {}).get(str(season), {}).get(str(pid))
        return bool(row) and sum(1 for x in row[1] if float(x) <= CEIL) >= 2

    cards = []
    for name, season, pid, pairs in raw[sport]['cards']:
        if not elig(season, pid):
            continue
        vec = [0] * DAYS
        for i, val in pairs:
            vec[i] = val
        cards.append((name, season, pid, vec))
    if not cards:
        return [], 0

    def obj(sel):
        t = 0
        for i in range(DAYS):
            a = b2 = 0
            for c in sel:
                x = c[3][i]
                if x > a:
                    b2, a = a, x
                elif x > b2:
                    b2 = x
            t += a + b2
        return t

    sel = []
    for _ in range(K):
        sec = [0] * DAYS
        for i in range(DAYS):
            vs = sorted((c[3][i] for c in sel), reverse=True)
            sec[i] = vs[1] if len(vs) > 1 else 0
        best, bc = 0, None
        for c in cards:
            if c in sel:
                continue
            g = sum(max(0, c[3][i] - sec[i]) for i in range(DAYS))
            if g > best:
                best, bc = g, c
        if not bc:
            break
        sel.append(bc)
    cur = obj(sel)
    for _ in range(20):
        imp = False
        for r in range(len(sel)):
            rest = [c for j, c in enumerate(sel) if j != r]
            sec = [0] * DAYS
            for i in range(DAYS):
                vs = sorted((c[3][i] for c in rest), reverse=True)
                sec[i] = vs[1] if len(vs) > 1 else 0
            best, bc = 0, None
            for c in cards:
                if c in sel:
                    continue
                g = sum(max(0, c[3][i] - sec[i]) for i in range(DAYS))
                if g > best:
                    best, bc = g, c
            if bc:
                cand = rest + [bc]
                if obj(cand) > cur:
                    sel, cur, imp = cand, obj(cand), True
                    break
        if not imp:
            break
    return sorted(sel, key=lambda c: -c[1]), cur


presets = []
all_slices = []
all_caps = {}
for sport in ORDER:
    sel, cur = solve(sport)
    if not sel:
        print(f"  {sport}: no eligible cards")
        continue
    # Forced extras ride along on top of the solved lineup — the lineup still
    # claims only its best two a day, so they can only add.
    extras = [card_of(sport, n, se) for n, se, _ in EXTRA.get(sport, [])]
    extras = [e for e in extras if e]
    if extras:
        sel = sel + [e for e in extras if e not in sel]
        cur = base_obj(sel)
    caps = {n: cap for n, _, cap in EXTRA.get(sport, [])}
    all_caps.update(caps)
    # group the sport's cards by season so each slice is a valid market query
    by_season = {}
    for name, season, pid, _ in sel:
        by_season.setdefault(season, []).append(name)
    slices = [{"sport": sport, "season": se, "players": ps}
              for se, ps in sorted(by_season.items(), key=lambda kv: -kv[0])]
    all_slices.extend(slices)
    preset = {"id": sport, "sport": sport, "season": sel[0][1],
              "label": LABEL.get(sport, sport.upper()), "cards": len(sel),
              "best": cur, "slices": slices}
    if caps:
        preset["playerCaps"] = caps
    presets.append(preset)
    for name, season, pid, _ in sel:
        print(f"  {sport:6} {name:24} s{season}" + ("   <-- extra" if (name, season) in
              {(n, se) for n, se, _ in EXTRA.get(sport, [])} else ""))

# the All Sports preset unions every sport's lineup, keeping the requested order
all_preset = {"id": "all", "sport": "all", "season": 0, "label": "All Sports",
              "cards": sum(len(s["players"]) for s in all_slices),
              "best": sum(p["best"] for p in presets), "slices": all_slices}
if all_caps:
    all_preset["playerCaps"] = all_caps
presets.append(all_preset)

def preset_body(p):
    lines = [
        "  {",
        f'    id: "{p["id"]}",',
        f'    label: "{p["label"]}",',
        f'    cards: {p["cards"]},',
        f'    best: {p["best"]},',
    ]
    if p.get("playerCaps"):
        lines.append("    playerCaps: " +
                     json.dumps(p["playerCaps"], separators=(", ", ": ")) + ",")
    lines.append("    slices: " +
                 json.dumps(p["slices"], separators=(",", ": ")) + ",")
    lines.append("  }")
    return "\n".join(lines)


body = ",\n".join(preset_body(p) for p in presets)

out = f'''/** Generated by scripts/budget/export_budget_searches.py — do not hand-edit.
 *
 * The Optimal Budget search presets shown in Walkr's Menu. Each preset's players
 * come from the best {K}-card On-This-Day lineup at the budget ceiling
 * ({CEIL} rax/rating, >= 2 live listings) — the same rule and the same data the
 * Optimal OTD panel uses, so the two can't drift. Re-run the generator after a
 * sweep.
 *
 * Grouped per sport into {{sport, season}} slices because a marketplace query is
 * always one sport/season; "All Sports" is every sport's lineup at once.
 *
 * A preset may also carry `playerCaps`: per-player rax-per-rating ceilings for
 * cards the lineup buys looser than the ceiling on purpose (deep market => you
 * can level them to Legendary fast). Everyone else in the lineup screens at the
 * ceiling. Keep both in sync by re-running the generator.
 */
import type {{ WalkerOtdSlice }} from "./deals";

export interface BudgetSearchPreset {{
  id: string;
  label: string;
  /** How many players the preset searches for. */
  cards: number;
  /** Base rax/yr the lineup is worth (unboosted). */
  best: number;
  /** Per-player ceilings, for cards bought above BUDGET_SEARCH_CEILING. */
  playerCaps?: Record<string, number>;
  slices: WalkerOtdSlice[];
}}

/** Ceiling the lineups were solved at, in rax per rating point. */
export const BUDGET_SEARCH_CEILING = {CEIL};

/** Rating factor the quick searches run at — the Low PerRax screen. */
export const BUDGET_SEARCH_FACTOR = 11;

export const BUDGET_SEARCH_PRESETS: BudgetSearchPreset[] = [
{body},
];
'''
dst = REPO / "lib" / "budget-searches.ts"
dst.write_text(out)
print(f"\nwrote {dst} ({len(out)} bytes), {len(presets)} presets, "
      f"{presets[-1]['cards']} players in All Sports")
