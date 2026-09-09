"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { logMonitor } from "@/components/monitor-panel";
import {
  DEAL_SEASONS,
  DEAL_SPORTS,
  LISTING_TYPE_META,
  RARITY_LABELS,
  WALKER_ACTIVE_SLICES,
  WALKER_OTD_SLICES,
  seasonErrorMessage,
  seasonLabel,
  walkerOtdMenu,
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
  /** Set by the wlkr-OTD sweep: how many slices errored out. */
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

/** One scan unit: a sport/season slice filtered to a set of player names. */
interface RunSlice {
  sport: DealSport;
  season: number;
  players: string[];
}

/** Tracked-player menu (wlkr OTD list, grouped sport → season) — static. */
const OTD_MENU = walkerOtdMenu();

/** LocalStorage keys. */
const LS_CHECKS = "wlkr.checkedPlayers";

/** Only keys that still exist in the OTD slice list are kept. */
const VALID_KEYS = new Set<string>();
for (const g of OTD_MENU) for (const s of g.seasons) for (const p of s.players) VALID_KEYS.add(p.key);

function parseKey(key: string): { sport: DealSport; season: number; name: string } {
  const i1 = key.indexOf("|");
  const i2 = key.indexOf("|", i1 + 1);
  return {
    sport: key.slice(0, i1) as DealSport,
    season: Number(key.slice(i1 + 1, i2)),
    name: key.slice(i2 + 1),
  };
}

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

interface ShopPanelProps {
  /** Secret tools (wlkr OTD scan + tracked-player menu) shown only when the
   * hidden "Made" toggle in the footer is on. */
  showTools?: boolean;
}

export default function ShopPanel({ showTools = false }: ShopPanelProps) {
  const [sport, setSport] = useState<DealSport>("mlb");
  const [season, setSeason] = useState<number>(DEAL_SEASONS.mlb[0]);
  const [types, setTypes] = useState<DealListingType[]>(["userpassfull"]);
  const [rarities, setRarities] = useState<number[]>([7, 6, 5]);
  const [players, setPlayers] = useState("");
  const [minDisc, setMinDisc] = useState(20);
  const [auctions, setAuctions] = useState(true);
  const [checked, setChecked] = useState<string[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [runMode, setRunMode] = useState<"market" | "otd" | "active" | null>(null);
  const [sweepMsg, setSweepMsg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DealsResponse | null>(null);
  const [tags, setTags] = useState<Map<number, string>>(new Map());

  // Restore checked players after mount (avoids SSR hydration mismatch).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LS_CHECKS);
      if (raw) {
        const arr = JSON.parse(raw) as unknown;
        if (Array.isArray(arr)) {
          setChecked(
            arr.filter((k): k is string => typeof k === "string" && VALID_KEYS.has(k))
          );
        }
      }
    } catch {
      /* storage unavailable — start empty */
    }
  }, []);

  useEffect(() => {
    try {
      if (checked.length) window.localStorage.setItem(LS_CHECKS, JSON.stringify(checked));
      else window.localStorage.removeItem(LS_CHECKS);
    } catch {
      /* ignore */
    }
  }, [checked]);

  // Hiding the secret tools also closes the player menu.
  useEffect(() => {
    if (!showTools) setMenuOpen(false);
  }, [showTools]);

  const switchSport = (s: DealSport) => {
    setSport(s);
    setSeason(DEAL_SEASONS[s][0]);
    setResult(null);
  };

  const toggleChecked = useCallback((key: string) => {
    setChecked((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
  }, []);

  const clearChecked = useCallback(() => setChecked([]), []);

  /**
   * Scan plan for "Scan market":
   *  - nothing checked: the current sport/season slice (typed names apply), as before;
   *  - players checked in the tracked-player menu: each checked player is added to
   *    the player filter of their own sport/season slice, so one run spans every
   *    market the checked players belong to (e.g. Braden Smith CBB + Shohei MLB at
   *    once, regardless of the dropdowns). Typed names still apply to the current
   *    slice on top of that.
   */
  const plan = useMemo<RunSlice[]>(() => {
    const bySlice = new Map<string, RunSlice>();
    for (const key of checked) {
      const { sport: sp, season: se, name } = parseKey(key);
      const k = `${sp}|${se}`;
      const sl = bySlice.get(k);
      if (sl) sl.players.push(name);
      else bySlice.set(k, { sport: sp, season: se, players: [name] });
    }
    const typedTokens = players
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 25);
    if (typedTokens.length) {
      const k = `${sport}|${season}`;
      const sl = bySlice.get(k);
      if (sl) sl.players.push(...typedTokens.filter((t) => !sl.players.includes(t)));
      else bySlice.set(k, { sport, season, players: typedTokens });
    }
    if (!checked.length && !typedTokens.length) {
      return [{ sport, season, players: [] }];
    }
    return [...bySlice.values()];
  }, [checked, players, sport, season]);

  /** Sequential scan over one or more slices; merges and sorts the deals.
   * who = summary label when spanning multiple slices ("wlkr tracked set" /
   * "checked players"). Honors min-discount + auctions; types/rarities are
   * passed per call (the OTD sweep forces bulk + rare→iconic). */
  const runSlices = useCallback(
    async (slices: RunSlice[], listTypes: DealListingType[], rar: number[], who: string) => {
      if (!slices.length) return;
      setRunning(true);
      setError(null);
      setResult(null);
      setTags(new Map());
      const merged: Deal[] = [];
      const seen = new Set<number>();
      const sliceTags = new Map<number, string>();
      let scanned = 0;
      let lookedUp = 0;
      let elapsed = 0;
      let timedOutAny = false;
      let failed = 0;
      const total = slices.length;
      try {
        for (let i = 0; i < total; i++) {
          const s = slices[i];
          setSweepMsg(`scanning ${SPORT_TAG[s.sport]} ${seasonLabel(s.sport, s.season)}… (${i + 1}/${total})`);
          const params = new URLSearchParams({
            sport: s.sport,
            season: String(s.season),
            types: listTypes.join(","),
            rarities: rar.join(","),
            players: s.players.join(", "),
            minDisc: String(minDisc),
            auctions: auctions ? "1" : "0",
          });
          const label = `${SPORT_TAG[s.sport]} ${seasonLabel(s.sport, s.season)}`;
          try {
            const res = await fetch(`/api/deals?${params}`);
            const body = (await res.json()) as DealsResponse;
            if (!res.ok) {
              // Real said the season doesn't exist — hard stop so the bad
              // slice is visible instead of silently continuing.
              const seasonMsg = seasonErrorMessage(body.error ?? "");
              if (seasonMsg) {
                logMonitor({
                  tag: "deals",
                  label,
                  status: res.status,
                  sentToReal: false,
                  ok: false,
                  msg: seasonMsg,
                });
                setError(
                  `Stopped: ${SPORT_TAG[s.sport]} ${seasonLabel(
                    s.sport,
                    s.season
                  )} → ${seasonMsg}`
                );
                return;
              }
              logMonitor({
                tag: "deals",
                label,
                status: res.status,
                sentToReal: res.status !== 400,
                ok: false,
                msg: body?.error ?? `HTTP ${res.status}`,
              });
              failed++;
              continue;
            }
            logMonitor({
              tag: "deals",
              label,
              status: res.status,
              sentToReal: true,
              ok: true,
              msg: `scanned ${body.scanned}`,
            });
            const tag = `${SPORT_TAG[s.sport]} ${seasonLabel(s.sport, s.season)}`;
            for (const d of body.deals) {
              if (seen.has(d.listingId)) continue;
              seen.add(d.listingId);
              merged.push(d);
              if (total > 1) sliceTags.set(d.listingId, tag);
            }
            scanned += body.scanned;
            lookedUp += body.lookedUp;
            elapsed += body.elapsedMs;
            timedOutAny = timedOutAny || body.timedOut;
          } catch (e) {
            logMonitor({
              tag: "deals",
              label,
              status: null,
              sentToReal: false,
              ok: false,
              msg: e instanceof Error ? e.message : "Network error",
            });
            failed++;
          }
        }
      } finally {
        setRunning(false);
        setSweepMsg("");
      }
      merged.sort(
        (a, b) =>
          (b.discountPct ?? -1) - (a.discountPct ?? -1) || b.upside - a.upside
      );
      if (!merged.length && failed > 0) {
        setError(`${who} failed on ${failed}/${total} slices — no results`);
      }
      setTags(sliceTags);
      const label =
        total > 1
          ? `${who} (${total - failed}/${total} scans)`
          : seasonLabel(slices[0].sport, slices[0].season);
      setResult({
        deals: merged,
        scanned,
        lookedUp,
        timedOut: timedOutAny,
        elapsedMs: elapsed,
        seasonLabel: label,
        failedSlices: failed,
      });
    },
    [minDisc, auctions]
  );

  /** "Scan market": single slice normally; cross-sport once players are
   * checked in the tracked-player menu. */
  const scan = useCallback(async () => {
    if (running) return;
    setRunMode("market");
    try {
      await runSlices(plan, types, rarities, "checked players");
    } finally {
      setRunMode(null);
    }
  }, [running, plan, types, rarities, runSlices]);

  /** wlkr OTD sweep: rare→iconic bulk passes for the fixed tracked-player
   * list, across all its sport/season slices. Honors the min-discount field
   * and the auctions toggle; the slice list lives in lib/deals.ts. */
  const runOtd = useCallback(async () => {
    if (running) return;
    setRunMode("otd");
    try {
      const slices: RunSlice[] = WALKER_OTD_SLICES.map((s) => ({
        sport: s.sport,
        season: s.season,
        players: s.players,
      }));
      await runSlices(slices, ["userpassfull"], [7, 6, 5, 4, 3], "wlkr tracked set");
    } finally {
      setRunMode(null);
    }
  }, [running, runSlices]);

  /** wlkr Active sweep: identical to the OTD scan but over the current-season
   * (2026-27) player list instead of the bulk-earnings OTD list. */
  const runActive = useCallback(async () => {
    if (running) return;
    setRunMode("active");
    try {
      const slices: RunSlice[] = WALKER_ACTIVE_SLICES.map((s) => ({
        sport: s.sport,
        season: s.season,
        players: s.players,
      }));
      await runSlices(slices, ["userpassfull"], [7, 6, 5, 4, 3], "wlkr active set");
    } finally {
      setRunMode(null);
    }
  }, [running, runSlices]);

  const busy = running || runMode !== null;

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
          <div className="player-col">
            <label className="player-input">
              <span className="flabel">Specific players</span>
              <input
                value={players}
                onChange={(e) => setPlayers(e.target.value)}
                placeholder="Optional — e.g. Gunnar Henderson, Blaze Alexander (comma separated)"
                spellCheck={false}
              />
            </label>

            {checked.length > 0 && (
              <div className="chip-row">
                {checked.map((key) => {
                  const { sport: sp, season: se, name } = parseKey(key);
                  return (
                    <span key={key} className="pchip">
                      <span className="pchip-name">{name}</span>
                      <span className="pchip-ctx">
                        {SPORT_TAG[sp]} {seasonLabel(sp, se)}
                      </span>
                      <button
                        className="pchip-x"
                        onClick={() => toggleChecked(key)}
                        aria-label={`remove ${name}`}
                        title="remove"
                      >
                        ×
                      </button>
                    </span>
                  );
                })}
                <button className="pchip-clear" onClick={clearChecked}>
                  clear
                </button>
              </div>
            )}

            {showTools && (
              <button
                className="btn ghost sm"
                onClick={() => setMenuOpen((v) => !v)}
                disabled={busy}
                title="Pick which tracked players feed the cross-sport Scan market"
              >
                tracked players{checked.length ? ` (${checked.length})` : ""}
              </button>
            )}
          </div>

          <div className="action-col">
            <button className="btn" onClick={scan} disabled={busy || !types.length || !rarities.length}>
              {running && runMode === "market" ? "scanning…" : "Scan market"}
            </button>
            {showTools && (
              <button className="btn otd" onClick={runOtd} disabled={busy} title="Rare→Iconic bulk passes for the fixed wlkr tracked-player list (min discount applies)">
                {running && runMode === "otd" ? "scanning…" : "wlkr OTD scan"}
              </button>
            )}
            {showTools && (
              <button className="btn otd" onClick={runActive} disabled={busy} title="Rare→Iconic bulk passes for the wlkr current-season (2026-27) player list (min discount applies)">
                {running && runMode === "active" ? "scanning…" : "wlkr Active scan"}
              </button>
            )}
            {running && <span className="muted-note">{sweepMsg}</span>}
          </div>
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
                <DealRow key={d.listingId} d={d} tag={tags.get(d.listingId)} />
              ))}
            </ul>
          )}
        </div>
      )}

      {showTools && menuOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setMenuOpen(false);
          }}
        >
          <div className="modal" role="dialog" aria-modal="true" aria-label="Tracked players">
            <div className="modal-head">
              <h2 className="modal-title">
                tracked players<span className="modal-sub"> · wlkr OTD list</span>
              </h2>
              <span className="muted-note">{checked.length} selected</span>
              <span className="modal-actions">
                <button className="btn ghost sm" onClick={clearChecked} disabled={!checked.length}>
                  clear
                </button>
                <button className="btn sm" onClick={() => setMenuOpen(false)}>
                  Done
                </button>
              </span>
            </div>
            <p className="muted-note modal-hint">
              Checked players act like they&apos;re in the Specific players box — &quot;Scan
              market&quot; then runs across every sport/season slice they belong to (no dropdown
              changes needed). Typed names still only apply to the selected sport/season.
            </p>
            <div className="modal-body">
              {OTD_MENU.map((g) => (
                <section key={g.sport} className="menu-sport">
                  <h3 className="menu-sport-title">{g.label}</h3>
                  {g.seasons.map((sg) => (
                    <div key={sg.season} className="menu-season">
                      <div className="menu-season-label">{sg.label}</div>
                      <div className="menu-players">
                        {sg.players.map((p) => {
                          const on = checked.includes(p.key);
                          return (
                            <label key={p.key} className={`menu-player ${on ? "on" : ""}`}>
                              <input
                                type="checkbox"
                                checked={on}
                                onChange={() => toggleChecked(p.key)}
                              />
                              {p.name}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
