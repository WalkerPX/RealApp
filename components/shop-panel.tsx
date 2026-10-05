"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { logMonitor } from "@/components/monitor-panel";
import {
  DEAL_SEASONS,
  DEAL_SPORTS,
  LISTING_TYPE_META,
  LOW_PERRAX_FACTOR,
  LOW_PERRAX_SLICES,
  RARITY_LABELS,
  WALKER_ACTIVE_SLICES,
  WALKER_OTD_SLICES,
  seasonErrorMessage,
  seasonLabel,
  walkerOtdKey,
  walkerOtdMenu,
  type Deal,
  type DealListingType,
  type DealMode,
  type DealSport,
  type WalkerOtdSlice,
} from "@/lib/deals";
import {
  BUDGET_SEARCH_CEILING,
  BUDGET_SEARCH_FACTOR,
  BUDGET_SEARCH_PRESETS,
  type BudgetSearchPreset,
} from "@/lib/budget-searches";
import {
  DAILY_PACK_FACTOR,
  DAILY_PACK_PRESETS,
  PACK_RAX_PER_RATING,
  type DailyPackPreset,
} from "@/lib/daily-pack-searches";
import {
  MAX_SEARCH_FACTOR,
  MAX_SEARCH_PRESETS,
  type MaxSearchPreset,
} from "@/lib/max-searches";
import {
  SETUP_SEARCH_FACTOR,
  SETUP_SEARCH_PRESETS,
  type SetupSearchPreset,
} from "@/lib/setup-searches";

// ── Autobid ──────────────────────────────────────────────────────────────────
// The bidder is a userscript on realapp.com (see userscripts/walkr-autobid).
// Real signs every marketplace write with a Turnstile token minted by the page,
// so nothing server-side can bid — the menu's job is only to hand the extension
// a lineup and the caps. These three numbers are those caps, and they ride in
// the URL so the two can never disagree.
const AUTOBID_MAX_RPR = 11;
const AUTOBID_MAX_CARDS = 50;
const AUTOBID_MAX_SPEND = 1000;

