"use client";

import { useCallback, useEffect, useState } from "react";
import { realBoostUrl } from "@/lib/real-api";
import { SUPPORTED_SPORTS, type DashboardResponse, type Sport } from "@/lib/types";

function teamName(game: NonNullable<DashboardResponse["cards"][number]["game"]>, teamId: number) {
  const t = game.homeTeamId === teamId ? game.homeTeam : game.awayTeam;
  return t?.displayName || t?.name || null;
}

export default function Page() {
  const [sport, setSport] = useState<Sport>("mlb");
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DashboardResponse | null>(null);

  const run = useCallback(async () => {
    const u = username.trim();
    if (!u) return;
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch(
        `/api/dashboard?username=${encodeURIComponent(u)}&sport=${sport}`
      );
      const body = await res.json();
      if (!res.ok) {
        const sugg = body?.suggestions?.length
          ? ` Did you mean: ${body.suggestions.map((s: { userName: string }) => s.userName).join(", ")}?`
          : "";
        setError(body?.error + sugg || `Request failed (${res.status})`);
      } else {
        setData(body);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [username, sport]);

  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => setLoading(false), 45000);
    return () => clearTimeout(t);
  }, [loading]);

  return (
    <main className="shell">
      <h1 className="brand">
        walkr<span className="dot">.</span>
      </h1>
      <p className="tagline">
        Real Sports boost control — who&apos;s playing today, and what to play on them.
      </p>

      <div className="panel">
        <div className="sports" role="tablist" aria-label="Sport">
          {SUPPORTED_SPORTS.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={s.id === sport}
              className={`sport-pill ${s.id === sport ? "active" : ""}`}
              disabled={!s.implemented}
              onClick={() => setSport(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <form
          className="search-row"
          onSubmit={(e) => {
            e.preventDefault();
            run();
          }}
        >
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Real username (e.g. walkr)"
            autoFocus
            spellCheck={false}
          />
          <button className="btn" type="submit" disabled={loading || !username.trim()}>
            {loading ? "loading…" : "Look up"}
          </button>
        </form>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {data && (
        <>
          <p className="summary">
            <strong>{data.user.userName}</strong> owns <strong>{data.totalOwned}</strong>{" "}
            {data.sport.toUpperCase()} cards · <strong>{data.projectedCount}</strong> projected to
            play today ({data.day})
            {data.suggestionsForSelf === false && (
              <span className="muted-note">
                {" "}
                — booster suggestions only apply when looking up the configured account&apos;s own
                username
              </span>
            )}
          </p>

          {data.cards.length === 0 ? (
            <p className="empty">
              No owned {data.sport.toUpperCase()} cards playing today — check back on a
              game day.
            </p>
          ) : (
            <div className="grid">
              {data.cards.map((c) => {
                const { pass } = c;
                const passTeamId =
                  pass.entityType === "team"
                    ? pass.entity.id
                    : pass.entity.teamId ?? 0;
                const own = pass.entityType === "team"
                  ? pass.label
                  : c.game
                    ? teamName(c.game, passTeamId)
                    : null;
                const opp = c.opponent?.displayName || c.opponent?.name || null;
                const pct = Math.min(100, parseFloat(pass.boostInfo.percentage || "0"));
                return (
                  <article className="card" key={pass.id}>
                    <div className="card-head">
                      <div>
                        <h3 className="player-name">{pass.label}</h3>
                        <div className="player-meta">
                          {[own, pass.infoDetail].filter(Boolean).join(" · ")}
                        </div>
                        <div className="chips">
                          {c.role === "pitcher" && <span className="mini-chip p">P</span>}
                          {c.role === "team" && <span className="mini-chip">TEAM</span>}
                          {c.score !== null && c.score > 0 && (
                            <span
                              className={`mini-chip score ${c.score >= 80 ? "hot" : c.score >= 58 ? "warm" : ""}`}
                              title="Projected game quality (season form vs 0-100)"
                            >
                              proj {c.score}
                            </span>
                          )}
                          {c.lineupTbd && (
                            <span className="mini-chip tbd" title="Lineups aren't posted yet">
                              lineup TBD
                            </span>
                          )}
                        </div>
                      </div>
                      <span
                        className="rarity-chip"
                        style={{ color: pass.boostInfo.rarityColor }}
                      >
                        {pass.boostInfo.rarityLabel}
                      </span>
                    </div>

                    <div className="mult">{pass.boostInfo.multiplier}</div>

                    <div>
                      <div className="progress-row">
                        <span>{pass.boostInfo.progressDisplay}</span>
                        <span>{pass.boostInfo.progressQualifier}</span>
                      </div>
                      <div className="bar">
                        <span style={{ width: `${pct}%` }} />
                      </div>
                    </div>

                    {pass.boostInfo.isCardBoosted && <span className="boosted-tag">BOOSTED</span>}

                    {!pass.boostInfo.isCardBoosted && c.suggestedBooster && (
                      <div className="suggestion">
                        <div className="s-head">suggested booster</div>
                        <div className="s-main">
                          {c.suggestedBooster.rarityLabel} {c.suggestedBooster.statLabel}
                        </div>
                        <div className="s-sub">
                          {c.suggestedBooster.multiplierDisplay} · +{c.suggestedBooster.boostValue} rax
                          {" · "}
                          {c.suggestedBooster.remainingCount} in stock
                        </div>
                        <a href={realBoostUrl(pass.id, sport)} target="_blank" rel="noreferrer">
                          Boost on Real →
                        </a>
                      </div>
                    )}

                    {opp && !pass.boostInfo.isCardBoosted && !c.suggestedBooster && (
                      <div className="matchup">vs <strong>{opp}</strong></div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </>
      )}

      <p className="foot">
        Unofficial tool. Data from the Real Sports App web API — <code>MLB only for now</code>.
      </p>
    </main>
  );
}
