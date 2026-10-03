#!/usr/bin/env python3
"""Budget sweep: how many live marketplace listings each pool card has, and at
what rax-per-rating. (rax per rating = price / the card's own rating.)

Call-saving: ask ONCE with no rarity filter — that returns the player's exact
listingCount plus the first page of 10.
  - count == 0     -> 1 call, done
  - count <= 10    -> that page IS the whole inventory: 1 call, exact
  - count >  10    -> walk rarities (starting with the ones the first page
                      showed), paging by beforeEndsAt for any rarity deeper than
                      one page. The first page is DISCARDED so nothing is
                      counted twice.

Net ~3.3 calls/card instead of 7. Three paced workers on top of that.

usage: sweep_budget.py SPORT [CONCURRENCY]
env:   BUDGET_WORK  MAX_REQUESTS  MAX_SECONDS  OUT  PACE_MIN  PACE_MAX
       REAL_TRACKER (dir holding real_api.py + config.json)
"""
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

SPORT = sys.argv[1]
CONC = int(sys.argv[2]) if len(sys.argv) > 2 else 3
POOL = WORK / f"budget_pool_{SPORT}.json"
OUT = Path(os.environ.get("OUT", str(WORK / f"budget_cache_{SPORT}.jsonl")))
MAX_REQUESTS = int(os.environ.get("MAX_REQUESTS", "6000"))
MAX_SECONDS = int(os.environ.get("MAX_SECONDS", "3600"))
PACE_MIN = float(os.environ.get("PACE_MIN", "0.6"))
PACE_MAX = float(os.environ.get("PACE_MAX", "1.4"))
MAX_PAGES = 8          # per rarity; a rarity holding >80 listings stops there
STORE = 20             # cheapest rpr values kept per card

T0 = time.time()
lock = threading.Lock()
stats = {"calls": 0, "stop": None}
pool = json.load(open(POOL))[SPORT]
done = set()
if OUT.exists():
    for line in OUT.read_text().splitlines():
        if line.strip():
            try:
                r = json.loads(line)
                done.add((r['season'], r['pid']))
            except Exception:
                pass


def price(l):
    for k in ("buyNowPrice", "currentBidAmount", "minBidPrice"):
        if l.get(k) is not None:
            return float(l[k])
    return None


def rpr(l):
    p = price(l)
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
    time.sleep(random.uniform(PACE_MIN, PACE_MAX))
    st, d = real_api.get(cfg, path, params)
    if st == 500:
        with lock:
            stats["stop"] = "server_500"
        raise RuntimeError("STOP500")
    if st != 200:
        return None
    return d


def listings(params):
    d = get("/cardmarketplacelistings", params)
    return (d or {}).get("listings") or [], (d or {}).get("listingCount") or 0


def rarity_walk(base, rarity):
    """Every listing this player has in one rarity (paged), plus its count."""
    out, cnt, cursor = [], 0, None
    for _ in range(MAX_PAGES):
        p = dict(base, rarity=rarity)
        if cursor:
            p["beforeEndsAt"] = cursor
        ls, cnt = listings(p)
        if not ls:
            break
        out.extend(ls)
        if len(ls) < 10 or len(out) >= cnt:
            break
        cursor = max(x["endsAt"] for x in ls if x.get("endsAt"))
    return out, cnt


def card_listings(card):
    base = {"sport": SPORT, "season": card['season'], "listingType": "card",
            "offset": 0, "filterEntityType": "player", "filterEntityId": card['pid']}
    rows, count = listings(base)
    if count <= len(rows):          # empty, or the whole inventory is one page
        return rows, count, True

    # Deeper than a page: discard the sample and walk rarities instead, so the
    # sample rows are never counted twice.
    seen_rar = sorted({l.get('rarity') for l in rows if l.get('rarity')})
    order = seen_rar + [r for r in range(1, 8) if r not in seen_rar]
    out, tally = [], 0
    for rarity in order:
        got, cnt = rarity_walk(base, rarity)
        out.extend(got)
        tally += cnt
        if tally >= count:
            break
    return out, count, tally >= count


def work(card):
    try:
        rows, count, complete = card_listings(card)
    except RuntimeError:
        return None
    vals = sorted(round(v, 2) for v in (rpr(l) for l in rows) if v is not None)
    rec = {"sport": SPORT, "name": card['name'], "season": card['season'],
           "pid": card['pid'], "listings": count, "seen": len(rows),
           "complete": complete, "rpr": vals[:STORE]}
    with lock:
        with open(OUT, 'a') as f:
            f.write(json.dumps(rec) + "\n")
    return rec


todo = [c for c in pool if (c['season'], c['pid']) not in done]
print(f"[{SPORT}] pool={len(pool)} todo={len(todo)} (cached {len(done)}) conc={CONC}",
      flush=True)
n = 0
try:
    with ThreadPoolExecutor(max_workers=CONC) as ex:
        for rec in ex.map(work, todo):
            n += 1
            if rec and (n % 10 == 0 or n == len(todo)):
                el = time.time() - T0
                eta = el / n * (len(todo) - n)
                print(f"  {n}/{len(todo)} calls={stats['calls']} {el/60:.1f}min "
                      f"eta {eta/60:.1f}min last={rec['name']} "
                      f"listings={rec['listings']} seen={rec['seen']}", flush=True)
            with lock:
                if stats["stop"]:
                    break
except Exception as e:
    print("ABORT:", e, flush=True)

print(f"[{SPORT}] STOP({stats['stop'] or 'done'}): swept {n}, calls {stats['calls']}, "
      f"{(time.time()-T0)/60:.1f} min -> {OUT}", flush=True)