/** UTF-8 safe base64url — the hash has to survive player names like "C.J.". */
function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

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
  /** Player names Real's search couldn't resolve (the run returns nothing for
   * them, so they're called out instead of looking like "no deals"). */
  unresolved?: string[];
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
  /** Overrides the run's rating factor for this slice — how a preset buys a
   * deep-market player looser than the rest of its lineup. */
  factor?: number;
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
        {d.isRatingDeal && d.rating != null && (
          <span className="deal-rating">
            rating {d.rating.toLocaleString()} · under{" "}
            {Math.round(d.ratingCap ?? 0).toLocaleString()} rax
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

/** /api/collection — the account's own player cards, rarest first. */
interface CollectionPlayer {
  name: string;
  key: string;
  rarity: number;
  rarityLabel: string;
  level: number;
  copies: number;
}

interface CollectionSeason {
  season: number;
  label: string;
  players: CollectionPlayer[];
}

interface CollectionSport {
  id: DealSport;
  label: string;
  count: number;
  seasons: CollectionSeason[];
}

interface ShopPanelProps {
  /** Bumped by the footer "Made" button — every click raises the tools window
   * (Quick Searches + OTD Earnings). A one-way opener, not a toggle. */
  openMenuSeq?: number;
  /** OTD Earnings tab content — lives here so the ledger ships inside the
   * tools window instead of taking a home-page tab. */
  earningsTab?: ReactNode;
}

export default function ShopPanel({ openMenuSeq = 0, earningsTab }: ShopPanelProps) {
  const [sport, setSport] = useState<DealSport>("mlb");
  const [season, setSeason] = useState<number>(DEAL_SEASONS.mlb[0]);
  const [types, setTypes] = useState<DealListingType[]>(["userpassfull"]);
  const [rarities, setRarities] = useState<number[]>([7, 6, 5]);
  const [players, setPlayers] = useState("");
  const [minDisc, setMinDisc] = useState(20);
  const [auctions, setAuctions] = useState(true);
  const [checked, setChecked] = useState<string[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  // The tools window's tabs: quick searches (presets, scans, player picker)
  // and the OTD Earnings ledger.
  const [menuTab, setMenuTab] = useState<"quick" | "earnings">("quick");
  const [running, setRunning] = useState(false);
  const [runMode, setRunMode] = useState<
    "market" | "otd" | "active" | "budget" | "daily pack" | "max" | "setup" | null
  >(null);
  // wlkr Active scan card type: bulk rating passes vs individual play cards.
  const [activeMode, setActiveMode] = useState<"bulk" | "play">("bulk");
  // wlkr Active scan screen: "discount" keeps the FMV min-discount rule;
  // "rating" swaps it for "price under factor × the card's rating" (a 5.9
  // rating at 12× = anything under 70.8 rax).
  const [screen, setScreen] = useState<DealMode>("discount");
  const [factor, setFactor] = useState(12);
  // Raw text of the rating-factor box while it's being edited. The committed
  // `factor` only follows a usable number, so clearing the box (backspacing the
  // default 12) leaves it empty instead of snapping a value back in.
  const [factorText, setFactorText] = useState("12");
  const [sweepMsg, setSweepMsg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DealsResponse | null>(null);
  const [tags, setTags] = useState<Map<number, string>>(new Map());
  // The account's own player cards (one Real call, read when the tools window
  // first opens) — the tracked-player list is built from these, rarest first.
  const [collection, setCollection] = useState<CollectionSport[] | null>(null);
  const [collectionErr, setCollectionErr] = useState<string | null>(null);
  const [collectionSport, setCollectionSport] = useState<DealSport | null>(null);

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

  // The footer "Made" button raises the tools window — each click bumps the
  // sequence, so the window re-opens even after it was closed with "Done".
  useEffect(() => {
    if (!openMenuSeq) return;
    setMenuTab("quick");
    setMenuOpen(true);
  }, [openMenuSeq]);

  // One request, on the first open of the tools window (never on page load).
  useEffect(() => {
    if (!menuOpen || collection || collectionErr) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/collection");
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        if (!alive) return;
        const sports = (body.sports ?? []) as CollectionSport[];
        setCollection(sports);
        setCollectionSport(
          (cur) =>
            cur ??
            sports.find((s) => s.id === "ncaaf")?.id ??
            sports[0]?.id ??
            null
        );
        logMonitor({
          tag: "collection",
          label: `${body.total} player cards`,
          status: res.status,
          sentToReal: true,
          ok: true,
        });
      } catch (e) {
        if (!alive) return;
        setCollectionErr(e instanceof Error ? e.message : "Unknown error");
        logMonitor({
          tag: "collection",
          label: "own card list",
          status: 0,
          sentToReal: true,
          ok: false,
          msg: e instanceof Error ? e.message : "Unknown error",
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [menuOpen, collection, collectionErr]);

  const switchSport = (s: DealSport) => {
    setSport(s);
    setSeason(DEAL_SEASONS[s][0]);
    setResult(null);
  };

  const toggleChecked = useCallback((key: string) => {
    setChecked((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
  }, []);

  const clearChecked = useCallback(() => setChecked([]), []);

  /** "Default Player Card Search": flips the shop filters to the everyday CFB
   * 2026-27 play-card screen — rating screen at 15×, common → epic. */
  const applyDefaultSearch = useCallback(() => {
    setSport("ncaaf");
    setSeason(2026);
    setScreen("rating");
    setFactor(15);
    setFactorText("15");
    setTypes(["card"]);
    setRarities([4, 3, 2, 1]);
    setResult(null);
    setError(null);
  }, []);

  /** "Low PerRax": loads the Low PerRax watch set into the tracked-player
   *  selection and flips the shop to the play-card rating screen at ≤11
   *  rax/rating — "Scan market" then sweeps every sport/season slice in the
   *  set at once. */
  const applyLowPerRax = useCallback(() => {
    setChecked(
      LOW_PERRAX_SLICES.flatMap((s) =>
        s.players.map((p) => walkerOtdKey(s.sport, s.season, p))
      )
    );
    setScreen("rating");
    setFactor(LOW_PERRAX_FACTOR);
    setFactorText(String(LOW_PERRAX_FACTOR));
    setTypes(["card"]);
    setRarities([7, 6, 5, 4, 3, 2, 1]);
    setResult(null);
    setError(null);
  }, []);

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
   * "checked players"). Types/rarities are passed per call (the OTD sweep
   * forces bulk + rare→iconic); the screen (discount vs rating ×) is a single
   * shop-wide choice, so every scan type honors the same one — unless a caller
   * passes `opts`, which the budget presets use to force their own screen and
   * factor without waiting for the state update to land. */
  const runSlices = useCallback(
    async (
      slices: RunSlice[],
      listTypes: DealListingType[],
      rar: number[],
      who: string,
      opts?: { screen?: DealMode; factor?: number }
    ) => {
      const scr = opts?.screen ?? screen;
      const fac = opts?.factor ?? factor;
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
      const unresolvedNames = new Set<string>();
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
            mode: scr,
          });
          if (scr === "rating") params.set("factor", String(s.factor ?? fac));
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
            for (const n of body.unresolved ?? []) unresolvedNames.add(n);
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
      if (!merged.length && failed > 0 && !unresolvedNames.size) {
        setError(`${who} failed on ${failed}/${total} slices — no results`);
      }
      if (!merged.length && unresolvedNames.size) {
        setError(
          `No such player on Real: ${[...unresolvedNames].join(", ")} — check the spelling or the sport/season.`
        );
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
        unresolved: [...unresolvedNames],
      });
    },
    [minDisc, auctions, screen, factor]
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
   * list, across all its sport/season slices. Honors the shop-wide screen and
   * the auctions toggle; the slice list lives in lib/deals.ts. */
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
   * (2026-27) player list instead of the bulk-earnings OTD list. Toggles
   * between bulk passes (rare→iconic) and individual play cards (any rarity). */
  const runActive = useCallback(async () => {
    if (running) return;
    setRunMode("active");
    try {
      const slices: RunSlice[] = WALKER_ACTIVE_SLICES.map((s) => ({
        sport: s.sport,
        season: s.season,
        players: s.players,
      }));
      const play = activeMode === "play";
      await runSlices(
        slices,
        play ? ["card"] : ["userpassfull"],
        play ? [7, 6, 5, 4, 3, 2, 1] : [7, 6, 5, 4, 3],
        play ? "wlkr active play set" : "wlkr active set"
      );
    } finally {
      setRunMode(null);
    }
  }, [running, runSlices, activeMode]);

  /** Preset quick searches: load a preset's lineup players, flip the filters to
   * the Low PerRax-style screen (rating × `factor`, play cards, every rarity),
   * close the tools window and run the scan straight away — no "Done" then
   * "Scan market" in between. `tag` only labels the run in the monitor.
   *
   * The slices are passed in directly rather than through `plan`, because `plan`
   * is derived from `checked` state that hasn't re-rendered yet — reading it here
   * would scan the *previous* selection. `checked` is still updated so the
   * tracked-player list shows what's being searched. */
  const runPresetSearch = useCallback(
    async (
      preset: {
        label: string;
        slices: WalkerOtdSlice[];
        playerCaps?: Record<string, number>;
      },
      factor: number,
      tag: "budget" | "daily pack" | "max" | "setup"
    ) => {
      if (running) return;
      const caps = preset.playerCaps;
      const capped = new Set(caps ? Object.keys(caps) : []);
      const slices: RunSlice[] = [];
      for (const s of preset.slices) {
        const loose = s.players.filter((p) => capped.has(p));
        const rest = s.players.filter((p) => !capped.has(p));
        if (rest.length) slices.push({ sport: s.sport, season: s.season, players: rest });
        // A scan is one factor per query, so the loosened players get their own
        // slice at their own ceiling — same sport/season, a second query for it.
        const byCap = new Map<number, string[]>();
        for (const p of loose) {
          const c = caps![p];
          if (!byCap.has(c)) byCap.set(c, []);
          byCap.get(c)!.push(p);
        }
        for (const [c, players] of byCap)
          slices.push({ sport: s.sport, season: s.season, players, factor: c });
      }
      if (!slices.length) return;
      const rar = [7, 6, 5, 4, 3, 2, 1];
      setChecked(
        slices.flatMap((s) => s.players.map((p) => walkerOtdKey(s.sport, s.season, p)))
      );
      setScreen("rating");
      setFactor(factor);
      setFactorText(String(factor));
      setTypes(["card"]);
      setRarities(rar);
      setMenuOpen(false);
      setRunMode(tag);
      try {
        await runSlices(slices, ["card"], rar, `${tag} ${preset.label}`, {
          screen: "rating",
          factor,
        });
      } finally {
        setRunMode(null);
      }
    },
    [running, runSlices]
  );

  /** Optimal Budget lineups run at the budget factor (×11). */
  const runBudgetSearch = useCallback(
    (preset: BudgetSearchPreset) =>
      runPresetSearch(preset, BUDGET_SEARCH_FACTOR, "budget"),
    [runPresetSearch]
  );

  /** Daily Pack Buys run at ×21 — anything at or under that beats a pack. */
  const runDailyPackSearch = useCallback(
    (preset: DailyPackPreset) =>
      runPresetSearch(preset, DAILY_PACK_FACTOR, "daily pack"),
    [runPresetSearch]
  );

  /** Optimal MAX runs at the pack-rate screen (×21). */
  const runMaxSearch = useCallback(
    (preset: MaxSearchPreset) => runPresetSearch(preset, MAX_SEARCH_FACTOR, "max"),
    [runPresetSearch]
  );

  /** Optimal Setup runs at the pack-rate screen (×21). */
  const runSetupSearch = useCallback(
    (preset: SetupSearchPreset) =>
      runPresetSearch(preset, SETUP_SEARCH_FACTOR, "setup"),
    [runPresetSearch]
  );

  /** Autobid caps — the hard ceilings the userscript enforces. They ride in the
   * URL so the menu and the extension can never disagree about them. */
  const autobidCaps = {
    maxRpr: AUTOBID_MAX_RPR,
    maxCards: AUTOBID_MAX_CARDS,
    maxSpend: AUTOBID_MAX_SPEND,
  };

  /** Hand the browser extension a lineup to bid on. The extension lives on
   * realapp.com (Real signs marketplace writes with a page-minted Turnstile
   * token, so nothing server-side can bid); it re-scans the lineup live and
   * bids. Everything below is dry-run until LIVE is ticked in its panel. */
  const openAutobid = (slices: WalkerOtdSlice[], label: string, playerCaps?: Record<string, number>) => {
    const payload = {
      targets: slices.map((s) => ({
        sport: s.sport,
        season: s.season,
        players: s.players,
      })),
      ...autobidCaps,
      ...(playerCaps && Object.keys(playerCaps).length ? { playerCaps } : {}),
      label,
    };
    const url = `https://www.realapp.com/#walkr=${toBase64Url(JSON.stringify(payload))}`;
    window.open(url, "_blank", "noopener,noreferrer");
    setMenuOpen(false);
  };

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
            <span className="flabel">Screen</span>
            <span className="seg" role="group" aria-label="Deal screen">
              <button
                type="button"
                className={`seg-btn ${screen === "discount" ? "on" : ""}`}
                onClick={() => setScreen("discount")}
                disabled={busy}
                title="Deal = price is at least N% under the FMV median"
              >
                discount
              </button>
              <button
                type="button"
                className={`seg-btn ${screen === "rating" ? "on" : ""}`}
                onClick={() => setScreen("rating")}
                disabled={busy}
                title="Deal = price is under factor × the card's own rating"
              >
                rating ×
              </button>
            </span>
          </label>
          {screen === "discount" ? (
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
          ) : (
            <label>
              <span className="flabel">Rax Per Rating</span>
              <span className="numwrap">
                <input
                  type="number"
                  min={1}
                  max={1000}
                  step={1}
                  value={factorText}
                  onChange={(e) => {
                    const t = e.target.value;
                    setFactorText(t);
                    const n = Math.floor(Number(t));
                    if (t !== "" && Number.isFinite(n) && n >= 1) setFactor(n);
                  }}
                  onBlur={() => {
                    // Empty (or junk) on the way out falls back to the last
                    // usable factor rather than a hardcoded default.
                    const n = Math.floor(Number(factorText));
                    if (factorText === "" || !Number.isFinite(n) || n < 1) {
                      setFactorText(String(factor));
                    }
                  }}
                  title="Price ceiling = this × the card's rating (a 5.9 card at 12× = under 70.8 rax)"
                />
                <span className="pct">×</span>
              </span>
            </label>
          )}
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
                title="Each name is resolved on Real and then that player's own listings are pulled — exact, unlike a whole-market sweep"
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
          </div>

          <div className="action-col">
            <button className="btn" onClick={scan} disabled={busy || !types.length || !rarities.length}>
              {running && runMode === "market" ? "scanning…" : "Scan market"}
            </button>
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
            {result.unresolved?.length ? (
              <span className="muted-note">
                {" "}
                — no player on Real named {result.unresolved.join(", ")}
              </span>
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

      {menuOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setMenuOpen(false);
          }}
        >
          <div className="modal" role="dialog" aria-modal="true" aria-label="Walkr's Menu">
            <div className="modal-head">
              <h2 className="modal-title">Walkr&apos;s Menu</h2>
              <span className="modal-actions">
                <button className="btn ghost sm" onClick={clearChecked} disabled={!checked.length}>
                  clear
                </button>
                <button className="btn sm" onClick={() => setMenuOpen(false)}>
                  Done
                </button>
              </span>
            </div>

            <div className="seg modal-tabs" role="tablist" aria-label="Menu tabs">
              <button
                type="button"
                role="tab"
                aria-selected={menuTab === "quick"}
                className={`seg-btn ${menuTab === "quick" ? "on" : ""}`}
                onClick={() => setMenuTab("quick")}
              >
                Quick Searches
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={menuTab === "earnings"}
                className={`seg-btn ${menuTab === "earnings" ? "on" : ""}`}
                onClick={() => setMenuTab("earnings")}
              >
                OTD Earnings
              </button>
            </div>

            {menuTab === "quick" ? (
              <>
                <div className="modal-group">
                  <div className="modal-group-label">Misc.</div>
                  <div className="modal-defaults">
                    <button className="btn sm" onClick={applyLowPerRax} disabled={busy}>
                      Low PerRax
                    </button>
                    <span className="muted-note">
                      Low PerRax set · rating × 11 · play cards · common → iconic
                    </span>
                  </div>
                  <div className="modal-defaults">
                    <button
                      className="btn otd"
                      onClick={runOtd}
                      disabled={busy}
                      title="Rare→Iconic bulk passes for the fixed wlkr tracked-player list (min discount applies)"
                    >
                      {running && runMode === "otd" ? "scanning…" : "wlkr OTD scan"}
                    </button>
                    {running && <span className="muted-note">{sweepMsg}</span>}
                  </div>
                </div>

                <div className="modal-group">
                  <div className="modal-group-label">CFB</div>
                  <div className="modal-defaults">
                    <button className="btn sm" onClick={applyDefaultSearch} disabled={busy}>
                      CFB-CardSearchDefault
                    </button>
                    <span className="muted-note">
                      CFB 2026-27 · rating × 15 · play cards · common → epic
                    </span>
                  </div>
                  <div className="modal-defaults">
                    <button
                      className="btn otd"
                      onClick={runActive}
                      disabled={busy}
                      title="Rare→Iconic bulk passes for the wlkr current-season (2026-27) player list (honors the Screen choice)"
                    >
                      {running && runMode === "active" ? "scanning…" : "CFB-ActivePlayerScan"}
                    </button>
                    <div className="seg" role="group" aria-label="Active scan card type">
                      <button
                        type="button"
                        className={`seg-btn ${activeMode === "bulk" ? "on" : ""}`}
                        onClick={() => setActiveMode("bulk")}
                        disabled={busy}
                        title="Bulk rating passes (rare → iconic)"
                      >
                        bulk
                      </button>
                      <button
                        type="button"
                        className={`seg-btn ${activeMode === "play" ? "on" : ""}`}
                        onClick={() => setActiveMode("play")}
                        disabled={busy}
                        title="Individual play cards (any rarity)"
                      >
                        play
                      </button>
                    </div>
                    {running && <span className="muted-note">{sweepMsg}</span>}
                  </div>
                </div>
                <div className="modal-group">
                  <div className="modal-group-label">Optimal Budget</div>
                  <div className="modal-defaults">
                    {BUDGET_SEARCH_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="btn sm"
                        onClick={() => void runBudgetSearch(p)}
                        disabled={busy}
                        title={
                          `Best ${p.cards}-card Optimal Budget lineup ` +
                          `(${p.best.toLocaleString()} base rax/yr) — searches ` +
                          `${p.cards} player${p.cards === 1 ? "" : "s"} at rating × ` +
                          `${BUDGET_SEARCH_FACTOR}, play cards, all rarities. Runs on click.`
                        }
                      >
                        {p.cards} Card {p.label}
                      </button>
                    ))}
                  </div>
                  <div className="modal-defaults">
                    <span className="muted-note">
                      Lineups solved at ≤{BUDGET_SEARCH_CEILING} rax/rating (≥2 live listings) ·
                      rating × {BUDGET_SEARCH_FACTOR} · play cards · all rarities. A preset may name
                      individual players it buys looser (their market is deep, so a few extra rax
                      per rating levels them fast) — the autobid screens each of those at its own
                      ceiling. Clicking one closes this window and scans straight away.
                    </span>
                  </div>
                </div>
                <div className="modal-group">
                  <div className="modal-group-label">Optimal MAX</div>
                  <div className="modal-defaults">
                    {MAX_SEARCH_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="btn sm"
                        onClick={() => void runMaxSearch(p)}
                        disabled={busy}
                        title={
                          `Optimal MAX ${p.label} — ${p.cards} push cards ` +
                          `(${p.best.toLocaleString()} base rax/yr). Searches ${p.cards} ` +
                          `player${p.cards === 1 ? "" : "s"} at rating × ${MAX_SEARCH_FACTOR}, ` +
                          `play cards, all rarities — pack-rate fuel only, so nothing ` +
                          `costlier than a daily pack shows. Runs on click.`
                        }
                      >
                        {p.cards} Card {p.label}
                      </button>
                    ))}
                  </div>
                  <div className="modal-defaults">
                    <span className="muted-note">
                      Pack-rate counterpart to Optimal Budget: screens at ≤{MAX_SEARCH_FACTOR}{" "}
                      rax/rating, so it lists only market fuel that costs the same as a daily pack
                      or less (a pack is 200 rax for ~10 rating). Reading the rax/rating column
                      picks the buys. The autobid still caps its own bids at {AUTOBID_MAX_RPR}.
                    </span>
                  </div>
                </div>
                <div className="modal-group">
                  <div className="modal-group-label">Optimal Setup</div>
                  <div className="modal-defaults">
                    {SETUP_SEARCH_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="btn sm"
                        onClick={() => void runSetupSearch(p)}
                        disabled={busy}
                        title={
                          `Optimal Setup ${p.label} — the ${p.cards} highest-ROI cards to ` +
                          `push to Legendary (${p.best.toLocaleString()} base rax/yr ` +
                          `unboosted). Searches ${p.cards} player` +
                          `${p.cards === 1 ? "" : "s"} at rating × ${SETUP_SEARCH_FACTOR}, ` +
                          `play cards, all rarities. Runs on click.`
                        }
                      >
                        {p.cards} Card {p.label}
                      </button>
                    ))}
                  </div>
                  <div className="modal-defaults">
                    <span className="muted-note">
                      The optimal-ROI upgrade set, not the optimal lineup — ranked by marginal
                      gain with the two-claims-a-day cap recomputed after every upgrade, cut
                      where the next card stops repaying inside a year. Screened at rating ×{" "}
                      {SETUP_SEARCH_FACTOR} so anything listed is at or under a pack&apos;s own
                      price. The autobid still caps its own bids at {AUTOBID_MAX_RPR}.
                    </span>
                  </div>
                </div>
                <div className="modal-group">
                  <div className="modal-group-label">Daily Pack Buys</div>
                  <div className="modal-defaults">
                    {DAILY_PACK_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="btn sm"
                        onClick={() => void runDailyPackSearch(p)}
                        disabled={busy}
                        title={
                          `Searches ${p.cards} player${p.cards === 1 ? "" : "s"} of the ` +
                          `Daily Pack Buys album at rating × ${DAILY_PACK_FACTOR}, play ` +
                          `cards, all rarities. A pack gives ~10 rating for 200 rax ` +
                          `(${PACK_RAX_PER_RATING} rax/rating), so anything this scan ` +
                          `shows is cheaper fuel than the pack. Runs on click.`
                        }
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <div className="modal-defaults">
                    <span className="muted-note">
                      The 17 cards on the daily-pack grind · rating × {DAILY_PACK_FACTOR} ·
                      play cards · all rarities. Lists anything at or under{" "}
                      {DAILY_PACK_FACTOR} rax/rating — beats the pack&apos;s own{" "}
                      {PACK_RAX_PER_RATING}. Clicking one closes this window and scans.
                    </span>
                  </div>
                </div>
                <div className="modal-group">
                  <div className="modal-group-label">Autobid</div>
                  <div className="modal-defaults">
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => openAutobid(LOW_PERRAX_SLICES, "Low PerRax")}
                      disabled={busy}
                      title={
                        `Opens realapp.com with the Low PerRax tracked-player list loaded into ` +
                        `the Walkr Autobid extension — same players the Low PerRax screen uses, ` +
                        `bid at ≤${AUTOBID_MAX_RPR} rax/rating. Dry run until you tick LIVE there.`
                      }
                    >
                      Bid Low PerRax
                    </button>
                    {BUDGET_SEARCH_PRESETS.map((p) => (
                      <button
                        key={`bid-${p.id}`}
                        type="button"
                        className="btn sm"
                        onClick={() => openAutobid(p.slices, `Optimal Budget · ${p.label}`, p.playerCaps)}
                        disabled={busy}
                        title={
                          `Opens realapp.com with the ${p.label} lineup loaded into the Walkr ` +
                          `Autobid extension. It re-scans live and bids any listing at ` +
                          `≤${AUTOBID_MAX_RPR} rax/rating, up to ${AUTOBID_MAX_CARDS} cards and ` +
                          `${AUTOBID_MAX_SPEND} rax per run. Dry run until you tick LIVE there.`
                        }
                      >
                        Bid {p.label}
                      </button>
                    ))}
                  </div>
                  <div className="modal-defaults">
                    <span className="muted-note">
                      Needs the Walkr Autobid userscript installed. It bids the buy-now trigger
                      price, which starts a 10-minute countdown — you keep the card only if nobody
                      outbids you. Caps: ≤{AUTOBID_MAX_RPR} rax/rating · ≤{AUTOBID_MAX_CARDS} cards
                      · ≤{AUTOBID_MAX_SPEND} rax per run.
                    </span>
                  </div>
                </div>
                <p className="muted-note modal-hint">
                  The presets flip the filters behind this window; the scans read the players
                  picked below. Optimal Budget buttons carry their own lineup instead.
                </p>
                <div className="modal-body">
                  {collection ? (
                    <>
                      <div className="sport-tabs" role="tablist" aria-label="Sport">
                        {collection.map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            role="tab"
                            aria-selected={collectionSport === s.id}
                            className={`sport-pill tab ${
                              collectionSport === s.id ? "active" : ""
                            }`}
                            onClick={() => setCollectionSport(s.id)}
                          >
                            {s.label}
                            <span className="count">{s.count}</span>
                          </button>
                        ))}
                      </div>
                      {(collection.find((s) => s.id === collectionSport)?.seasons ?? []).map(
                        (sg) => (
                          <div key={sg.season} className="menu-season">
                            <div className="menu-season-label">{sg.label}</div>
                            <div className="menu-players">
                              {sg.players.map((p) => {
                                const on = checked.includes(p.key);
                                return (
                                  <label
                                    key={p.key}
                                    className={`menu-player ${on ? "on" : ""}`}
                                    title={`${p.rarityLabel}${
                                      p.level ? ` · level ${p.level}` : ""
                                    }${p.copies > 1 ? ` · ${p.copies} copies` : ""}`}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={on}
                                      onChange={() => toggleChecked(p.key)}
                                    />
                                    {p.name}
                                    <span
                                      className="rarity-chip"
                                      style={{ color: rarityColor(p.rarityLabel) }}
                                    >
                                      {p.rarityLabel}
                                    </span>
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                        )
                      )}
                    </>
                  ) : (
                    <>
                      {collectionErr && (
                        <p className="muted-note">
                          Couldn&apos;t read your own card list ({collectionErr}) — showing the
                          built-in wlkr OTD list instead.
                        </p>
                      )}
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
                                    <label
                                      key={p.key}
                                      className={`menu-player ${on ? "on" : ""}`}
                                    >
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
                    </>
                  )}
                </div>
              </>
            ) : (
              <div className="modal-body">{earningsTab}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
