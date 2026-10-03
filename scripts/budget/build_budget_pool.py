#!/usr/bin/env python3
"""Build the budget sweep pool from the OTD calendars.

The pool is deliberately bounded: resolving marketplace depth costs ~3-7 API
calls per card, and listings expire within hours, so sweeping all 8,441 OTD
cards (~59k calls, ~13h) would be stale before it finished. Per sport we take:

    top POOL_TOTAL cards by year total  UNION  top POOL_PEAK by best single day

which is where max-earnings lineups actually come from (k <= 20 per sport).

Writes:  $BUDGET_WORK/budget_pool.json         (all sports)
         $BUDGET_WORK/budget_pool_<sport>.json (one per sport)

usage: build_budget_pool.py [sport ...]
"""
import json
import os
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
WORK = Path(os.environ.get("BUDGET_WORK", "/tmp"))
POOL_TOTAL, POOL_PEAK = 80, 40

src = REPO / "lib" / "otd-optimal-data.ts"
s = src.read_text()
lit = s[s.index("= '") + 3: s.rindex("';")].replace("\\'", "'").replace('\\"', '"')
raw = json.loads(lit)

cands = {}
for sport, v in raw.items():
    cards = [(n, se, p, sum(x[1] for x in pr), max((x[1] for x in pr), default=0))
             for n, se, p, pr in v['cards']]
    out, seen = [], set()
    for n, se, p, yt, pk in (sorted(cards, key=lambda c: -c[3])[:POOL_TOTAL]
                             + sorted(cards, key=lambda c: -c[4])[:POOL_PEAK]):
        if (se, p) in seen:
            continue
        seen.add((se, p))
        out.append({"name": n, "season": se, "pid": p, "yt": yt, "peak": pk})
    cands[sport] = out
    print(f"{sport:6} all={len(v['cards']):5} pool={len(out):4} "
          f"yt_range=[{min(c['yt'] for c in out)},{max(c['yt'] for c in out)}]")

WORK.mkdir(parents=True, exist_ok=True)
(WORK / "budget_pool.json").write_text(json.dumps(cands, indent=0))
for sport, rows in cands.items():
    (WORK / f"budget_pool_{sport}.json").write_text(json.dumps({sport: rows}, indent=0))
print(f"wrote {WORK}/budget_pool.json + one per sport; cards:",
      sum(len(v) for v in cands.values()))
