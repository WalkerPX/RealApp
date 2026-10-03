"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LEVEL_MULT, LINEUP_SIZES, RARITY_TIERS } from "@/lib/otd-levels";
import type { OtdSolution } from "@/lib/optimal-otd";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Month grids are laid out over a leap year so every claim date is reachable. */
const YEAR = 2028;

/** Rax-per-rating ceilings the budget filter offers. */
const BUDGET_CEILINGS = [10, 20];

function asofLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  })} UTC`;
}

function short(n: number): string {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function monthLabel(month: string): string {
  const [, m] = month.split("-").map(Number);
  return new Date(Date.UTC(YEAR, m - 1, 1)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  });
}

function monthCells(month: string): (string | null)[] {
  const [, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(YEAR, m - 1, 1));
  const days = new Date(Date.UTC(YEAR, m, 0)).getUTCDate();
  const cells: (string | null)[] = Array.from({ length: first.getUTCDay() }, () => null);
  for (let d = 1; d <= days; d++) cells.push(`${month}-${String(d).padStart(2, "0")}`);
  return cells;
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function seasonLabel(sport: string, season: number): string {
  if (sport === "ncaam" || sport === "nba") {
    return `${season - 1}-${String(season % 100).padStart(2, "0")}`;
  }
  return `${season}-${String((season % 100) + 1).padStart(2, "0")}`;
}

interface Available {
  id: string;
  label: string;
  cards: number;
}

export default function OptimalOtdPanel() {
  const [sports, setSports] = useState<string[] | null>(null); // null = all
  const [k, setK] = useState(10);
  /** false = k cards in total across the selected sports;
   *  true  = k cards for EACH selected sport. */
  const [perSportMode, setPerSportMode] = useState(false);
  /** Budget: keep only cards with multiple live listings at or under the
   *  rax-per-rating ceiling, so the lineup is actually buyable. */
  const [budgetOn, setBudgetOn] = useState(false);
  const [budgetMax, setBudgetMax] = useState(10);
  const [budgetSwept, setBudgetSwept] = useState<string[]>([]);
  const [budgetAsof, setBudgetAsof] = useState<string | null>(null);
  const [level, setLevel] = useState(5);
  const [sol, setSol] = useState<OtdSolution | null>(null);
  const [available, setAvailable] = useState<Available[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [month, setMonth] = useState<string>(() => `${YEAR}-01`);
  const [day, setDay] = useState<string | null>(null);

  const mult = LEVEL_MULT[level] ?? 1;
  const sportsKey = sports ? sports.join(",") : "all";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/optimal-otd?sports=${encodeURIComponent(sportsKey)}&k=${k}` +
          `&mode=${perSportMode ? "persport" : "total"}` +
          `&budget=${budgetOn ? budgetMax : "off"}`
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setSol(body as OtdSolution);
      if (Array.isArray(body?.available)) setAvailable(body.available as Available[]);
      if (Array.isArray(body?.budgetSwept)) setBudgetSwept(body.budgetSwept as string[]);
      if (typeof body?.budgetAsof === "string") setBudgetAsof(body.budgetAsof as string);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
      setSol(null);
    } finally {
      setLoading(false);
    }
  }, [sportsKey, k, perSportMode, budgetOn, budgetMax]);

  useEffect(() => {
    void load();
  }, [load]);

  const cells = useMemo(() => monthCells(month), [month]);
  const monthTotal = useMemo(() => {
    if (!sol) return 0;
    return Object.entries(sol.byDay)
      .filter(([md]) => md.startsWith(month.slice(5)))
      .reduce((a, [, v]) => a + v, 0);
  }, [sol, month]);
  const monthMax = useMemo(() => {
    if (!sol) return 0;
    let m = 0;
    for (const [md, v] of Object.entries(sol.byDay)) {
      if (md.startsWith(month.slice(5)) && v > m) m = v;
    }
    return m;
  }, [sol, month]);

  const toggleSport = (id: string) => {
    setSports((cur) => {
      if (cur === null) return [id]; // from "all" -> just this sport
      if (cur.includes(id)) {
        const next = cur.filter((s) => s !== id);
        return next.length ? next : null;
      }
      return [...cur, id];
    });
    setDay(null);
  };

  const perSport = useMemo(() => {
    if (!sol) return [];
    const map = new Map<string, number>();
    for (const c of sol.cards) map.set(c.sport, (map.get(c.sport) ?? 0) + c.contribBase);
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [sol]);

  const dayClaims = sol && day ? sol.dayClaims[day] ?? [] : [];

  return (
    <div className="ootd">
      <div className="ootd-top">
        <button
          type="button"
          className={`sport-pill ${sports === null ? "active" : ""}`}
          onClick={() => {
            setSports(null);
            setDay(null);
          }}
        >
          All Sports
        </button>
        {available.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`sport-pill ${sports?.includes(s.id) ? "active" : ""}`}
            onClick={() => toggleSport(s.id)}
            title={`${s.cards} cards with published OTD calendars`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="ootd-body">
        <aside className="ootd-rail">
          <div className="ootd-rail-label">Total cards — All sports</div>
          <div className="ootd-rail-btns">
            {LINEUP_SIZES.map((n) => (
              <button
                key={n}
                type="button"
                className={`btn ghost sm ${!perSportMode && k === n ? "on" : ""}`}
                onClick={() => {
                  setPerSportMode(false);
                  setK(n);
                }}
                title={`${n} cards in total across the selected sports`}
              >
                {n} Card
              </button>
            ))}
          </div>

          <div className="ootd-rail-label">Total cards — Per sport</div>
          <div className="ootd-rail-btns">
            {LINEUP_SIZES.map((n) => (
              <button
                key={n}
                type="button"
                className={`btn ghost sm ${perSportMode && k === n ? "on" : ""}`}
                onClick={() => {
                  setPerSportMode(true);
                  setK(n);
                }}
                title={`${n} cards for each selected sport`}
              >
                {n} Card
              </button>
            ))}
          </div>

          <div className="ootd-rail-label">Rarity</div>
          <div className="ootd-rail-btns">
            {RARITY_TIERS.map((t) => (
              <button
                key={t.level}
                type="button"
                className={`btn ghost sm ${level === t.level ? "on" : ""}`}
                onClick={() => setLevel(t.level)}
                title={`level ${t.level} · ×${LEVEL_MULT[t.level]} base`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <p className="ootd-rail-note">
            Amounts are what the card pays at <strong>{RARITY_TIERS.find((t) => t.level === level)?.label}</strong>{" "}
            (×{mult} base). The winning lineup is the same at every rarity — only the
            numbers move.
          </p>

          <div className="ootd-rail-label">Budget</div>
          <label className="ootd-check">
            <input
              type="checkbox"
              checked={budgetOn}
              onChange={(e) => {
                setBudgetOn(e.target.checked);
                setDay(null);
              }}
            />
            <span>Only cards I can buy</span>
          </label>
          {budgetOn && (
            <>
              <div className="ootd-rail-btns">
                {BUDGET_CEILINGS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`btn ghost sm ${budgetMax === n ? "on" : ""}`}
                    onClick={() => {
                      setBudgetMax(n);
                      setDay(null);
                    }}
                    title={`Keep only cards with 2+ live listings at or under ${n} rax per rating`}
                  >
                    ≤{n} rax / rating
                  </button>
                ))}
              </div>
              <p className="ootd-rail-note">
                {budgetSwept.length ? (
                  <>
                    Marketplace scanned {asofLabel(budgetAsof)} for{" "}
                    <strong>
                      {budgetSwept
                        .map((s) => available.find((a) => a.id === s)?.label ?? s.toUpperCase())
                        .join(", ")}
                    </strong>
                    . Sports without a scan are left out of a budget lineup. Prices
                    turn over fast — treat the ceiling as a guide.
                  </>
                ) : (
                  <>No marketplace scan yet — budget can&apos;t filter anything.</>
                )}
              </p>
            </>
          )}
        </aside>

        <div className="ootd-main">
          {error && <div className="error-banner">{error}</div>}
          {loading && !sol && <p className="empty">Solving…</p>}

          {sol && (
            <>
              <div className="ootd-sum">
                <p className="ootd-sum-line">
                  {sol.perSport ? (
                    <>
                      Best <strong>{sol.k}</strong> per sport —{" "}
                      <strong>{sol.totalCards}</strong> cards ·{" "}
                    </>
                  ) : (
                    <>Best <strong>{sol.k}-card</strong> lineup ·{" "}</>
                  )}
                  {sports === null
                    ? `all ${sol.sports.length} sports`
                    : sol.sports.map((s) => available.find((a) => a.id === s)?.label ?? s).join(" + ")}
                </p>
                <p className="ootd-total">
                  {(sol.totalBase * mult).toLocaleString()}
                  <span className="ootd-total-unit"> rax / year</span>
                </p>
                <p className="ootd-sub">
                  {sol.totalBase.toLocaleString()} base ·{" "}
                  {perSport
                    .map(([s, v]) => `${available.find((a) => a.id === s)?.label ?? s} ${short(v * mult)}`)
                    .join(" · ")}
                </p>
                {sol.budget != null && (
                  <p className="ootd-sub">
                    Budget ≤{sol.budget} rax/rating · {sol.budgetPool} card
                    {sol.budgetPool === 1 ? "" : "s"} qualify
                    {sol.budgetExcluded.length > 0 && (
                      <>
                        {" "}
                        ·{" "}
                        {sol.budgetExcluded
                          .map((s) => available.find((a) => a.id === s)?.label ?? s.toUpperCase())
                          .join(", ")}{" "}
                        left out (no market scan)
                      </>
                    )}
                  </p>
                )}
              </div>

              <div className="cal">
                <div className="cal-nav">
                  <button className="btn ghost" type="button" onClick={() => setMonth(shiftMonth(month, -1))}>
                    ‹
                  </button>
                  <span className="cal-month">
                    {monthLabel(month)}
                    <span className="cal-month-total">{(monthTotal * mult).toLocaleString()} rax</span>
                  </span>
                  <button className="btn ghost" type="button" onClick={() => setMonth(shiftMonth(month, 1))}>
                    ›
                  </button>
                </div>
                <div className="cal-grid">
                  {DOW.map((d) => (
                    <span className="cal-dow" key={d}>
                      {d}
                    </span>
                  ))}
                  {cells.map((c, i) => {
                    if (!c) return <span className="cal-cell blank" key={`b${i}`} />;
                    const md = c.slice(5);
                    const v = sol.byDay[md] ?? 0;
                    const pct = monthMax > 0 ? v / monthMax : 0;
                    return (
                      <button
                        type="button"
                        key={c}
                        className={`cal-cell${day === md ? " today" : ""}${v ? "" : " zero"}`}
                        style={v ? { background: `rgba(56, 189, 248, ${0.1 + pct * 0.55})` } : undefined}
                        title={`${c} · ${v ? `${(v * mult).toLocaleString()} rax` : "no claims"}`}
                        onClick={() => setDay(day === md ? null : md)}
                      >
                        <span className="cal-dom">{Number(c.slice(8))}</span>
                        <span className="cal-val">{v ? short(v * mult) : ""}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {day && (
                <div className="ootd-day">
                  <div className="ootd-day-head">
                    <strong>{monthLabel(`${YEAR}-${day.slice(0, 2)}`).split(" ")[0]} {Number(day.slice(3))}</strong>
                    <span className="muted-note">
                      {(dayClaims.reduce((a, c) => a + c.value, 0) * mult).toLocaleString()} rax ·{" "}
                      {dayClaims.length} claim{dayClaims.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  {dayClaims.length === 0 ? (
                    <p className="empty">No claims that day — nothing in the lineup has a game.</p>
                  ) : (
                    <ul className="ootd-day-list">
                      {dayClaims.map((c, i) => (
                        <li key={`${c.playerId}-${c.season}-${i}`}>
                          <span className="ootd-day-name">{c.name}</span>
                          <span className="ootd-day-meta">
                            {c.sport.toUpperCase()} {seasonLabel(c.sport, c.season)}
                          </span>
                          <span className="ootd-day-val">+{(c.value * mult).toLocaleString()}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <div className="ootd-cards">
                {sol.cards.map((c) => (
                  <article className="ootd-card" key={`${c.sport}-${c.playerId}-${c.season}`}>
                    <div className="ootd-card-top">
                      <span className="ootd-card-name">{c.name}</span>
                      <span className="mini-chip tag">{c.sportLabel}</span>
                    </div>
                    <div className="ootd-card-meta">
                      {seasonLabel(c.sport, c.season)} · claimed {c.claimedDays} of {c.seasonDays} days
                    </div>
                    {c.budgetListings != null && (
                      <div className="ootd-card-meta">
                        <span
                          className="mini-chip tag"
                          title={`${c.budgetListings} live listings at or under ${sol.budget} rax/rating, out of ${c.budgetTotal} total`}
                        >
                          {c.budgetListings} cheap / {c.budgetTotal} listed
                        </span>
                      </div>
                    )}
                    <div className="ootd-card-val">{(c.contribBase * mult).toLocaleString()} rax/yr</div>
                  </article>
                ))}
              </div>

              <p className="muted-note ootd-foot">
                A card only earns on days it wins one of that sport&apos;s two daily claims, so its
                contribution is far below its season total. Lineups are solved over every published
                OTD calendar, not just the cards you own.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
