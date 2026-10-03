#!/usr/bin/env python3
"""Check every player in lib/budget-searches.ts actually resolves to a player
entity in Real's search for that sport/season — an unresolvable name would leave
the quick search silently short.

usage: verify_budget_searches.py
env:   REAL_TRACKER
"""
import json
import os
import re
import sys
import time
from pathlib import Path

TRACKER = os.environ.get("REAL_TRACKER", "/mnt/SharedPool/ace/real-deal-tracker")
sys.path.insert(0, TRACKER)
import real_api  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
cfg = json.load(open(Path(TRACKER) / "config.json"))
src = (REPO / "lib" / "budget-searches.ts").read_text()

presets = []
for m in re.finditer(r'id: "([^"]+)",\s*label: "([^"]+)",\s*cards: (\d+),\s*best: (\d+),\s*'
                     r'slices: (\[.*?\]),\s*\}', src, re.S):
    presets.append({"id": m.group(1), "label": m.group(2), "cards": int(m.group(3)),
                    "slices": json.loads(m.group(5))})

print(f"{len(presets)} presets parsed from the shipped file")


def name_key(s):
    return re.sub(r'[^a-z0-9]', '', s.lower())


bad = 0
checked = 0
for p in presets:
    for sl in p["slices"]:
        for name in sl["players"]:
            time.sleep(0.7)
            st, d = real_api.get(cfg, "/search", {"query": name, "sport": sl["sport"]})
            checked += 1
            ents = [e for e in (d or {}).get("entities", []) if e.get("type") == "player"]
            full = [f"{e['entity'].get('firstName','')} {e['entity'].get('lastName','')}".strip()
                    for e in ents]
            exact = any(name_key(f) == name_key(name) for f in full)
            surname = any(name_key(f.split()[-1]) == name_key(name.split()[-1])
                          for f in full if f)
            mark = "OK " if exact else ("~  " if surname else "MISS")
            if not exact:
                bad += 1
            print(f"  {mark} {p['label']:11} {sl['sport']:6} s{sl['season']} {name:24} "
                  f"-> {full[:2]}")

print(f"\n{checked} names checked, {bad} without an exact match")
