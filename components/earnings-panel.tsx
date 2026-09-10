"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { logMonitor } from "@/components/monitor-panel";

interface CardRow {
  passId: number;
  entityId: number;
  label: string;
  sport: string;
  infoDetail?: string | null;
  seasonDisplay?: string | null;
  rarityLabel?: string | null;
  level?: number | null;
  boosted?: boolean;
  amount: number;
}

interface SportRow {
  sport: string;
  label: string;
  total: number;
  cards: CardRow[];
}

interface RaxResponse {
  day: string;
  today: string;
  total: number;
  detail: {
    dayDisplay: string;
    isActiveDay: boolean | null;
    headerDisplay?: string | null;
    subHeaderDisplay?: string | null;
    emptyMessage?: string | null;
    detailMessage?: string | null;
    sports: SportRow[];
    total: number;
    cards: number;
  };
  calendar: Record<string, number>;
  calendarTotal: number;
  bestDay: { day: string; total: number } | null;
  etHour: number;
  etMinute: number;
  rollover: string;
  error?: string;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function labelOf(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function short(n: number): string {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  });
}

function monthCells(month: string): (string | null)[] {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (string | null)[] = Array.from({ length: first.getUTCDay() }, () => null);
  for (let d = 1; d <= days; d++) cells.push(`${month}-${String(d).padStart(2, "0")}`);
  return cells;
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default function EarningsPanel() {
  const [data, setData] = useState<RaxResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCal, setShowCal] = useState(false);
  const [month, setMonth] = useState<string | null>(null);

  const load = useCallback(async (day?: string) => {
    setLoading(true);
    setError(null);
    try {
      const url = day
        ? `/api/earnings?day=${encodeURIComponent(day)}`
        : "/api/earnings";
      const res = await fetch(url);
      const body = (await res.json()) as RaxResponse;
      if (!res.ok || body.error) {
        logMonitor({
          tag: "earnings",
          label: day ?? "today",
          status: res.status,
          sentToReal: res.status !== 400,
          ok: false,
          msg: body.error ?? `HTTP ${res.status}`,
        });
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      logMonitor({
        tag: "earnings",
        label: `${body.detail.cards} cards · ${body.detail.dayDisplay}`,
        status: res.status,
        sentToReal: true,
        ok: true,
        msg: `${body.total} rax`,
      });
      setData(body);
      setMonth((m) => m ?? body.day.slice(0, 7));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const cells = useMemo(() => (month ? monthCells(month) : []), [month]);
  const monthTotal = useMemo(() => {
    if (!data || !month) return 0;
    return Object.entries(data.calendar)
      .filter(([d]) => d.startsWith(month))
      .reduce((a, [, v]) => a + v, 0);
  }, [data, month]);
  const monthMax = useMemo(() => {
    if (!data || !month) return 0;
    let m = 0;
    for (const [d, v] of Object.entries(data.calendar)) {
      if (d <= data.today && d.startsWith(month) && v > m) m = v;
    }
    return m;
  }, [data, month]);

  return (
    <div className="rax">
      {error && <div className="error-banner">{error}</div>}
      {loading && !data && <p className="empty">Loading rax earnings…</p>}

      {data && (
        <>
          <div className="rax-head">
            <div>
              <p className="rax-label">
                Rax earned · <strong>{labelOf(data.day)}</strong>
                {data.detail.headerDisplay ? ` · ${data.detail.headerDisplay}` : ""}
              </p>
              <p className="rax-total">{data.detail.total.toLocaleString()}</p>
              <p className="rax-sub">
                {data.detail.cards} card{data.detail.cards === 1 ? "" : "s"} earned
                {data.detail.sports.length > 0 && (
                  <>
                    {" · "}
                    {data.detail.sports
                      .map((s) => `${s.label} ${short(s.total)}`)
                      .join(" · ")}
                  </>
                )}
              </p>
              {data.total !== data.detail.total && (
                <p className="rax-sub">
                  Real&apos;s day ledger: {data.total.toLocaleString()} rax
                </p>
              )}
              <p className="rax-note">
                Day rolls at {data.rollover} (now {String(data.etHour).padStart(2, "0")}:
                {String(data.etMinute).padStart(2, "0")} ET) — 5am still shows the day before.
                {data.detail.isActiveDay === true && " Still settling today."}
              </p>
            </div>
            <div className="rax-actions">
              <button className="btn ghost" type="button" onClick={() => setShowCal((v) => !v)}>
                {showCal ? "Hide calendar" : "Calendar"}
              </button>
              <button
                className="btn ghost"
                type="button"
                onClick={() => void load()}
                disabled={loading}
              >
                {loading ? "refreshing…" : "Refresh"}
              </button>
            </div>
          </div>

          <p className="rax-stats">
            season to date: <strong>{data.calendarTotal.toLocaleString()}</strong> rax
            {data.bestDay && (
              <>
                {" "}
                · best day <strong>{labelOf(data.bestDay.day)}</strong> (
                {data.bestDay.total.toLocaleString()})
              </>
            )}
          </p>

          {showCal && month && (
            <div className="cal">
              <div className="cal-nav">
                <button className="btn ghost" type="button" onClick={() => setMonth(shiftMonth(month, -1))}>
                  ‹
                </button>
                <span className="cal-month">
                  {monthLabel(month)}
                  <span className="cal-month-total">{monthTotal.toLocaleString()} rax</span>
                </span>
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => setMonth(shiftMonth(month, 1))}
                  disabled={month >= data.day.slice(0, 7)}
                >
                  ›
                </button>
              </div>
              <div className="cal-grid">
                {DOW.map((d) => (
                  <span className="cal-dow" key={d}>
                    {d}
                  </span>
                ))}
                {cells.map((day, i) => {
                  if (!day) return <span className="cal-cell blank" key={`b${i}`} />;
                  // Future days carry placeholder values in Real's map — only
                  // days up to the current eastern day have real earnings.
                  const v = day <= data.today ? data.calendar[day] ?? 0 : 0;
                  const pct = monthMax > 0 ? v / monthMax : 0;
                  return (
                    <button
                      type="button"
                      key={day}
                      className={`cal-cell${day === data.day ? " today" : ""}${v ? "" : " zero"}`}
                      style={v ? { background: `rgba(56, 189, 248, ${0.1 + pct * 0.55})` } : undefined}
                      title={`${labelOf(day)} · ${v.toLocaleString()} rax`}
                      onClick={() => void load(day)}
                      disabled={loading}
                    >
                      <span className="cal-dom">{Number(day.slice(8))}</span>
                      <span className="cal-val">{v ? short(v) : ""}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {(data.detail.sports.length > 0 || data.detail.emptyMessage) && (
            <div className="rax-breakdown">
              {data.detail.emptyMessage && (
                <p className="rax-note">{data.detail.emptyMessage}</p>
              )}
              {data.detail.sports.map((s) => (
                <section className="group" key={s.sport}>
                  <h2 className="group-title">
                    {s.label}
                    <span className="count">{s.total.toLocaleString()}</span>
                  </h2>
                  <div className="grid">
                    {s.cards.map((c) => (
                      <article className="card" key={`${s.sport}-${c.passId}`}>
                        <div className="card-head">
                          <div>
                            <h3 className="player-name">{c.label}</h3>
                            <div className="player-meta">
                              {[c.infoDetail, c.seasonDisplay].filter(Boolean).join(" · ")}
                            </div>
                          </div>
                          {c.rarityLabel && <span className="rarity-chip">{c.rarityLabel}</span>}
                        </div>
                        <div className="mult">+{c.amount.toLocaleString()} rax</div>
                        {c.boosted && <span className="boosted-tag">BOOSTED</span>}
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
