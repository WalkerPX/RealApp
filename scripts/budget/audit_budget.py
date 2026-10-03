#!/usr/bin/env python3
"""Audit the budget sweeps: coverage per sport, and which cards are genuinely
uncertain (couldn't enumerate the whole inventory AND found fewer than 2 cheap
listings — so it might be eligible but we can't tell; these stay OUT).

usage: audit_budget.py [sport ...]
env:   BUDGET_WORK
"""
import glob
import json
import os
import sys
from pathlib import Path

WORK = Path(os.environ.get("BUDGET_WORK", "/tmp"))

files = sorted(glob.glob(str(WORK / "budget_cache_*.jsonl")))
files = [f for f in files if not f.endswith(".badcount") and not f.endswith("_deep.jsonl")]
if sys.argv[1:]:
    files = [f for f in files
             if Path(f).name[len("budget_cache_"):-len(".jsonl")] in sys.argv[1:]]

# the deep pass supersedes first-pass rows
deep = {}
dp = WORK / "budget_cache_deep.jsonl"
if dp.exists():
    for line in dp.read_text().splitlines():
        if line.strip():
            r = json.loads(line)
            deep[(r['sport'], r['season'], r['pid'])] = r

total_uncertain = 0
for path in files:
    sport = Path(path).name[len("budget_cache_"):-len(".jsonl")]
    by = {}
    for line in open(path):
        if line.strip():
            r = json.loads(line)
            by[(r['sport'], r['season'], r['pid'])] = r
    by.update({k: v for k, v in deep.items() if k[0] == sport})
    recs = list(by.values())
    inc = [r for r in recs if not r['complete']]
    uncertain = [r for r in inc if sum(1 for v in r['rpr'] if v <= 20) < 2]
    total_uncertain += len(uncertain)
    print(f"{sport:6} cards={len(recs):4} exact={len(recs)-len(inc):4} "
          f"partial={len(inc):3} uncertain={len(uncertain):3} "
          f"| elig@10={sum(1 for r in recs if sum(1 for v in r['rpr'] if v <= 10) >= 2):3} "
          f"elig@20={sum(1 for r in recs if sum(1 for v in r['rpr'] if v <= 20) >= 2):3}")
    for r in uncertain[:4]:
        print(f"        ? {r['name']:22} s{r['season']} listed={r['listings']:4} "
              f"seen={r['seen']:3} cheapest={r['rpr'][:3]}")
print(f"\nuncertain cards overall: {total_uncertain}")
