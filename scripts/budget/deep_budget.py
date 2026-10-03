#!/usr/bin/env python3
"""Second pass for cards the main sweep couldn't enumerate fully.

A card is "uncertain" when we failed to page its whole inventory AND we found
fewer than two listings at or under the loosest threshold the UI offers (20 rpr)
— it might be budget-eligible but we can't tell. Those get re-walked rarity by
rarity with a much deeper page cap.

Cards that stay uncertain are left OUT of the budget pool: a conservative miss
beats recommending a card that isn't actually buyable.

usage: deep_budget.py
env:   BUDGET_WORK  MAX_REQUESTS  MAX_SECONDS  OUT  LOOSE REAL_TRACKER
"""
import glob
import json
import os
import random
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

TRACKER = os.environ.get("REAL_TRACKER", "/mnt/SharedPool/ace/real-deal-tracker")
sys.path.insert(0, TRACKER)
import real_api  # noqa: E402

WORK = Path(os.environ.get("BUDGET_WORK", "/tmp"))
cfg = json.load(open(Path(TRACKER) / "config.json"))
OUT = Path(os.environ.get("OUT", str(WORK / "budget_cache_deep.jsonl")))
MAX_REQUESTS = int(os.environ.get("MAX_REQUESTS", "3000"))
MAX_SECONDS = int(os.environ.get("MAX_SECONDS", "1800"))
MAX_PAGES = 30           # 300 listings per rarity — far past anything real
LOOSE = int(os.environ.get("LOOSE", "20"))
T0 = time.time()
lock = threading.Lock()
stats = {"calls": 0, "stop": None}

uncertain = []
for path in sorted(glob.glob(str(WORK / "budget_cache_*.jsonl"))):
    if path.endswith(".badcount") or path.endswith("_deep.jsonl"):
        continue
    by = {}
    for line in open(path):
        if line.strip():
            r = json.loads(line)
            by[(r['season'], r['pid'])] = r
    for r in by.values():
        if not r['complete'] and sum(1 for v in r['rpr'] if v <= LOOSE) < 2:
            uncertain.append(r)

print(f"deep pass over {len(uncertain)} uncertain cards", flush=True)


def rpr(l):
    p = None
    for k in ("buyNowPrice", "currentBidAmount", "minBidPrice"):
        if l.get(k) is not None:
            p = float(l[k])
            break
    v = l.get("value")
    if v is None:
        v = (l.get("card") or {}).get("boostValue")
    try:
        v = float(v)
    except Exception:
        return None
    return p / v if p and v > 0 else None


def get(path, params):
    with lock:
        if stats["stop"]:
            return None
        if stats["calls"] >= MAX_REQUESTS:
            stats["stop"] = "max_requests"
            return None
        if time.time() - T0 > MAX_SECONDS:
            stats["stop"] = "max_seconds"
            return None
        stats["calls"] += 1
    time.sleep(random.uniform(0.6, 1.4))
    st, d = real_api.get(cfg, path, params)
    if st == 500:
        with lock:
            stats["stop"] = "server_500"
        raise RuntimeError("STOP500")
    return d if st == 200 else None


def walk(card):
    base = {"sport": card['sport'], "season": card['season'], "listingType": "card",
            "offset": 0, "filterEntityType": "player", "filterEntityId": card['pid']}
    d = get("/cardmarketplacelistings", base)
    if d is None:
        return None
    count = d.get("listingCount") or 0
    rows, tally = [], 0
    for rarity in range(1, 8):
        cursor, got = None, 0
        for _ in range(MAX_PAGES):
            p = dict(base, rarity=rarity)
            if cursor:
                p["beforeEndsAt"] = cursor
            dd = get("/cardmarketplacelistings", p)
            if dd is None:
                break
            ls = dd.get("listings") or []
            cnt = dd.get("listingCount") or 0
            if not ls:
                tally += cnt
                break
            rows.extend(ls)
            got += len(ls)
            if len(ls) < 10 or got >= cnt:
                tally += cnt
                break
            cursor = max(x["endsAt"] for x in ls if x.get("endsAt"))
    vals = sorted(round(v, 2) for v in (rpr(l) for l in rows) if v is not None)
    rec = {"sport": card['sport'], "name": card['name'], "season": card['season'],
           "pid": card['pid'], "listings": count, "seen": len(rows),
           "complete": tally >= count, "rpr": vals[:20], "deep": True}
    with lock:
        with open(OUT, 'a') as f:
            f.write(json.dumps(rec) + "\n")
    return rec


with ThreadPoolExecutor(max_workers=3) as ex:
    for i, rec in enumerate(ex.map(walk, uncertain), 1):
        if rec:
            print(f"  {i}/{len(uncertain)} {rec['name']:22} s{rec['season']} "
                  f"listed={rec['listings']:4} seen={rec['seen']:4} "
                  f"cheap@10={sum(1 for v in rec['rpr'] if v <= 10):3} "
                  f"cheap@20={sum(1 for v in rec['rpr'] if v <= 20):3} "
                  f"complete={rec['complete']} calls={stats['calls']}", flush=True)

print(f"DEEP STOP({stats['stop'] or 'done'}): {stats['calls']} calls, "
      f"{(time.time()-T0)/60:.1f} min -> {OUT}", flush=True)
