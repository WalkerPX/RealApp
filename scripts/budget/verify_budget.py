#!/usr/bin/env python3
"""Independent check of the shipped budget data.

Reads lib/otd-optimal-data.ts and lib/otd-budget-data.ts — exactly what ships —
re-solves every sport in pure Python, and prints totals to compare against the
API's own numbers:

    /api/optimal-otd?mode=persport&k=K&budget=BUD   -> totalBase
    /api/optimal-otd?budget=BUD&k=K                 -> totalBase

Separate implementation on purpose: if the TypeScript solver and this disagree,
one of them is wrong.

usage: verify_budget.py [K] [BUDGET]
"""
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
K = int(sys.argv[1]) if len(sys.argv) > 1 else 5
BUD = int(sys.argv[2]) if len(sys.argv) > 2 else 10


def load(ts_path: Path, name: str) -> str:
    s = ts_path.read_text()
    i = s.index(name) + len(name)
    lit = s[i:].strip().split("\n")[0].strip().rstrip(";").strip()
    return lit


raw = json.loads(load(REPO / "lib" / "otd-optimal-data.ts", "OTD_DATA =")
                 .strip("'").replace("\\'", "'").replace('\\"', '"'))
bdata = json.loads(load(REPO / "lib" / "otd-budget-data.ts", "OTD_BUDGET_DATA =")
                   .strip("'").replace("\\'", "'").replace('\\"', '"'))

DAYS = 366
grand = 0
for sport, v in raw.items():
    def elig(season, pid):
        row = bdata.get(sport, {}).get(str(season), {}).get(str(pid))
        if not row:
            return False
        return sum(1 for x in row[1] if float(x) <= BUD) >= 2

    cards = []
    for name, season, pid, pairs in v['cards']:
        if not elig(season, pid):
            continue
        vec = [0] * DAYS
        for i, val in pairs:
            vec[i] = val
        cards.append((name, season, pid, vec))

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

    grand += cur
    print(f"{sport:6} eligible={len(cards):4} k={K} best={cur:5}")
    for c in sorted(sel, key=lambda c: -c[1]):
        print(f"        {c[0]:24} s{c[1]}")

print(f"\nper-sport k={K} @<={BUD} grand total = {grand}")
print(f"compare: /api/optimal-otd?mode=persport&k={K}&budget={BUD}")
