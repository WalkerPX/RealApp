"""End-to-end check of the Optimal Budget quick searches: replay exactly the
query each preset button fires at /api/deals and confirm none 400s on its season
and none comes back with unresolved players.

usage: verify_budget_scan.py [base_url]
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3113"
REPO = Path(__file__).resolve().parents[2]
src = (REPO / "lib" / "budget-searches.ts").read_text()

presets = []
for m in re.finditer(r'id: "([^"]+)",\s*label: "([^"]+)",\s*cards: (\d+),\s*best: (\d+),\s*'
                     r'slices: (\[.*?\]),\s*\}', src, re.S):
    presets.append({"id": m.group(1), "label": m.group(2), "cards": int(m.group(3)),
                    "slices": json.loads(m.group(5))})

seen = set()
total_deals = 0
bad = 0
for p in presets:
    print(f"\n=== {p['label']} ({p['cards']} players, {len(p['slices'])} slices)")
    for sl in p["slices"]:
        key = (sl["sport"], sl["season"], tuple(sl["players"]))
        if key in seen:
            print(f"  (dup) {sl['sport']} {sl['season']}")
            continue
        seen.add(key)
        params = {
            "sport": sl["sport"], "season": str(sl["season"]),
            "types": "card", "rarities": "7,6,5,4,3,2,1",
            "players": ", ".join(sl["players"]),
            "minDisc": "20", "auctions": "1", "mode": "rating", "factor": "11",
        }
        url = f"{BASE}/api/deals?{urllib.parse.urlencode(params)}"
        time.sleep(0.4)
        try:
            with urllib.request.urlopen(url, timeout=180) as r:
                body = json.loads(r.read())
                st = r.status
        except urllib.error.HTTPError as e:
            body = json.loads(e.read())
            st = e.code
        ok = st == 200 and not body.get("error")
        deals = len(body.get("deals", []))
        total_deals += deals
        unres = body.get("unresolved") or []
        if not ok or unres:
            bad += 1
        print(f"  {'ok ' if ok else 'ERR'} {sl['sport']:6} s{sl['season']} "
              f"[{len(sl['players'])}p] http={st} scanned={body.get('scanned')} "
              f"deals={deals} unresolved={unres}")

print(f"\n{len(seen)} unique slices, {total_deals} deals returned, {bad} problems")
