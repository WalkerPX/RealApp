# Budget marketplace depth

Powers the **Enable Budget Only** checkbox in the Optimal OTD panel. With it on,
the solver's pool is restricted to cards you can actually buy, then the lineup is
re-solved over that pool.

## The rule

A card is **budget-eligible** when it has **at least 2 live marketplace listings
at or under the ceiling** (10 rax per rating, switchable to 20).

`rax per rating` = listing price ÷ the card's own rating (a play card's Real
Rating, a bulk pass's accumulated rating).

This is a **buy-price** measure, not a leveling one — it finds cheap *rating*,
not cheap upgrades. Leveling/enhancement cost is not in this data.

## Why the pool is bounded

The OTD blob carries claim calendars and no prices, and rax-per-rating exists
only on live marketplace listings. Checking all 8,441 OTD cards costs 7 calls
each (~59k calls, ~13h), and listings expire within hours — a full sweep would
be stale before it finished, and no nightly refresh is possible at that size.

So per sport we sweep the **top 80 cards by OTD value UNION the top 40 by best
single claim day** (697 cards across the 7 sports). That covers where
max-earnings lineups come from — k is at most 20 per sport, so 80 is 4x headroom.

A sport with no swept data is **dropped** from a budget solve rather than
ignored, so an unbuyable card can never land in a "budget" lineup.

## Pipeline

```bash
export BUDGET_WORK=/tmp          # scratch dir (pools + jsonl caches)
cd scripts/budget

python3 build_budget_pool.py                    # all sports -> pool files

for s in nhl mlb nba wnba nfl ncaaf ncaam; do   # ~2-4 min each
  python3 sweep_budget.py $s 3
done

python3 audit_budget.py                         # coverage + uncertain cards
python3 deep_budget.py                          # re-walk the uncertain ones

python3 export_otd_budget.py                    # -> lib/otd-budget-data.ts
python3 verify_budget.py 5 10                   # cross-check vs the API

python3 export_budget_searches.py 5 10          # -> lib/budget-searches.ts
python3 verify_budget_searches.py               # every name resolves on Real
python3 verify_budget_scan.py                   # replay each preset at /api/deals
cd ../.. && npm run build
```

Then commit `lib/otd-budget-data.ts` and `lib/budget-searches.ts`.

## Search presets (Walkr's Menu)

`export_budget_searches.py` solves the best 5-card lineup per sport at the
ceiling and emits `lib/budget-searches.ts`, which drives the **Optimal Budget**
buttons in Walkr's Menu. Clicking one loads that lineup's players, flips the
filters to the Low PerRax screen (rating × 11, play cards, all rarities), closes
the window and scans immediately.

The presets read the same data and the same rule as the Optimal OTD panel, so the
two can't drift — but that also means **re-run the generator after every sweep**,
or the buttons will quote lineups the panel no longer agrees with.

`All Sports` is 5 per sport across all 7 sports (35 players). CFB is included for
that to add up, and gets its own button — it would be odd for its players to show
up only inside All Sports.

## Speed

Naive = one call per rarity = 7 per card. This instead asks **once with no rarity
filter**, which returns the exact listing count plus the first page:

| inventory | calls |
|---|---|
| count == 0 | 1 |
| whole inventory fits one page | 1 (exact) |
| deeper | 1 + a walk of the rarities actually present |

~3.3 calls/card, plus 3 paced workers → ~5x faster wall-clock. Full 7-sport
refresh is ~15-20 min. Both sweeps honour `MAX_REQUESTS` / `MAX_SECONDS` and
stop cleanly; caches are jsonl so a re-run resumes.

## Rules that keep the numbers honest

- The no-rarity first page is **discarded** before any rarity walk — an earlier
  version added it on top of the walk and double-counted, inflating cheap counts.
- Only the **cheapest 20** rpr values per card are stored. That still answers
  ">= 2 at or under T" exactly for any T: either the count is under 20 (exact) or
  it is already >= 2.
- Cards that couldn't be fully enumerated **and** showed fewer than 2 cheap
  listings stay **out** — a conservative miss beats recommending a card that
  isn't buyable.
- Prices are a **snapshot**. The UI reports the sweep time per sport; listings
  turn over in hours, so the ceiling is a guide, not a guarantee.

## Dependencies

`real_api.py` + `config.json` from the tracker checkout
(`REAL_TRACKER`, default `/mnt/SharedPool/ace/real-deal-tracker`).
