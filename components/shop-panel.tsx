"use client";

import { useCallback, useEffect, useState } from "react";
import {
  DEAL_SEASONS,
  DEAL_SPORTS,
  LISTING_TYPE_META,
  RARITY_LABELS,
  WALKER_OTD_SLICES,
  seasonLabel,
  type Deal,
  type DealListingType,
  type DealSport,
} from "@/lib/deals";

// Keep in sync with app/globals.css --rarity-*.
const RARITY_HEX: Record<string, string> = {
  iconic: "#f472b6",
  mystic: "#f2c94c",
  legendary: "#7856ff",
  epic: "#d6409f",
  rare: "#e66200",
  uncommon: "#00a163",
  common: "#0483d7",
};

function rarityColor(label?: string | null): string {
  if (!label) return "#38bdf8";
  const k = label.toLowerCase();
  for (const key of ["iconic", "mystic", "legendary", "epic", "rare", "uncommon", "common"]) {
    if (k.includes(key)) return RARITY_HEX[key];
  }
  return "#38bdf8";
}

interface DealsResponse {
  deals: Deal[];
  scanned: number;
  lookedUp: number;
  timedOut: boolean;
  elapsedMs: number;
  seasonLabel: string;
  /** Set by the wlkr-OTD sweep: how many of the 11 slices errored out. */
  failedSlices?: number;
  error?: string;
}

const SPORT_TAG: Record<DealSport, string> = {
  mlb: "MLB",
  wnba: "WNBA",
  nba: "NBA",
  ncaaf: "CFB",
  ncaam: "CBB",
  nfl: "NFL",
  nhl: "NHL",
  soccer: "FC",
};

