"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { logMonitor } from "@/components/monitor-panel";

interface CardRow {
  passId: number;
  entityId: number;
  label: string;
  sport: string;
  sportLabel: string;
  position?: string | null;
  opponent?: string | null;
  gameStatus?: string | null;
  rarityLabel?: string | null;
  rating: number;
  perfRax: number;
  cardMult: number;
  boosterMult: number;
  statBoost: { label: string; value: number; rate: number; amount: number } | null;
  total: number;
}

interface SportRow {
  sport: string;
  label: string;
  total: number;
  cards: CardRow[];
}

interface PendingResponse {
  day: string;
  generatedAt: string;
  total: number;
  cards: number;
  sports: SportRow[];
  awaiting: number;
  payout: string;
  cached: boolean;
  partial: boolean;
  deferred: number;
  debug: string[];
  error?: string;
}

/** Real is read one game at a time, paced slowly on purpose, so a full day can
 * take a couple of passes. Auto-continue a bounded number of times, then hand
 * it to the user. */
const MAX_AUTO_CONTINUES = 6;
const CONTINUE_DELAY_MS = 2500;

function short(n: number): string {
  if (!n) return "0";
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function dayLabel(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function clockLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "42 × 35 + 57 RUYDS" — the arithmetic behind a card's pending rax. */
function mathLine(c: CardRow): string {
  const mult = c.cardMult + c.boosterMult;
  const bits = [`${c.perfRax} × ${mult}`];
  if (c.statBoost) bits.push(`${Math.round(c.statBoost.amount * 10) / 10} ${c.statBoost.label}`);
  return bits.join(" + ");
}

export default function PendingPanel() {
  const [data, setData] = useState<PendingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const continues = useRef(0);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(force ? "/api/pending?force=1" : "/api/pending");
      const body = (await res.json()) as PendingResponse;
      if (!res.ok || body.error) {
        logMonitor({
          tag: "pending",
          label: "today",
          status: res.status,
          sentToReal: res.status !== 400,
          ok: false,
          msg: body.error ?? `HTTP ${res.status}`,
        });
        // Surface it and stop — no silent retries against a throttled API.
        continues.current = MAX_AUTO_CONTINUES;
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      logMonitor({
        tag: "pending",
        label: `${body.cards} cards · ${body.day}${body.partial ? " (partial)" : ""}`,
        status: res.status,
        sentToReal: true,
        ok: true,
        msg: `${body.total} rax pending`,
      });
      setData(body);
    } catch (e) {
      continues.current = MAX_AUTO_CONTINUES;
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A partial load means the 40s budget ran out mid-slate; the box scores it
  // already read are cached, so the next call resumes rather than restarts.
  useEffect(() => {
    if (!data) return;
    if (!data.partial) {
      continues.current = 0;
      return;
    }
    if (continues.current >= MAX_AUTO_CONTINUES || loading) return;
    const t = setTimeout(() => {
      continues.current += 1;
      void load();
    }, CONTINUE_DELAY_MS);
    return () => clearTimeout(t);
  }, [data, loading, load]);

  const stalled = Boolean(data?.partial) && continues.current >= MAX_AUTO_CONTINUES;

  return (
    <div className="rax">
      {error && <div className="error-banner">{error}</div>}
      {loading && !data && <p className="empty">Reading today&apos;s games…</p>}

      {data && (
        <>
          <div className="rax-head">
            <div>
              <p className="rax-label">
                Pending rax · <strong>{dayLabel(data.day)}</strong>
                {data.sports.length > 0 && (
                  <>
                    {" · "}
                    {data.sports.map((s) => `${s.label} ${short(s.total)}`).join(" · ")}
                  </>
                )}
              </p>
              <p className="rax-total">{data.total.toLocaleString()}</p>
              <p className="rax-sub">
                {data.cards} card{data.cards === 1 ? "" : "s"} playing today
                {data.awaiting > 0 && ` · ${data.awaiting} yet to appear`}
              </p>
              <p className="rax-note">
                Not credited yet — player card earnings land as one lump at {data.payout} for the
                previous day. Recomputed from live box scores ({clockLabel(data.generatedAt)} ET
                snapshot), so games still in progress keep adding to this.
              </p>
              {data.partial && (
                <p className="rax-note">
                  Still reading {data.deferred} game{data.deferred === 1 ? "" : "s"} — Real is
                  queried slowly on purpose to stay clear of its rate limit.
                  {loading
                    ? " Continuing…"
                    : stalled
                      ? " Stopped; press Finish reading."
                      : " Continuing automatically…"}
                </p>
              )}
            </div>
            <div className="rax-actions">
              {stalled && (
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => {
                    continues.current = 0;
                    void load();
                  }}
                >
                  Finish reading
                </button>
              )}
              <button
                className="btn ghost"
                type="button"
                onClick={() => void load(true)}
                disabled={loading}
              >
                {loading ? "reading…" : "Refresh"}
              </button>
            </div>
          </div>

          {data.sports.length === 0 ? (
            <div>
              <p className="empty">
                No owned cards have played yet today — check back once games are underway.
              </p>
              {data.debug.length > 0 && (
                <div className="debug-trace">
                  <div className="debug-trace-title">Source trace</div>
                  {data.debug.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="rax-breakdown">
              {data.sports.map((s) => (
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
                              {[c.position, c.opponent ? `vs ${c.opponent}` : null]
                                .filter(Boolean)
                                .join(" · ")}
                            </div>
                          </div>
                          {c.rarityLabel && <span className="rarity-chip">{c.rarityLabel}</span>}
                        </div>
                        <div className="mult">+{c.total.toLocaleString()} rax pending</div>
                        <div className="player-meta" title="rating × multiplier + booster stat">
                          {mathLine(c)}
                        </div>
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
