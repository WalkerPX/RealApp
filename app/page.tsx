"use client";

import { useCallback, useEffect, useState } from "react";
import { realBoostUrl } from "@/lib/real-api";
import ShopPanel from "@/components/shop-panel";
import {
  SUPPORTED_SPORTS,
  type DashboardCard,
  type DashboardResponse,
  type PlayerRole,
  type Sport,
} from "@/lib/types";

function teamName(game: NonNullable<DashboardResponse["cards"][number]["game"]>, teamId: number) {
  const t = game.homeTeamId === teamId ? game.homeTeam : game.awayTeam;
  return t?.displayName || t?.name || null;
}

// Real rarity → UI color (keep in sync with --rarity-* in globals.css):
// Rare → orange · Epic → red/pink · Legendary → purple.
const RARITY_COLORS: Record<string, string> = {
  legendary: "#7856ff",
  epic: "#d6409f",
  rare: "#e66200",
  uncommon: "#00a163",
  common: "#0483d7",
};

function rarityColor(label?: string | null): string {
  if (!label) return ICY_BLUE;
  const k = label.toLowerCase();
  for (const key of ["legendary", "epic", "rare", "uncommon", "common"]) {
    if (k.includes(key)) return RARITY_COLORS[key];
  }
  return ICY_BLUE;
}

// Fallback for non-rarity labels ("General", lineup TBD, etc.) — matches the
// icy theme accent rather than implying a rarity.
const ICY_BLUE = "#38bdf8";

function CardView({ c }: { c: DashboardCard }) {
  const { pass } = c;
  const passTeamId =
    pass.entityType === "team"
      ? pass.entity.id
      : pass.entity.teamId ?? 0;
  const own =
    pass.entityType === "team"
      ? pass.label
      : c.game
        ? teamName(c.game, passTeamId)
        : null;
  const opp = c.opponent?.displayName || c.opponent?.name || null;
  const pct = Math.min(100, parseFloat(pass.boostInfo.percentage || "0"));
  const cardColor = rarityColor(pass.boostInfo.rarityLabel);
  const suggColor = c.suggestedBooster ? rarityColor(c.suggestedBooster.rarityLabel) : null;
  const boosted = pass.boostInfo.isCardBoosted === true;

  return (
    <article className="card">
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
        <span className="rarity-chip" style={{ color: cardColor }}>
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
          <span style={{ width: `${pct}%`, background: cardColor }} />
        </div>
      </div>

      {c.suggestedBooster && suggColor && (
        <div
          className="suggestion"
          style={{
            borderColor: suggColor,
            background: `color-mix(in srgb, ${suggColor} 9%, transparent)`,
          }}
        >
          <div className="s-head" style={{ color: suggColor }}>
            suggested booster
          </div>
          <div className="s-main">
            <span className="sugg-pill" style={{ color: suggColor }}>
              {c.suggestedBooster.rarityLabel}
            </span>
            {c.suggestedBooster.statLabel}
          </div>
          <div className="s-sub">
            {c.suggestedBooster.multiplierDisplay} · +{c.suggestedBooster.boostValue} rax
            {" · "}
            {c.suggestedBooster.remainingCount} in stock
          </div>
          <a href={realBoostUrl(pass.entity.id)} target="_blank" rel="noreferrer">
            Boost on Real →
          </a>
        </div>
      )}

      {boosted && <span className="boosted-tag">BOOSTED</span>}

      {opp && !boosted && !c.suggestedBooster && (
        <div className="matchup">vs <strong>{opp}</strong></div>
      )}
    </article>
  );
}

const GROUP_TITLES: Record<PlayerRole, string> = {
  pitcher: "Pitchers",
  hitter: "Position Players",
  team: "Teams",
};

export default function Page() {
  const [view, setView] = useState<"boost" | "shop">("boost");
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
      <header className="topbar">
        <a
          className="toplink"
          href="https://www.realapp.com/u/walkr"
          target="_blank"
          rel="noreferrer"
        >
          @walkr on real
        </a>
      </header>

      <div className="panel">
        <div className="sports" role="tablist" aria-label="Sport">
          {SUPPORTED_SPORTS.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={s.id === sport}
              className={`sport-pill ${s.id === sport ? "active" : ""}`}
              disabled={!s.implemented}
              onClick={() => {
                setView("boost");
                setSport(s.id);
              }}
            >
              {s.label}
            </button>
          ))}
          <button
            key="shop"
            role="tab"
            aria-selected={view === "shop"}
            className={`sport-pill shop ${view === "shop" ? "active" : ""}`}
            onClick={() => setView("shop")}
          >
            Shop
          </button>
        </div>

        {view === "boost" && (
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
        )}
      </div>

      {view === "shop" ? (
        <ShopPanel />
      ) : (
        <>
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
            <div className="groups">
              {(["pitcher", "hitter", "team"] as PlayerRole[]).map((role) => {
                const cards = data.cards.filter((c) => c.role === role);
                if (cards.length === 0) return null;
                return (
                  <section className="group" key={role}>
                    <h2 className="group-title">
                      {GROUP_TITLES[role]}
                      <span className="count">{cards.length}</span>
                    </h2>
                    <div className="grid">
                      {cards.map((c) => (
                        <CardView key={c.pass.id} c={c} />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </>
      )}
      </>
      )}

      <p className="foot">
        Made by <a href="https://www.realapp.com/u/walkr" target="_blank" rel="noreferrer">@walkr</a> on real
      </p>
    </main>
  );
}