function endsIn(iso: string | null): string {
  if (!iso) return "?";
  const end = new Date(iso).getTime();
  if (Number.isNaN(end)) return "?";
  const mins = Math.round((end - Date.now()) / 60000);
  if (mins < 1) return "ending now";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m`;
}

function DealRow({ d, tag }: { d: Deal; tag?: string }) {
  const col = rarityColor(d.boost || d.rarityLabel);
  const savings =
    d.median != null && d.price < d.median ? Math.round(d.median - d.price) : null;
  return (
    <li className="deal-item">
      <div className="deal-top">
        <span className="deal-player">{d.player}</span>
        <span className="deal-badges">
          {tag && <span className="mini-chip tag">{tag}</span>}
          <span className="mini-chip type">{LISTING_TYPE_META[d.type].short}</span>
          <span
            className="mini-chip"
            style={{ color: col, borderColor: col, background: `color-mix(in srgb, ${col} 12%, transparent)` }}
          >
            {d.boost || d.rarityLabel}
          </span>
          {d.canBid && <span className="mini-chip bid">auction</span>}
        </span>
      </div>
      <div className="deal-sub">
        {d.isDiscountDeal && d.discountPct != null && (
          <span className="deal-disc">
            {d.discountPct}% below FMV{savings != null ? ` (−${savings.toLocaleString()})` : ""}
          </span>
        )}
        {d.isRoiDeal && d.remaining != null && (
          <span className="deal-roi">
            pays itself: +{d.remaining.toLocaleString()} rax to collect
          </span>
        )}
        <span className="deal-price">
          {d.price.toLocaleString()} rax{d.median != null && ` · FMV ${d.median.toLocaleString()}`}
        </span>
      </div>
      <div className="deal-foot">
        <span className="deal-ends">{endsIn(d.endsAt)} left</span>
        <a href={d.url} target="_blank" rel="noreferrer">
          View listing →
        </a>
      </div>
    </li>
  );
}

export default function ShopPanel() {
  const [sport, setSport] = useState<DealSport>("mlb");
  const [season, setSeason] = useState<number>(DEAL_SEASONS.mlb[0]);
  const [types, setTypes] = useState<DealListingType[]>(["userpassfull"]);
  const [rarities, setRarities] = useState<number[]>([7, 6, 5]);
  const [players, setPlayers] = useState("");
  const [minDisc, setMinDisc] = useState(20);
  const [auctions, setAuctions] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DealsResponse | null>(null);
  const [otdRunning, setOtdRunning] = useState(false);
  const [otdMsg, setOtdMsg] = useState("");
  const [otdTags, setOtdTags] = useState<Map<number, string>>(new Map());

  const switchSport = (s: DealSport) => {
    setSport(s);
    setSeason(DEAL_SEASONS[s][0]);
    setResult(null);
  };

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    const params = new URLSearchParams({
      sport,
      season: String(season),
      types: types.join(","),
      rarities: rarities.join(","),
      minDisc: String(minDisc),
      auctions: auctions ? "1" : "0",
      players: players.trim(),
    });
    try {
      const res = await fetch(`/api/deals?${params}`);
      const body = (await res.json()) as DealsResponse;
      if (!res.ok) {
        setError(body?.error || `Scan failed (${res.status})`);
      } else {
        setResult(body);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [sport, season, types, rarities, minDisc, auctions, players]);

  /** wlkr OTD sweep: rare→iconic bulk passes for the fixed tracked-player
   * list, across all its sport/season slices. Honors the min-discount field
   * and the auctions toggle; the slice list lives in lib/deals.ts. */
  const runOtd = useCallback(async () => {
    setOtdRunning(true);
    setError(null);
    setResult(null);
    const merged: Deal[] = [];
    const seen = new Set<number>();
    const tags = new Map<number, string>();
    let scanned = 0;
    let lookedUp = 0;
    let elapsed = 0;
    let timedOutAny = false;
    let failed = 0;
    const total = WALKER_OTD_SLICES.length;
    try {
      for (let i = 0; i < total; i++) {
        const s = WALKER_OTD_SLICES[i];
        setOtdMsg(`scanning ${SPORT_TAG[s.sport]} ${seasonLabel(s.sport, s.season)}… (${i + 1}/${total})`);
        const params = new URLSearchParams({
          sport: s.sport,
          season: String(s.season),
          types: "userpassfull",
          rarities: "7,6,5,4,3",
          players: s.players.join(", "),
          minDisc: String(minDisc),
          auctions: auctions ? "1" : "0",
        });
        try {
          const res = await fetch(`/api/deals?${params}`);
          const body = (await res.json()) as DealsResponse;
          if (!res.ok) {
            failed++;
            continue;
          }
          const tag = `${SPORT_TAG[s.sport]} ${seasonLabel(s.sport, s.season)}`;
          for (const d of body.deals) {
            if (seen.has(d.listingId)) continue;
            seen.add(d.listingId);
            tags.set(d.listingId, tag);
            merged.push(d);
          }
          scanned += body.scanned;
          lookedUp += body.lookedUp;
          elapsed += body.elapsedMs;
          timedOutAny = timedOutAny || body.timedOut;
        } catch {
          failed++;
        }
      }
    } finally {
      setOtdRunning(false);
      setOtdMsg("");
    }
    merged.sort(
      (a, b) =>
        (b.discountPct ?? -1) - (a.discountPct ?? -1) || b.upside - a.upside
    );
    if (!merged.length && failed > 0) {
      setError(`wlkr OTD scan failed on ${failed}/${total} slices — no results`);
    }
    const res: DealsResponse = {
      deals: merged,
      scanned,
      lookedUp,
      timedOut: timedOutAny,
      elapsedMs: elapsed,
      seasonLabel: `wlkr tracked set (${total - failed}/${total} scans)`,
      failedSlices: failed,
    };
    // Rendered after the merge so DealRow can show its sport/season tag.
    setOtdTags(tags);
    setResult(res);
  }, [minDisc, auctions]);

  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => setLoading(false), 95000);
    return () => clearTimeout(t);
  }, [loading]);

  return (
    <div className="shop">
      <div className="panel">
        <div className="filter-row">
          <label>
            <span className="flabel">Sport</span>
            <select value={sport} onChange={(e) => switchSport(e.target.value as DealSport)}>
              {DEAL_SPORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="flabel">Season</span>
            <select value={season} onChange={(e) => setSeason(Number(e.target.value))}>
              {DEAL_SEASONS[sport].map((s) => (
                <option key={s} value={s}>
                  {seasonLabel(sport, s)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="flabel">Min discount</span>
            <span className="numwrap">
              <input
                type="number"
                min={0}
                max={90}
                value={minDisc}
                onChange={(e) => setMinDisc(Number(e.target.value) || 0)}
              />
              <span className="pct">%</span>
            </span>
          </label>
          <label className="check-inline">
            <input
              type="checkbox"
              checked={auctions}
              onChange={(e) => setAuctions(e.target.checked)}
            />
            auctions only
          </label>
        </div>

        <div className="filter-row">
          <span className="flabel">Card types</span>
          {(Object.keys(LISTING_TYPE_META) as DealListingType[]).map((t) => (
            <label key={t} className={`opt-box ${types.includes(t) ? "on" : ""}`}>
              <input
                type="checkbox"
                checked={types.includes(t)}
                onChange={(e) =>
                  setTypes((cur) => (e.target.checked ? [...new Set([...cur, t])] : cur.filter((x) => x !== t)))
                }
              />
              {LISTING_TYPE_META[t].label}
            </label>
          ))}
          <span className="flabel rarity-label">Rarity</span>
          {[7, 6, 5, 4, 3, 2, 1].map((r) => (
            <label key={r} className={`opt-box ${rarities.includes(r) ? "on" : ""}`}>
              <input
                type="checkbox"
                checked={rarities.includes(r)}
                onChange={(e) =>
                  setRarities((cur) =>
                    e.target.checked ? [...cur, r].sort((a, b) => b - a) : cur.filter((x) => x !== r)
                  )
                }
              />
              {RARITY_LABELS[r]}
            </label>
          ))}
        </div>

        <div className="filter-row last">
          <label className="player-input">
            <span className="flabel">Specific players</span>
            <input
              value={players}
              onChange={(e) => setPlayers(e.target.value)}
              placeholder="Optional — e.g. Gunnar Henderson, Blaze Alexander (comma separated)"
              spellCheck={false}
            />
          </label>
          <button className="btn" onClick={run} disabled={loading || otdRunning || !types.length || !rarities.length}>
            {loading ? "scanning…" : "Scan market"}
          </button>
          <button className="btn otd" onClick={runOtd} disabled={otdRunning || loading} title="Rare→Iconic bulk passes for the fixed wlkr tracked-player list (min discount applies)">
            {otdRunning ? "scanning…" : "wlkr OTD scan"}
          </button>
          {otdRunning && <span className="muted-note">{otdMsg}</span>}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {result && (
        <div className="deal-out">
          <p className="summary">
            <strong>{result.deals.length}</strong> deal
            {result.deals.length === 1 ? "" : "s"} found · {result.seasonLabel} ·{" "}
            {result.scanned.toLocaleString()} listings scanned in {(result.elapsedMs / 1000).toFixed(1)}s
            {result.timedOut && (
              <span className="muted-note"> — hit the time cap; narrow the filters for a deeper scan</span>
            )}
            {result.failedSlices ? (
              <span className="muted-note"> — {result.failedSlices} slice(s) errored</span>
            ) : null}
          </p>
          {result.deals.length === 0 ? (
            <p className="empty">
              No deals match — try a lower min discount, add rarities/card types, or drop the player
              filter.
            </p>
          ) : (
            <ul className="deal-list">
              {result.deals.map((d) => (
                <DealRow key={d.listingId} d={d} tag={otdTags.get(d.listingId)} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
