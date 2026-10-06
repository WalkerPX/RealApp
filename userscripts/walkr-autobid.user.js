// ==UserScript==
// @name         Walkr Autobid
// @namespace    walkr.realapp
// @version      0.5.5
// @description  Bids the buy-now trigger price on Real marketplace listings that clear a rax-per-rating ceiling. Dry-run by default. Hard caps. Kill switch.
// @author       walkr
// @updateURL    https://raw.githubusercontent.com/WalkerPX/RealApp/main/userscripts/walkr-autobid.user.js
// @downloadURL  https://raw.githubusercontent.com/WalkerPX/RealApp/main/userscripts/walkr-autobid.user.js
// @match        *://*.realapp.com/*
// @match        *://realapp.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
  HOW THIS WORKS
  --------------
  Real signs marketplace writes with a Cloudflare Turnstile token minted by the
  page. No server can forge one — so this runs in your browser, on realapp.com,
  and *harvests* the credentials the page itself is already sending:
  real-auth-info, real-session-token, the device headers, and the
  real-turnstile-token header.

  A bid at the listing's buy-now price starts a 10-minute countdown. If nobody
  outbids you in that window, the card is yours. So a "run" is N bids and up to
  N wins — the caps below are what stop that from becoming N × whatever.

  Every listing under the ceiling gets a bid: duplicates, multiple copies of the
  same player, and low rarities included. Nothing is deduped on purpose — the
  goal is as many cheap cards of a target player as the market will sell.

  TWO WAYS IN
  -----------
   1. Walkr's Menu → Autobid → "Bid <sport>". The lineup arrives in the URL hash
      and the panel shows "from Walkr's Menu".
   2. Standalone: pick a Quick Search (same lineups) or set Sport + Players here.

  THE FLOW
  --------
  Run  → scans and prints the plan. Spends nothing unless LIVE is ticked.
  Then, if you like the list, "Bid these" fires exactly that plan — no re-scan.
  A plan older than 5 minutes warns before it bids, because listings turn over.

  THE LOOP (UNATTENDED)
  ---------------------
  "Arm loop" runs the selected Quick Search on a timer — a random wait between
  8 and 11 minutes (both ends editable), off one rax ALLOWANCE (default
  10,000), until the allowance is committed, the cycle cap (72) or the
  wall-clock cap (24 h) is hit, three cycles fail in a row, or STOP is pressed.
  Keep the tab open on realapp.com; timers throttle in background tabs, so a
  cycle can start late, never early.

  The panel shows the allowance as a running BALANCE — "9,760 rax left of
  10,000 · 2 cards bid" — and it drops card by card as the loop bids, with the
  same number appended to every BID OK line in the log.

  The allowance counts rax COMMITTED, not rax spent: a bid reserves its price
  and Real charges only if nobody outbids you in the 10-minute window. So the
  balance can stop the loop early; it can never overshoot it.

  The catch is the Turnstile token: it lives ~5 minutes, and the page only
  mints one when it makes a write of its own. Any loop cadence is therefore
  always carrying a stale token, so the "primer" (on by default) once a cycle
  navigates to the cheapest target, clicks the page's own Buy Now — which mints
  a fresh token AND places that one bid — then fires the rest of the plan on the
  token that click produced. That click is the fragile part: it matches button
  TEXT, so if Real re-labels its buttons the primer reports "no Buy Now button
  found". "Primer report" dumps every clickable element on the page so the two
  patterns can be corrected.

  SAFETY
  ------
    * starts in DRY RUN: Run prints what it would bid and stops
    * three hard caps, enforced in code, not in the UI: rpr / cards / total rax
    * STOP halts immediately, between every single step
    * the loop adds its own hard stops, all in code: allowance, 72 cycles, 24 h,
      three consecutive failed cycles — and STOP clears its stored state, so a
      reload after STOP can't quietly re-arm it
    * a failed bid stops the run — except the two ordinary auction losses: the
      listing vanished, or somebody bid a moment first and the floor moved above
      the price we were going to pay. Those skip, get logged, and the run goes on

  A winning bid is a purchase. It cannot be undone.
*/

(function () {
  "use strict";

  // ── config ────────────────────────────────────────────────────────────────
  /** This script's own caps. A Walkr's Menu handoff can override them via the
   * URL, and a menu built before a cap change would quietly send the old number
   * — so the shipped values are kept here to compare against. */
  const SCRIPT_CAPS = { maxRpr: 11, maxCards: 50, maxSpend: 1000 };

  const DEFAULTS = {
    maxRpr: SCRIPT_CAPS.maxRpr,      // rax per rating point ceiling, per card
    maxCards: SCRIPT_CAPS.maxCards,  // hard ceiling on bids in one run
    maxSpend: SCRIPT_CAPS.maxSpend,  // hard ceiling on total rax in one run
    gapMin: 600,         // jittered politeness floor
    gapMax: 1400,
    live: false,         // DRY RUN until you explicitly arm it
    planTtlMs: 5 * 60 * 1000,  // warn when a cached plan is older than this
  };

  // Current season per sport (DEAL_SEASONS[0] in lib/deals.ts). A listing query
  // needs one; a stale season simply returns nothing.
  const SEASON = {
    mlb: 2026, wnba: 2026, nba: 2026, ncaam: 2026,
    ncaaf: 2026, nfl: 2025, nhl: 2025, soccer: 2026,
  };
  const SPORT_ALIAS = { cfb: "ncaaf", cbb: "ncaam", fc: "soccer" };
  const ALL_SPORTS = ["nhl", "nba", "mlb", "wnba", "nfl", "ncaaf", "ncaam", "soccer"];

  // >>> GENERATED PRESETS
  const PRESETS = [
    {"id":"lowperrax","label":"Low PerRax","sport":"all","cards":9,"slices":[{"sport":"nhl","season":2025,"players":["Jake Guentzel"]},{"sport":"nhl","season":2024,"players":["Brandon Hagel"]},{"sport":"nhl","season":2023,"players":["Jake Guentzel"]},{"sport":"ncaam","season":2026,"players":["Trey Kaufman-Renn","Lamar Wilkerson","Dailyn Swain"]},{"sport":"ncaam","season":2025,"players":["Trey Kaufman-Renn"]},{"sport":"nba","season":2024,"players":["Myles Turner"]},{"sport":"nba","season":2025,"players":["Pascal Siakam"]}]},
    {"id":"budget-nba","label":"Optimal Budget · NBA","sport":"nba","cards":5,"slices":[{"sport":"nba","season":2026,"players":["De'Aaron Fox","James Harden"]},{"sport":"nba","season":2025,"players":["Pascal Siakam"]},{"sport":"nba","season":2024,"players":["Pascal Siakam","Kyrie Irving"]}]},
    {"id":"budget-nhl","label":"Optimal Budget · NHL","sport":"nhl","cards":7,"slices":[{"sport":"nhl","season":2025,"players":["Matt Boldy","Mitch Marner","Jack Eichel"]},{"sport":"nhl","season":2024,"players":["Sam Bennett","Kyle Connor"]},{"sport":"nhl","season":2023,"players":["Stuart Skinner","Filip Forsberg"]}],"playerCaps":{"Jack Eichel":15,"Filip Forsberg":15}},
    {"id":"budget-ncaam","label":"Optimal Budget · CBB","sport":"ncaam","cards":5,"slices":[{"sport":"ncaam","season":2026,"players":["Juke Harris","Chris Bell","Rob Martin"]},{"sport":"ncaam","season":2024,"players":["Al-Amir Dawes","Ben Krikke"]}]},
    {"id":"budget-mlb","label":"Optimal Budget · MLB","sport":"mlb","cards":5,"slices":[{"sport":"mlb","season":2026,"players":["Fernando Tatis Jr.","Kyle Schwarber","CJ Abrams"]},{"sport":"mlb","season":2025,"players":["Vladimir Guerrero Jr."]},{"sport":"mlb","season":2024,"players":["Pete Alonso"]}]},
    {"id":"budget-wnba","label":"Optimal Budget · WNBA","sport":"wnba","cards":5,"slices":[{"sport":"wnba","season":2026,"players":["Kelsey Mitchell","Paige Bueckers"]},{"sport":"wnba","season":2025,"players":["Chelsea Gray","Satou Sabally"]},{"sport":"wnba","season":2024,"players":["Kayla McBride"]}]},
    {"id":"budget-all","label":"Optimal Budget · All Sports","sport":"all","cards":27,"slices":[{"sport":"nba","season":2026,"players":["De'Aaron Fox","James Harden"]},{"sport":"nba","season":2025,"players":["Pascal Siakam"]},{"sport":"nba","season":2024,"players":["Pascal Siakam","Kyrie Irving"]},{"sport":"nhl","season":2025,"players":["Matt Boldy","Mitch Marner","Jack Eichel"]},{"sport":"nhl","season":2024,"players":["Sam Bennett","Kyle Connor"]},{"sport":"nhl","season":2023,"players":["Stuart Skinner","Filip Forsberg"]},{"sport":"ncaam","season":2026,"players":["Juke Harris","Chris Bell","Rob Martin"]},{"sport":"ncaam","season":2024,"players":["Al-Amir Dawes","Ben Krikke"]},{"sport":"mlb","season":2026,"players":["Fernando Tatis Jr.","Kyle Schwarber","CJ Abrams"]},{"sport":"mlb","season":2025,"players":["Vladimir Guerrero Jr."]},{"sport":"mlb","season":2024,"players":["Pete Alonso"]},{"sport":"wnba","season":2026,"players":["Kelsey Mitchell","Paige Bueckers"]},{"sport":"wnba","season":2025,"players":["Chelsea Gray","Satou Sabally"]},{"sport":"wnba","season":2024,"players":["Kayla McBride"]}],"playerCaps":{"Jack Eichel":15,"Filip Forsberg":15}},
    {"id":"max-cbb","label":"Optimal MAX · CBB","sport":"ncaam","cards":7,"maxRpr":21,"slices":[{"sport":"ncaam","season":2026,"players":["Cameron Boozer","Yaxel Lendeborg"]},{"sport":"ncaam","season":2025,"players":["Johni Broome","Cooper Flagg","Mark Sears","Braden Smith"]},{"sport":"ncaam","season":2024,"players":["Zach Edey"]}]},
    {"id":"setup-cbb","label":"Optimal Setup · CBB","sport":"ncaam","cards":8,"maxRpr":21,"slices":[{"sport":"ncaam","season":2026,"players":["Cameron Boozer"]},{"sport":"ncaam","season":2025,"players":["Yaxel Lendeborg","Johni Broome","Cooper Flagg","Eric Dixon","Braden Smith"]},{"sport":"ncaam","season":2024,"players":["Zach Edey","Mark Sears"]}]},
    {"id":"setup-nhl","label":"Optimal Setup · NHL","sport":"nhl","cards":9,"maxRpr":21,"slices":[{"sport":"nhl","season":2025,"players":["Nathan MacKinnon"]},{"sport":"nhl","season":2024,"players":["Leon Draisaitl","Connor Hellebuyck","Sergei Bobrovsky"]},{"sport":"nhl","season":2023,"players":["Connor McDavid","Leon Draisaitl","Igor Shesterkin","Sergei Bobrovsky","Jake Oettinger"]}]},
    {"id":"setup-nba","label":"Optimal Setup · NBA","sport":"nba","cards":5,"maxRpr":21,"slices":[{"sport":"nba","season":2026,"players":["Jalen Brunson"]},{"sport":"nba","season":2025,"players":["Shai Gilgeous-Alexander","Nikola Jokic"]},{"sport":"nba","season":2024,"players":["Luka Doncic","Nikola Jokic"]}]},
    {"id":"setup-wnba","label":"Optimal Setup · WNBA","sport":"wnba","cards":6,"maxRpr":21,"slices":[{"sport":"wnba","season":2026,"players":["A'ja Wilson"]},{"sport":"wnba","season":2025,"players":["A'ja Wilson","Aliyah Boston"]},{"sport":"wnba","season":2024,"players":["Napheesa Collier","A'ja Wilson","Breanna Stewart"]}]},
    {"id":"setup-mlb","label":"Optimal Setup · MLB","sport":"mlb","cards":14,"maxRpr":21,"slices":[{"sport":"mlb","season":2026,"players":["Shohei Ohtani","Cam Schlittler","Cristopher Sanchez","Jacob Misiorowski"]},{"sport":"mlb","season":2025,"players":["Shohei Ohtani","Yoshinobu Yamamoto","Eric Lauer","Kevin Gausman","Tarik Skubal"]},{"sport":"mlb","season":2024,"players":["Shohei Ohtani","Tarik Skubal","Zack Wheeler","Seth Lugo","Logan Gilbert"]}]},
    {"id":"dailypack-all","label":"Daily Pack Buys · All 17","sport":"all","cards":17,"maxRpr":21,"slices":[{"sport":"nhl","season":2023,"players":["Connor McDavid","Leon Draisaitl","Vincent Trocheck"]},{"sport":"nhl","season":2024,"players":["Connor McDavid","Leon Draisaitl","Nathan MacKinnon"]},{"sport":"nhl","season":2025,"players":["Nathan MacKinnon"]},{"sport":"ncaam","season":2025,"players":["Yaxel Lendeborg","Johni Broome","Cooper Flagg","Braden Smith","Mark Sears"]},{"sport":"ncaam","season":2026,"players":["Cameron Boozer","Bennett Stirtz","Keaton Wagler"]},{"sport":"ncaam","season":2024,"players":["Zach Edey"]},{"sport":"wnba","season":2025,"players":["A'ja Wilson"]}]},
  ];
  // <<< GENERATED PRESETS

  // ── hashids (real-request-token = hashids("realwebapp",16).encode(now_ms)) ─
  const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
  const SEPS = "cfhistuCFHISTU";
  const uniq = (a) => { const s = new Set(), o = []; for (const x of a) if (!s.has(x)) { s.add(x); o.push(x); } return o; };
  function shuf(arr, salt) {
    if (!salt.length) return arr.slice();
    const r = arr.slice();
    let o = r.length - 1, i = 0, a = 0;
    while (o > 0) {
      i = i % salt.length;
      const n = salt[i].charCodeAt(0);
      a += n;
      const c = (n + i + a) % o;
      [r[c], r[o]] = [r[o], r[c]];
      o -= 1; i += 1;
    }
    return r;
  }
  function hashNum(e, t) {
    const n = [];
    for (;;) { n.unshift(t[e % t.length]); e = Math.floor(e / t.length); if (e <= 0) break; }
    return n;
  }
  function buildHashids(saltStr, minLength) {
    const salt = [...saltStr];
    let alphabet = uniq([...ALPHABET]);
    let seps = uniq([...SEPS]);
    alphabet = alphabet.filter((c) => !seps.includes(c));
    seps = shuf(seps, salt);
    if (seps.length === 0 || alphabet.length / seps.length > 3.5) {
      const h = Math.floor(alphabet.length / 3.5);
      if (h > seps.length) { const b = h - seps.length; seps = seps.concat(alphabet.slice(0, b)); alphabet = alphabet.slice(b); }
    }
    alphabet = shuf(alphabet, salt);
    let guards;
    const s = Math.floor(alphabet.length / 12);
    if (alphabet.length < 3) { guards = seps.slice(0, s); seps = seps.slice(s); }
    else { guards = alphabet.slice(0, s); alphabet = alphabet.slice(s); }
    return function encode(numbers) {
      const o = numbers.reduce((acc, v, i) => acc + (v % (i + 100)), 0);
      let n = alphabet.slice();
      let result = [n[o % n.length]];
      const a = result.slice();
      for (let l = 0; l < numbers.length; l++) {
        const val = numbers[l];
        n = shuf(n, a.concat(salt, n));
        const f = hashNum(val, n);
        result = result.concat(f);
        if (l + 1 < numbers.length) {
          const p = f[0].charCodeAt(0) + l;
          result.push(seps[(val % p) % seps.length]);
        }
      }
      if (result.length < minLength) {
        const u = (o + result[0].charCodeAt(0)) % guards.length;
        result.unshift(guards[u]);
        if (result.length < minLength) {
          const s2 = (o + result[2].charCodeAt(0)) % guards.length;
          result.push(guards[s2]);
        }
      }
      const f = Math.floor(n.length / 2);
      while (result.length < minLength) {
        n = shuf(n, n);
        result = n.slice(f).concat(result);
        result = result.concat(n.slice(0, f));
        const h = result.length - minLength;
        if (h > 0) { const b = Math.floor(h / 2); result = result.slice(b, b + minLength); }
      }
      return result.join("");
    };
  }
  const reqToken = (ms) => buildHashids("realwebapp", 16)([ms == null ? Date.now() : ms]);
  const listingUrl = (id) => `https://www.realapp.com/${buildHashids("routing", 11)([30, 0, 0, id])}`;

  /** One wrong character in this port makes every request "malformed": Real
   * answers 401 "Malformed request.", which reads exactly like a dead session.
   * That happened once and cost an afternoon. This vector comes from the
   * verified Python port, and the code is checked against it at boot. */
  const SELF_TEST = { ms: 1791059042041, want: "v0Obkvj9AlZ3vQKW" };
  const selfTestOk = reqToken(SELF_TEST.ms) === SELF_TEST.want;

  // ── credential harvester ─────────────────────────────────────────────────
  // We never mint anything. We watch the page's own traffic and keep the newest
  // copy of each header it sends, including the Turnstile token.
  const HARVEST = ["real-auth-info", "real-session-token", "real-device-type",
    "real-device-name", "real-device-uuid", "real-version", "real-turnstile-token"];
  const creds = {};
  const credsAt = {};

  function harvest(headers) {
    if (!headers) return;
    let h = headers;
    if (typeof headers.forEach === "function" && typeof headers.get === "function") {
      const o = {}; headers.forEach((v, k) => { o[k] = v; }); h = o;
    } else if (Array.isArray(headers)) {
      const o = {}; for (const p of headers) o[p[0]] = p[1]; h = o;
    }
    for (const k of HARVEST) {
      for (const hk of Object.keys(h)) {
        if (hk.toLowerCase() === k && h[hk]) { creds[k] = h[hk]; credsAt[k] = Date.now(); }
      }
    }
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      if (typeof input === "string" || input instanceof URL) harvest(init && init.headers);
      else harvest((input && input.headers) || (init && init.headers));
    } catch (_) {}
    return origFetch.apply(this, arguments);
  };
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const oOpen = XHR.prototype.open, oSend = XHR.prototype.send, oSet = XHR.prototype.setRequestHeader;
    XHR.prototype.open = function () { this.__h = {}; return oOpen.apply(this, arguments); };
    XHR.prototype.setRequestHeader = function (k, v) { try { this.__h[k] = v; } catch (_) {} return oSet.apply(this, arguments); };
    XHR.prototype.send = function () { try { harvest(this.__h); } catch (_) {} return oSend.apply(this, arguments); };
  }

  const haveCreds = () => !!(creds["real-auth-info"] && creds["real-turnstile-token"]);

  // ── api ──────────────────────────────────────────────────────────────────
  const BASE = "https://web.realapp.com";

  /** Real's reads carry the device/auth headers but NOT a Turnstile token — its
   * own web app attaches one only to writes. Attaching a stale token to a GET is
   * exactly what earns a 401, so reads go without it and writes go with it. */
  function apiHeaders(withTurnstile) {
    const h = {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      Origin: "https://realapp.com",
      Referer: "https://realapp.com/",
      "real-request-token": reqToken(),
    };
    for (const k of HARVEST) {
      if (k === "real-turnstile-token" && !withTurnstile) continue;
      if (creds[k]) h[k] = creds[k];
    }
    return h;
  }

  async function apiGet(path) {
    const res = await fetch(BASE + path, { headers: apiHeaders(false), cache: "no-store" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`GET ${path.split("?")[0]} -> ${res.status}${body ? `: ${body.slice(0, 140)}` : ""}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /** A 401/403 is a dead session, not a bad player — abort instead of burning
   * the remaining lookups against a credential Real has already rejected. */
  function authFail(e, log) {
    if (e && (e.status === 401 || e.status === 403)) {
      log(`STOP: Real said ${e.status} — this tab's harvested session is stale.`);
      log("Hard-refresh realapp.com (so the page re-sends fresh headers), then run again.");
      S.stop = true;
      return true;
    }
    return false;
  }

  async function apiPost(path, body) {
    const res = await fetch(BASE + path, {
      method: "POST", headers: apiHeaders(true), body: JSON.stringify(body), cache: "no-store",
    });
    const text = await res.text().catch(() => "");
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) {}
    return { status: res.status, ok: res.ok, data, text };
  }

  // ── scanning ─────────────────────────────────────────────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const gap = () => DEFAULTS.gapMin + Math.floor(Math.random() * (DEFAULTS.gapMax - DEFAULTS.gapMin + 1));

  /** Gap between bids. Deliberately not a metronome: a person's cadence drifts,
   * sometimes fires a quick pair, sometimes gets distracted for a few seconds.
   * Weighted so the average stays ~1.6s — quick, but not uniform. Independent of
   * the read `gap()` so a bid burst and a scan burst don't share a rhythm. */
  function bidGap() {
    const r = Math.random();
    if (r < 0.05) return 350 + Math.floor(Math.random() * 300);    // quick pair
    if (r < 0.15) return 2800 + Math.floor(Math.random() * 4200);  // glanced away
    return 700 + Math.floor(Math.random() * 1300);                 // normal
  }
  /** Lowercase alphanumerics, diacritics folded — Real stores "Nikola Jokić" and
   * "Luka Dončić" while the OTD data and the presets write plain ASCII, so a bare
   * strip drops the accented letter (ć) and the exact match silently misses. */
  const nameKey = (s) =>
    String(s)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");

  async function resolvePlayer(sport, name) {
    const d = await apiGet(`/search?query=${encodeURIComponent(name)}&sport=${encodeURIComponent(sport)}`);
    const players = (d.entities || []).filter((e) => e.type === "player");
    const full = (e) => `${(e.entity || {}).firstName || ""} ${(e.entity || {}).lastName || ""}`.trim();
    const want = nameKey(name);
    const exact = players.find((e) => nameKey(full(e)) === want);
    const surname = players.find((e) => nameKey((e.entity || {}).lastName || "") === want);
    const pick = exact || surname || players[0];
    return pick ? ((pick.entity || {}).id ?? pick.id ?? null) : null;
  }

  const listingQuery = (params) => {
    const q = new URLSearchParams({
      sport: params.sport, season: String(params.season),
      rarity: String(params.rarity), listingType: params.listingType, offset: "0",
    });
    if (params.playerId != null) {
      q.set("filterEntityType", "player");
      q.set("filterEntityId", String(params.playerId));
    }
    return `/cardmarketplacelistings?${q}`;
  };

  async function playerListings(sport, season, pid, rarity, ltype) {
    const d = await apiGet(listingQuery({ sport, season, rarity, listingType: ltype, playerId: pid }));
    return d.listings || [];
  }
  /** Whole-market bucket sweep — no player filter. `/cardmarketplacelistings`
   * ignores `offset`, so this only ever sees page one per rarity/type. */
  async function bucketListings(sport, season, rarity, ltype) {
    const d = await apiGet(listingQuery({ sport, season, rarity, listingType: ltype }));
    return d.listings || [];
  }

  const listingPrice = (l) =>
    l.buyNowPrice != null ? Number(l.buyNowPrice)
      : l.currentBidAmount != null ? Number(l.currentBidAmount)
        : l.minBidPrice != null ? Number(l.minBidPrice) : null;

  const listingRating = (l) => {
    const c = l.card || {};
    const n = Number(l.value ?? c.boostValue);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const listingLabel = (l) => {
    const c = l.card || {};
    return c.label || (c.primaryPlayer || {}).displayName || c.entityLabel || `card ${l.id}`;
  };

  const RARITIES = [1, 2, 3, 4, 5, 6, 7];
  const RARITY_LABEL = { 1: "Common", 2: "Uncommon", 3: "Rare", 4: "Epic", 5: "Legendary", 6: "Mystic", 7: "Iconic" };
  /** Real reports ratings as float noise (4.799999999999999) — show 2dp. */
  const fmtR = (n) => (Number.isFinite(n) ? String(Number(n.toFixed(2))) : "—");

  /** Per-player ceilings the active lineup carries. Empty unless a preset — or a
   * Walkr's Menu handoff — names one, so every other search still screens at the
   * script's own ceiling. */
  const NO_CAPS = {};
  function activePlayerCaps() {
    if (hashPlan) {
      if (hashPlan.playerCaps) return hashPlan.playerCaps;
      // A menu built before per-player ceilings existed sends none. If its label
      // still names a preset we have, use that preset's caps — otherwise the
      // loosened players would silently fall back to the script's own ceiling.
      const lbl = String(hashPlan.label || "");
      const match = PRESETS.find((p) => p.label === lbl);
      return (match && match.playerCaps) || NO_CAPS;
    }
    const p = quickEl && PRESETS.find((x) => x.id === quickEl.value);
    return (p && p.playerCaps) || NO_CAPS;
  }

  /** The rax-per-rating ceiling for one player: their own when the lineup names
   * one (the deep-market cards worth a looser price because they level fast),
   * otherwise the run's ceiling. */
  function capFor(name) {
    const c = activePlayerCaps()[name];
    return c == null ? DEFAULTS.maxRpr : Number(c);
  }

  /** One listing → a plan candidate, or nothing. */
  function consider(l, sport, season, label, found) {
    const ends = l.endsAt ? Date.parse(l.endsAt) : NaN;
    if (Number.isFinite(ends) && ends <= Date.now()) return;
    if (!l.canBid) return;
    if (l.buyNowPrice == null) return;   // no trigger price => can't start the clock
    const price = listingPrice(l);
    const rating = listingRating(l);
    if (price == null || price <= 0 || rating == null) return;
    const rpr = price / rating;
    const cap = capFor(label);
    if (rpr > cap) return;
    if (found.some((f) => f.listingId === l.id)) return;
    found.push({
      listingId: l.id, sport, season, player: label, rarity: l.rarity,
      rating, price, rpr: Math.round(rpr * 100) / 100, cap, endsAt: l.endsAt || null,
      url: listingUrl(l.id),
    });
  }

  /** Find every live listing of every target that clears the ceiling. A target
   * with players is scoped to them; one without is a whole-market sweep. */
  async function scan(targets, log) {
    const found = [];
    for (const t of targets) {
      if (S.stop) return found;
      const sport = SPORT_ALIAS[t.sport] || t.sport;
      const season = t.season || SEASON[sport];
      const players = (t.players || []).filter(Boolean);

      if (!players.length) {
        log(`· ${sport} ${season} — whole market`);
        for (const rarity of RARITIES) {
          if (S.stop) return found;
          let ls = [];
          try { ls = await bucketListings(sport, season, rarity, "card"); }
          catch (e) { log(`! bucket ${sport} r${rarity}: ${e.message}`); if (authFail(e, log)) return found; }
          if (ls.length) log(`  ${RARITY_LABEL[rarity]}: ${ls.length} listing(s)`);
          for (const l of ls) consider(l, sport, season, listingLabel(l), found);
          await sleep(gap());
        }
        continue;
      }

      for (const name of players) {
        if (S.stop) return found;
        log(`· ${sport} ${season} — ${name}`);
        let pid = null;
        try { pid = await resolvePlayer(sport, name); }
        catch (e) { log(`! resolve "${name}": ${e.message}`); if (authFail(e, log)) return found; }
        if (pid == null) { log(`! unresolved: ${name}`); await sleep(gap()); continue; }
        for (const rarity of RARITIES) {
          if (S.stop) return found;
          let ls = [];
          try { ls = await playerListings(sport, season, pid, rarity, "card"); }
          catch (e) { log(`! listings ${name} r${rarity}: ${e.message}`); if (authFail(e, log)) return found; }
          if (ls.length) log(`  ${RARITY_LABEL[rarity]}: ${ls.length} listing(s)`);
          for (const l of ls) consider(l, sport, season, name, found);
          await sleep(gap());
        }
      }
    }
    found.sort((a, b) => a.rpr - b.rpr);   // cheapest rax-per-rating first
    return found;
  }

  /** Apply the hard caps, and report which one did the cutting. `spendCap` is
   * the loop's remaining allowance when one is armed — it can only ever be
   * tighter than the per-run spend cap, never looser. */
  function buildPlan(candidates, spendCap) {
    const cap = spendCap == null ? DEFAULTS.maxSpend : Math.min(spendCap, DEFAULTS.maxSpend);
    const plan = [];
    let spend = 0;
    let limitedBy = null;
    for (const c of candidates) {
      if (plan.length >= DEFAULTS.maxCards) { limitedBy = "card cap"; break; }
      if (spend + c.price > cap) {
        limitedBy = limitedBy || (cap < DEFAULTS.maxSpend ? "allowance" : "spend cap");
        continue;
      }
      plan.push(c);
      spend += c.price;
    }
    return { plan, spend, limitedBy };
  }

  // ── the loop: unattended cycles off one rax allowance ────────────────────
  /** A loop runs with nobody watching, so it stops itself: allowance, cycle
   * count, wall clock, consecutive failures, and STOP. Nothing here loosens the
   * per-run rails (maxCards / maxSpend) — it can only ever tighten them. */
  const LOOP_CAPS = {
    maxCycles: 72,            // 24 h at the default interval
    maxHours: 24,
    maxConsecFails: 3,
    minIntervalMin: 5,
    maxIntervalMin: 240,
    defaultIntervalMin: 8,
    defaultIntervalMax: 11,
    defaultAllowance: 10000,
  };

  /** A Turnstile token lives about five minutes AND the page only mints one when
   * it makes a write of its own. Past this age a bid is a guaranteed 401, which
   * is why a 20-minute cadence can't simply re-fire the last token. */
  const TOKEN_FRESH_S = 240;
  const LOOP_KEY = "walkr.autobid.loop.v1";

  /** The priming click — the fragile half, and it matches TEXT only. Real's app
   * is React Native Web: a live report on a card page found ZERO <button>, <a>
   * or [role=button], 503 pointer-cursor <div>s carrying generic css-/r- class
   * names, and exactly one element whose text said "Bid". So the text is the
   * only signal that survives — and because there are hundreds of candidates,
   * the primer tries them best-first and moves on if a click mints no token. */
  const PRIMER = {
    buyNowText: /^(buy ?now|buy|bid)\b/i,
    /** Deliberately WITHOUT "buy now": the primary control matches that, and a
     * confirm step that can re-match it clicks the main button twice. A dialog's
     * own "Buy Now" is still reachable — see clickPrimerButton, which accepts
     * anything that appeared only after the first click. */
    confirmText: /^(confirm|confirm bid|place bid|submit|yes|ok|continue)\b/i,
    /** Tiers, best first: an exact "buy now" beats an exact "bid", and anything
     * else is ranked by shortness so a wrapper can't outrank its own button. */
    exactTiers: ["buy now", "bid", "buy"],
    findWaitMs: 12000,
    settleMs: 6000,
    /** How long a click gets to produce a fresh token before the primer treats
     * it as "that wasn't the bid control" and clicks the next candidate. */
    mintWaitMs: 6000,
    maxCandidates: 3,
    /** Where the primer navigates when the target listing is NOT already on the
     * page. VERIFIED 2026-10-05 against listing 1454281451: the encoded tuple
     * renders realapp.com/VVtaFVFra9A1D, titled "Marketplace Listing 90 Rax |
     * Jalen Brunson NBA Play …". (Cards use a different tuple — [2,7,0,cardId]
     * — so this is the listing route specifically.) */
    route: (listingId) =>
      `https://www.realapp.com/${buildHashids("routing", 11)([30, 0, 0, listingId])}`,
  };

  const LOOP = {
    on: false,
    intervalMin: LOOP_CAPS.defaultIntervalMin,
    /** Cycles are spaced by a random wait in [intervalMin, intervalMax] — a
     * metronome is the easiest thing about a bot to spot, and Real's own
     * pricing moves on a human-ish cadence. */
    intervalMax: LOOP_CAPS.defaultIntervalMax,
    allowance: LOOP_CAPS.defaultAllowance,
    /** The Quick Search the loop was armed on. The primer navigates the page, so
     * the panel reopens with no selection — without this the next cycles would
     * fall back to a whole-market sweep. */
    presetId: "",
    /** Rax reserved by bids the loop has placed. Real only charges winners, so
     * this over-counts on purpose: the allowance can stop early, never overshoot. */
    committed: 0,
    /** Cards the loop has bid on — the count that ticks the balance down. */
    cards: 0,
    cycles: 0,
    consecFails: 0,
    startedAt: 0,
    lastRunAt: 0,
    /** When the next cycle is due (the wait is random, so it can't be derived). */
    nextAt: 0,
    /** "idle" | "prime" — "prime" means a navigation is in flight and the next
     * page load owes a Buy Now click before the rest of the plan may fire. */
    phase: "idle",
    plan: null,
    timer: null,
  };

  function saveLoop() {
    try {
      localStorage.setItem(LOOP_KEY, JSON.stringify({
        on: LOOP.on, intervalMin: LOOP.intervalMin, intervalMax: LOOP.intervalMax,
        live: DEFAULTS.live,
        allowance: LOOP.allowance,
        presetId: LOOP.presetId,
        committed: LOOP.committed, cards: LOOP.cards,
        cycles: LOOP.cycles, consecFails: LOOP.consecFails,
        startedAt: LOOP.startedAt, lastRunAt: LOOP.lastRunAt, nextAt: LOOP.nextAt,
        phase: LOOP.phase, plan: LOOP.plan,
      }));
    } catch (_) {}
  }
  function loadLoop() {
    try {
      const s = JSON.parse(localStorage.getItem(LOOP_KEY) || "null");
      return s && typeof s === "object" ? s : null;
    } catch (_) { return null; }
  }

  const loopRemaining = () => Math.max(0, Number(LOOP.allowance) - Number(LOOP.committed));
  const loopTokenAge = () => (credsAt["real-turnstile-token"]
    ? (Date.now() - credsAt["real-turnstile-token"]) / 1000 : Infinity);
  const tokAgeText = () => {
    const a = loopTokenAge();
    return Number.isFinite(a) ? `${Math.round(a / 60)} min old` : "none seen";
  };

  const fmtRax = (n) => Number(n || 0).toLocaleString("en-US");

  /** The allowance line — the balance first, because that is the number that
   * decides whether the loop keeps going, then what has been bid against it.
   * `committed` is what has been bid (not what Real has taken: only winners are
   * charged), so the balance falls with every card the loop bids on. */
  function loopStatus() {
    const left = loopRemaining();
    const bid = `${fmtRax(LOOP.committed)} rax / ${LOOP.cards} card${LOOP.cards === 1 ? "" : "s"} bid`;
    if (!LOOP.on) {
      return LOOP.committed
        ? `loop: off · ${fmtRax(left)} rax left of ${fmtRax(LOOP.allowance)} · ${bid}`
        : `loop: off · allowance ${fmtRax(LOOP.allowance)} rax`;
    }
    const next = LOOP.nextAt ? LOOP.nextAt - Date.now() : null;
    return `loop: ON · ${fmtRax(left)} rax left of ${fmtRax(LOOP.allowance)} · ${bid} · ` +
      `every ${LOOP.intervalMin}\u2013${LOOP.intervalMax} min · cycle ${LOOP.cycles}/${LOOP_CAPS.maxCycles}` +
      (next != null && next > 0 ? ` · next in ${Math.max(1, Math.ceil(next / 60000))} min` : "") +
      (LOOP.phase === "prime" ? " · priming a token" : "");
  }

  function loopStop(reason) {
    if (LOOP.timer) { clearTimeout(LOOP.timer); LOOP.timer = null; }
    const was = LOOP.on || LOOP.phase !== "idle";
    LOOP.on = false; LOOP.phase = "idle"; LOOP.plan = null;
    saveLoop();
    if (was) logLine(`LOOP STOPPED — ${reason}`);
    render();
  }

  function loopSchedule(delayMs) {
    if (LOOP.timer) { clearTimeout(LOOP.timer); LOOP.timer = null; }
    if (!LOOP.on) { LOOP.nextAt = 0; saveLoop(); return; }
    LOOP.nextAt = Date.now() + delayMs;
    saveLoop();
    LOOP.timer = setTimeout(() => { LOOP.timer = null; loopCycle(); }, delayMs);
    render();
  }

  /** A random wait inside [intervalMin, intervalMax], clamped to the caps. A
   * metronome is the easiest part of a bot to spot, and Real's own listings
   * turn over on a human-ish cadence, so the gap is deliberately irregular. */
  function loopWaitMs() {
    const clamp = (v, lo) => Math.min(LOOP_CAPS.maxIntervalMin, Math.max(lo, Math.round(v)));
    const lo = clamp(Number(LOOP.intervalMin) || LOOP_CAPS.defaultIntervalMin, LOOP_CAPS.minIntervalMin);
    const hi = clamp(Number(LOOP.intervalMax) || LOOP_CAPS.defaultIntervalMax, lo);
    const pick = lo + Math.floor(Math.random() * (hi - lo + 1));
    return pick * 60000;
  }

  /** Why the loop should not take another cycle — checked before every one. */
  function loopBoundHit() {
    if (!LOOP.on) return "disarmed";
    if (S.stop) return "STOP pressed";
    if (loopRemaining() <= 0) return `allowance committed (${LOOP.committed} / ${LOOP.allowance} rax)`;
    if (LOOP.cycles >= LOOP_CAPS.maxCycles) return `${LOOP_CAPS.maxCycles}-cycle cap reached`;
    if (LOOP.startedAt && Date.now() - LOOP.startedAt > LOOP_CAPS.maxHours * 3600e3)
      return `${LOOP_CAPS.maxHours}h wall-clock cap reached`;
    if (LOOP.consecFails >= LOOP_CAPS.maxConsecFails)
      return `${LOOP.consecFails} consecutive failed cycles`;
    return null;
  }

  /** A placed bid reserves its price, win or lose (Real charges only winners),
   * and the balance is debited and repainted as each card lands — so the panel
   * ticks down card by card while a plan is firing. */
  async function executePlanLoop(plan) {
    const r = (await executePlan(plan, logLine, (p) => {
      LOOP.committed += Number(p.price) || 0;
      LOOP.cards += 1;
      saveLoop();
      render();
    })) || { placed: 0, committed: 0, failed: 0 };
    render();
    return r;
  }

  function loopEndCycle(failed) {
    if (failed) LOOP.consecFails++; else LOOP.consecFails = 0;
    saveLoop();
    const why = loopBoundHit();
    if (why && why !== "disarmed") { loopStop(why); return; }
    const wait = loopWaitMs();
    logLine(`next cycle in ${Math.round(wait / 60000)} min (${new Date(Date.now() + wait).toISOString().slice(11, 16)} UTC).`);
    loopSchedule(wait);
  }

  async function loopCycle() {
    const why = loopBoundHit();
    if (why) { if (why !== "disarmed") loopStop(why); return; }
    if (S.running) {
      logLine("loop: a run is already in progress — checking again in a minute.");
      loopSchedule(60000);
      return;
    }

    LOOP.cycles++;
    LOOP.lastRunAt = Date.now();
    saveLoop();
    logLine(`—— LOOP cycle ${LOOP.cycles}/${LOOP_CAPS.maxCycles} · ${fmtRax(loopRemaining())} rax left of ` +
      `${fmtRax(LOOP.allowance)}${LOOP.cards ? ` · ${LOOP.cards} card(s) bid so far` : ""} ——`);
    render();

    if (!haveCreds()) {
      const t0 = Date.now();
      while (!creds["real-auth-info"] && Date.now() - t0 < 15000 && !S.stop) await sleep(400);
    }
    if (!creds["real-auth-info"]) {
      logLine("loop: no real-auth-info harvested — is the app loaded and logged in?");
      loopEndCycle(true);
      return;
    }

    const targets = currentTargets();
    if (!targets.length) {
      logLine("loop: nothing to search — pick a Quick Search.");
      loopEndCycle(true);
      return;
    }
    DEFAULTS.maxRpr = effectiveMaxRpr();

    const label = currentLabel();
    const pcaps = activePlayerCaps();
    const pcNote = Object.keys(pcaps).length
      ? ` · ${Object.entries(pcaps).map(([n, c]) => `${n} ${c}`).join(", ")}` : "";
    logLine(`loop plan${label ? ` (${label})` : ""}: ${targets.length} group(s) · cap ${DEFAULTS.maxRpr} rpr${pcNote} · ` +
      `≤${DEFAULTS.maxCards} cards / ≤${DEFAULTS.maxSpend} rax a run · allowance ${fmtRax(loopRemaining())} rax`);

    let plan = [], spend = 0, limitedBy = null;
    S.running = true;
    render();
    try {
      const candidates = await scan(targets, logLine);
      if (S.stop) { S.running = false; loopStop("STOP pressed"); return; }
      logLine(`found ${candidates.length} qualifying listing(s)`);
      ({ plan, spend, limitedBy } = buildPlan(candidates, loopRemaining()));
      if (plan.length) {
        logLine(`PLAN: ${plan.length} bid(s), ${spend} rax${limitedBy ? ` (cut by ${limitedBy})` : ""}`);
        for (const p of plan) {
          logLine(`   ${p.player}  ${RARITY_LABEL[p.rarity]}  ${p.price} rax @ rating ${fmtR(p.rating)}  (${fmtR(p.rpr)} rpr)  #${p.listingId}`);
        }
        S.lastPlan = plan; S.lastSpend = spend; S.lastAt = Date.now(); S.lastLabel = label;
      } else {
        logLine(candidates.length
          ? `${candidates.length} listing(s) qualified but none fit what's left (${fmtRax(loopRemaining())} rax left, ` +
            `≤${DEFAULTS.maxSpend} a run${limitedBy ? `, cut by ${limitedBy}` : ""}).`
          : "nothing qualified this cycle.");
        S.lastPlan = null;
      }
    } catch (e) {
      logLine(`loop scan ERROR: ${e.message}`);
    } finally {
      S.running = false;
      lastBtn();
      render();
    }

    if (S.stop) { loopStop("STOP pressed"); return; }
    if (!plan.length) { loopEndCycle(false); return; }

    if (!DEFAULTS.live) {
      logLine("DRY RUN — the loop found these and bid nothing. Tick LIVE to let it spend.");
      loopEndCycle(false);
      return;
    }

    if (loopTokenAge() <= TOKEN_FRESH_S) {
      const r = await executePlanLoop(plan);
      loopEndCycle(!!r.failed);
      return;
    }

    if (primerEl && primerEl.checked) {
      const card = plan[0];
      // Best case: the target listing is on this page already, so its own Buy
      // Now can mint the token in place — no navigation, no guessed route.
      const inPlace = findListingBuyNow(card.listingId);
      if (inPlace) {
        logLine(`primer: Turnstile token is ${tokAgeText()}, but #${card.listingId} is on this page — ` +
          "taking a fresh one from its own Buy Now, in place.");
        const tokBefore = credsAt["real-turnstile-token"] || 0;
        let minted = (await clickPrimerButton(inPlace)) && (await waitForToken(tokBefore, PRIMER.mintWaitMs));
        if (!minted) {
          logLine(`primer: "${elText(inPlace)}" produced no token — widening to a page-wide search.`);
          minted = (await primeByClicking(null, inPlace)).minted;
        }
        await primerTail(plan, card, minted);
        return;
      }
      // Otherwise navigate: the listing page's own Buy Now does the minting, and
      // the next page load picks the cycle back up (loopResumePrime).
      LOOP.phase = "prime";
      LOOP.plan = plan;
      saveLoop();
      logLine(`primer: Turnstile token is ${tokAgeText()} and #${card.listingId} (${card.player}) isn't on ` +
        `this page — navigating to ${PRIMER.route(card.listingId)} to mint one from the page's own Buy Now…`);
      location.href = PRIMER.route(card.listingId);
      return;
    }

    logLine(`no fresh Turnstile token (${tokAgeText()}) and the primer is off — skipping the bids this cycle. ` +
      "Reload realapp.com once (or tick the primer) to refresh it.");
    loopEndCycle(false);
  }

  const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  /** The panel is part of the page it is searching — a primer click must never
   * land on its own UI. ("Bid these 1 (90 rax)" is one unlucky regex away from
   * being taken for Real's Buy Now.) */
  const inPanel = (el) => !!(panel && panel.contains(el));

  /** Anything plausibly clickable: real controls, ARIA buttons, and — the case
   * the listing page actually uses — plain elements styled as buttons (cursor:
   * pointer / tabindex) with no role at all. Verified live: the listing page
   * renders ZERO <button>/<a>/[role=button] outside this panel. */
  function clickCandidates(root) {
    // Every element, not a tag whitelist: the listing page's controls have no
    // role and no tag we could have guessed. Runs once or twice a cycle, so the
    // full scan is affordable.
    const all = root ? [...root.querySelectorAll("*")] : [...document.querySelectorAll("*")];
    const out = [];
    for (const el of all) {
      if (!isVisible(el) || el.disabled || inPanel(el)) continue;
      if (el.tagName === "BUTTON" || el.tagName === "A" || el.tagName === "INPUT") { out.push(el); continue; }
      if (el.getAttribute("role") === "button" || el.hasAttribute("tabindex") || el.hasAttribute("onclick")) { out.push(el); continue; }
      let cs = null;
      try { cs = getComputedStyle(el); } catch (_) {}
      if (cs && cs.cursor === "pointer") out.push(el);
    }
    return out;
  }

  /** The best match: an exact-text hit first, then the shortest one — shortest,
   * because a wrapper's text also contains the button's, and clicking the
   * wrapper instead of the button is what makes a blind primer feel flaky. */
  function findClickable(re, root, exact, exclude) {
    const want = (exact || "").toLowerCase();
    const norm = (el) => (el.textContent || "").trim().replace(/\s+/g, " ");
    const hits = clickCandidates(root).filter((el) => {
      if (exclude && exclude(el)) return false;
      const t = norm(el);
      return t && t.length <= 32 && re.test(t);
    });
    hits.sort((a, b) => {
      const ea = norm(a).toLowerCase() === want ? 0 : 1;
      const eb = norm(b).toLowerCase() === want ? 0 : 1;
      return ea - eb || norm(a).length - norm(b).length;
    });
    return hits[0] || null;
  }

  /** If the page already shows this listing, its own Buy Now is right there —
   * far more reliable than navigating to a guessed route. Walks up from any
   * element that carries the listing id (href / data-* / id) and looks for a
   * Buy Now within the same card, a few levels up. */
  function findListingBuyNow(listingId) {
    const needle = String(listingId);
    const carriers = [...document.querySelectorAll("[href],[data-id],[data-listing-id],[data-listing],[id]")];
    for (const c of carriers) {
      const hay = `${c.getAttribute("href") || ""} ${c.getAttribute("data-id") || ""} ` +
        `${c.getAttribute("data-listing-id") || ""} ${c.getAttribute("data-listing") || ""} ${c.getAttribute("id") || ""}`;
      if (!hay.includes(needle)) continue;
      let box = c;
      for (let i = 0; i < 5 && box; i++, box = box.parentElement) {
        const b = primerCandidates(box, 1)[0];
        if (b) return b;
      }
    }
    return null;
  }

  /** One line describing an element, for the report. */
  function describeEl(el) {
    const cls = typeof el.className === "string" && el.className.trim()
      ? ` .${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
    const attrs = ["aria-label", "data-testid", "data-cy", "title", "href", "tabindex", "role"]
      .map((a) => (el.getAttribute(a) ? ` ${a}="${String(el.getAttribute(a)).slice(0, 28)}"` : ""))
      .join("");
    const own = [...el.childNodes].filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim()).join(" ").replace(/\s+/g, " ").slice(0, 40);
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 44);
    let cursor = "";
    try { cursor = getComputedStyle(el).cursor === "pointer" ? " pointer" : ""; } catch (_) {}
    return `   <${el.tagName.toLowerCase()}${cls}${attrs}>${cursor ? " [pointer]" : ""} own="${own}" text="${text}"`;
  }

  /** Blind part of the primer: dump what is actually clickable here, so the two
   * text patterns can be corrected against the real page. Three passes, because
   * the listing page turns out to use none of the obvious markup — no <button>,
   * no <a>, no role=button. The panel's own controls are always excluded. */
  function primerReport() {
    const all = [...document.querySelectorAll("button,[role='button'],a,input,div,span,p,li,label")].filter(isVisible);
    const mine = all.filter(inPanel).length;
    const page = all.filter((el) => !inPanel(el));
    logLine(`primer report — ${location.pathname}: ${page.length} visible element(s) outside this panel` +
      (mine ? ` (${mine} of this panel's ignored)` : "") + ".");

    const controls = page.filter((el) => ["BUTTON", "A", "INPUT"].includes(el.tagName) ||
      el.getAttribute("role") === "button");
    logLine(`   — ${controls.length} real control(s) —`);
    for (const el of controls.slice(0, 12)) logLine(describeEl(el));

    let pointer = [];
    try {
      pointer = page.filter((el) => getComputedStyle(el).cursor === "pointer" && !el.querySelector("*"));
    } catch (_) {}
    logLine(`   — ${pointer.length} leaf element(s) with a pointer cursor —`);
    for (const el of pointer.slice(0, 20)) logLine(describeEl(el));

    const words = page.filter((el) => el.children.length === 0 && /buy|bid|offer|purchase|rax/i.test(el.textContent || ""));
    logLine(`   — ${words.length} leaf element(s) mentioning buy/bid/offer/rax —`);
    for (const el of words.slice(0, 20)) logLine(describeEl(el));
    render();
  }

  /** Every plausible bid control on the page (or inside `root`), best first:
   * an exact "buy now" outranks an exact "bid", which outranks an exact "buy",
   * and anything else is ranked by how short its text is so that a wrapper can
   * never outrank the element it wraps. */
  function primerCandidates(root, limit) {
    const norm = (el) => (el.textContent || "").trim().replace(/\s+/g, " ");
    const hits = clickCandidates(root).filter((el) => {
      const t = norm(el);
      return t && t.length <= 32 && PRIMER.buyNowText.test(t);
    });
    const rank = (el) => {
      const tier = PRIMER.exactTiers.indexOf(norm(el).toLowerCase());
      return tier >= 0 ? tier : PRIMER.exactTiers.length + norm(el).length;
    };
    hits.sort((a, b) => rank(a) - rank(b) || norm(a).length - norm(b).length);
    return hits.slice(0, limit == null ? PRIMER.maxCandidates : limit);
  }

  /** Click candidates in order until one makes the page write something — that
   * write is what mints the Turnstile token the rest of the plan bids on, so a
   * click that produces no token simply means "not the bid control" and the
   * primer moves on. With hundreds of generic divs on the page this is what
   * makes a blind primer survive an ambiguous label instead of dying on it. */
  async function primeByClicking(root, skip) {
    const cands = primerCandidates(root).filter((el) => el !== skip);
    if (!cands.length) return { ok: false, minted: false, el: null };
    for (let i = 0; i < cands.length; i++) {
      const el = cands[i];
      const before = credsAt["real-turnstile-token"] || 0;
      if (!(await clickPrimerButton(el))) continue;
      if (await waitForToken(before, PRIMER.mintWaitMs)) return { ok: true, minted: true, el };
      if (i < cands.length - 1) {
        logLine(`primer: "${elText(el)}" produced no token — that wasn't the bid control, trying the next candidate.`);
      }
    }
    return { ok: true, minted: false, el: cands[0] };
  }

  /** Wait for the page to render a candidate, then work through them. */
  async function runPrimer(root) {
    logLine("primer: looking for the page's own bid control…");
    const t0 = Date.now();
    while (Date.now() - t0 < PRIMER.findWaitMs && !S.stop) {
      if (primerCandidates(root).length) break;
      await sleep(500);
    }
    return primeByClicking(root);
  }

  const elText = (el) => (el.textContent || el.value || "").trim().replace(/\s+/g, " ").slice(0, 32);

  /** Everything clickable whose text matches — used to snapshot what was on the
   * page BEFORE a click, so a confirm step can tell a new dialog from the button
   * that was already sitting there. */
  function matchingControls(re) {
    const norm = (el) => (el.textContent || "").trim().replace(/\s+/g, " ");
    return clickCandidates(null).filter((el) => {
      const t = norm(el);
      return t && t.length <= 32 && re.test(t);
    });
  }

  /** Click the button, then whatever confirmation follows it. The confirm search
   * ignores both the element just clicked and anything that was already on the
   * page beforehand — otherwise the primary control (which matches "Buy Now"
   * too) gets clicked a second time. */
  async function clickPrimerButton(el) {
    logLine(`primer: clicking "${elText(el)}"`);
    const preExisting = new Set(matchingControls(PRIMER.confirmText));
    try { el.click(); } catch (e) { logLine(`primer: the click threw — ${e.message}`); return false; }
    await sleep(1800);
    const c = findClickable(PRIMER.confirmText, null, "confirm",
      (x) => x === el || preExisting.has(x));
    if (c) {
      logLine(`primer: confirming via "${elText(c)}"`);
      try { c.click(); } catch (_) {}
    }
    await sleep(PRIMER.settleMs);
    return true;
  }

  /** The page's own POST is what refreshes the harvested Turnstile token. */
  async function waitForToken(before, ms) {
    const limit = ms == null ? 12000 : ms;
    const t0 = Date.now();
    while ((credsAt["real-turnstile-token"] || 0) <= before && Date.now() - t0 < limit && !S.stop) {
      await sleep(400);
    }
    return (credsAt["real-turnstile-token"] || 0) > before;
  }

  /** Shared tail of both primer paths — in place, or after the navigation: book
   * the bid the primer placed, then fire the rest of the plan on the token that
   * click minted. */
  async function primerTail(plan, card, minted) {
    if (minted) {
      LOOP.committed += Number(card.price) || 0;
      LOOP.cards += 1;
      saveLoop();
      logLine(`primer: the page placed #${card.listingId} (${card.player}, ${card.price} rax) and minted a fresh token ` +
        `— ${fmtRax(loopRemaining())} rax left of the allowance.`);
    } else {
      logLine("primer: clicked, but no fresh token appeared — either Real refused it or that wasn't the bid " +
        "button. Firing the rest anyway; expect 401s if the token didn't refresh.");
    }
    render();
    // After a navigation the harvested headers may not have arrived yet — bids
    // sent without real-auth-info are an instant 401.
    if (!haveCreds()) {
      const w0 = Date.now();
      while (!creds["real-auth-info"] && Date.now() - w0 < 15000 && !S.stop) await sleep(400);
    }
    if (!creds["real-auth-info"]) {
      logLine("primer: no auth headers harvested — skipping the rest of this cycle.");
      loopEndCycle(true);
      return;
    }
    const rest = plan.slice(1);
    if (!rest.length) { loopEndCycle(false); return; }
    const r = await executePlanLoop(rest);
    loopEndCycle(!!r.failed);
  }

  /** The page load that follows a priming navigation: click, then bid the rest. */
  async function loopResumePrime() {
    const plan = LOOP.plan || [];
    const card = plan[0];
    LOOP.phase = "idle";
    saveLoop();
    logLine(`—— loop resumed after priming (${plan.length} card(s) in the cycle) ——`);
    render();
    if (!card) { loopEndCycle(false); return; }
    if (!DEFAULTS.live) {
      logLine("DRY RUN — this cycle would have primed and bid; nothing done.");
      loopEndCycle(false);
      return;
    }

    const r = await runPrimer(null);
    if (!r.ok) {
      logLine('primer: no bid control found on this page — run "Primer report" and send me the list. No bids this cycle.');
      loopEndCycle(true);
      return;
    }
    await primerTail(plan, card, r.minted);
  }

  function loopArm() {
    if (LOOP.on) { loopStop("disarmed by hand"); return; }
    if (!quickEl.value) {
      logLine("loop: pick a Quick Search first — a loop needs a fixed lineup, not a whole-market sweep.");
      return;
    }
    if (S.running) { logLine("loop: a run is already in progress — wait for it to finish."); return; }
    if (!DEFAULTS.live) logLine("loop: LIVE is off, so every cycle is a dry run for now.");
    if (loopRemaining() <= 0) {
      logLine("loop: the allowance is already committed — hit Reset allowance first.");
      return;
    }
    LOOP.on = true;
    LOOP.cycles = 0;
    LOOP.consecFails = 0;
    LOOP.startedAt = Date.now();
    LOOP.lastRunAt = Date.now();
    LOOP.nextAt = 0;
    LOOP.presetId = quickEl.value;
    LOOP.phase = "idle";
    LOOP.plan = null;
    S.stop = false;
    saveLoop();
    logLine(`loop armed — ${quickEl.value} · ${fmtRax(loopRemaining())} rax allowance · a random ` +
      `${LOOP.intervalMin}\u2013${LOOP.intervalMax} min wait between cycles · ≤${DEFAULTS.maxCards} cards / ≤${DEFAULTS.maxSpend} rax a run · ` +
      `hard stop at ${LOOP_CAPS.maxCycles} cycles / ${LOOP_CAPS.maxHours}h / ${LOOP_CAPS.maxConsecFails} failed cycles.`);
    loopCycle();
  }

  /** Re-arm after a reload — the primer navigates on purpose, so the loop has to
   * survive its own page load. */
  function resumeLoop() {
    const st = loadLoop();
    if (!st) return;
    // The primer navigates on purpose, so a live loop has to come back live.
    // Without this, every priming cycle reloads the page, `live` falls back to
    // its built-in false, and the cycle dies as a dry run. That is exactly the
    // bug report: the first cycle bid fine (no navigation), then every cycle
    // that needed a fresh token announced "DRY RUN ... nothing done" forever.
    // Only re-armed when the saved state says a loop was actually running.
    if (st.live && (st.on || st.phase === "prime")) DEFAULTS.live = true;
    LOOP.intervalMin = Math.min(LOOP_CAPS.maxIntervalMin,
      Math.max(LOOP_CAPS.minIntervalMin, Number(st.intervalMin) || LOOP_CAPS.defaultIntervalMin));
    LOOP.intervalMax = Math.max(LOOP.intervalMin,
      Math.min(LOOP_CAPS.maxIntervalMin, Number(st.intervalMax) || LOOP_CAPS.defaultIntervalMax));
    LOOP.allowance = Number(st.allowance) || LOOP_CAPS.defaultAllowance;
    LOOP.committed = Number(st.committed) || 0;
    LOOP.cards = Number(st.cards) || 0;
    LOOP.cycles = Number(st.cycles) || 0;
    LOOP.consecFails = Number(st.consecFails) || 0;
    LOOP.startedAt = Number(st.startedAt) || 0;
    LOOP.lastRunAt = Number(st.lastRunAt) || 0;
    LOOP.nextAt = Number(st.nextAt) || 0;
    LOOP.plan = st.plan || null;
    // Restore the Quick Search the loop was armed on. A reload — including the
    // one the primer causes — otherwise leaves the panel unselected, and the
    // next cycle would sweep the whole market instead of the lineup.
    LOOP.presetId = String(st.presetId || "");
    if (LOOP.presetId && quickEl) {
      const p = PRESETS.find((x) => x.id === LOOP.presetId);
      if (p) {
        quickEl.value = p.id;
        sportEl.value = p.sport;
        playersEl.value = "";
        playersEl.disabled = true;
      } else {
        LOOP.on = false;
        saveLoop();
        logLine(`loop: the preset it was armed on (${LOOP.presetId}) is gone from this build — loop left off.`);
        return;
      }
    }

    if (st.phase === "prime" && LOOP.plan) {
      LOOP.on = true;
      LOOP.phase = "prime";
      logLine(`loop: resuming a priming cycle (${LOOP.plan.length} card(s), ${loopRemaining()} rax allowance left).`);
      loopResumePrime();
      return;
    }
    if (!st.on) return;
    LOOP.on = true;
    const due = LOOP.nextAt || (LOOP.lastRunAt + loopWaitMs());
    const wait = Math.max(3000, due - Date.now());
    logLine(`loop: armed and resuming — next cycle in ${Math.max(1, Math.round(wait / 60000))} min · ` +
      `${fmtRax(loopRemaining())} rax left of ${fmtRax(LOOP.allowance)} · ${LOOP.cards} card(s) bid · ` +
      `cycle ${LOOP.cycles}/${LOOP_CAPS.maxCycles}.`);
    loopSchedule(wait);
  }

  // ── state ────────────────────────────────────────────────────────────────
  const S = {
    stop: false, running: false, log: [], bids: [],
    lastPlan: null, lastSpend: 0, lastAt: 0, lastLabel: "",
  };

  function logLine(s) {
    S.log.push(`${new Date().toISOString().slice(11, 19)}  ${s}`);
    if (S.log.length > 500) S.log.shift();
    render();
  }

  /** Outcomes that are NOT failures: the listing died between scan and bid, or
   * someone bid a moment before us and the floor moved out from under the price
   * we were going to pay. Both are ordinary on a live auction — skip that card
   * and keep going rather than aborting the whole run. */
  function skippable(r) {
    if (r.status === 404 || r.status === 409 || r.status === 410) return true;
    const t = `${r.text || ""} ${JSON.stringify(r.data || {})}`.toLowerCase();
    return /(no longer|not found|has ended|ended|sold|unavailable|expired|closed|removed|minimum bid|min bid|minimum price|must be at least|too low|too small|higher than|outbid|already|cannot bid|can not bid|not enough|insufficient)/.test(t);
  }

  /** Whatever Real said, in one line, for the log. */
  const respMsg = (r) => {
    const d = r.data || {};
    return String(d.message || d.error || (r.text || "").trim() || `HTTP ${r.status}`).slice(0, 120);
  };

  /** `onPlaced` fires per successful bid — the loop uses it to debit its
   * allowance (and repaint the balance) card by card, not run by run. */
  async function executePlan(plan, log, onPlaced) {
    const ages = Date.now() - S.lastAt;
    if (S.lastAt && ages > DEFAULTS.planTtlMs) {
      log(`note: this plan is ${Math.round(ages / 60000)} min old — listings turn over, expect skips`);
    }
    const tokAge = credsAt["real-turnstile-token"]
      ? (Date.now() - credsAt["real-turnstile-token"]) / 1000 : Infinity;
    if (tokAge > 240) {
      log(`WARNING: the Turnstile token is ${Math.round(tokAge / 60)} min old and lives about 5 — refresh realapp.com first, or Real will reject the bids.`);
    }
    let placed = 0, committed = 0, skipped = 0, failed = 0;
    log(`LIVE — bidding ${plan.length} · ~1.6s apart with the odd longer pause`);
    await sleep(700 + Math.floor(Math.random() * 1200));   // a beat before the first bid
    for (const p of plan) {
      if (S.stop) { log("STOPPED mid-run."); break; }
      const r = await apiPost(`/cardmarketplacelistings/${p.listingId}/bid`, { bidAmount: p.price });
      const ok = r.ok && r.data && r.data.success;
      if (ok) {
        placed++;
        committed += p.price;
        const li = (r.data && r.data.listingInfo) || {};
        if (onPlaced) onPlaced(p);
        log(`BID OK #${p.listingId} ${p.player} @ ${p.price} rax · top=${li.isTopBidder} · bids=${li.numBids}` +
          (LOOP.on ? ` · ${fmtRax(loopRemaining())} rax left of the allowance` : ""));
      } else if (skippable(r)) {
        skipped++;
        log(`skip #${p.listingId} ${p.player} — ${respMsg(r)}`);
      } else {
        failed++;
        log(`FAIL #${p.listingId} (${p.player}) -> ${r.status} ${(r.text || "").slice(0, 140)}`);
        log("stopping on first real failure — nothing further bid.");
        break;
      }
      S.bids.push({ ...p, ok, status: r.status });
      await sleep(bidGap());
    }
    log(`— ${placed} bid(s) placed | ${committed} rax committed | ${skipped} skipped | each card lands only if nobody outbids it in 10 min —`);
    return { placed, committed, skipped, failed };
  }

  async function run() {
    S.stop = false; S.running = true; S.log = []; S.bids = [];
    render();
    try {
      if (!haveCreds()) {
        logLine("waiting for the page's own headers (load the app fully)…");
        const t0 = Date.now();
        while (!haveCreds() && Date.now() - t0 < 15000 && !S.stop) await sleep(400);
      }
      if (!creds["real-auth-info"]) { logLine("STOP: no real-auth-info harvested — is the app loaded and logged in?"); return; }
      if (!creds["real-turnstile-token"]) { logLine("STOP: no turnstile token seen yet. Open the marketplace once, then re-run."); return; }

      const targets = currentTargets();
      DEFAULTS.maxRpr = effectiveMaxRpr();
      if (!targets.length) { logLine("STOP: nothing to search — pick a Quick Search or type players."); return; }
      const label = currentLabel();
      const pcaps = activePlayerCaps();
      const pcNote = Object.keys(pcaps).length
        ? ` · ${Object.entries(pcaps).map(([n, c]) => `${n} ${c}`).join(", ")}`
        : "";
      logLine(
        `plan${label ? ` (${label})` : ""}: ${targets.length} target group(s) · cap ${DEFAULTS.maxRpr} rpr${pcNote} · ≤${DEFAULTS.maxCards} cards · ≤${DEFAULTS.maxSpend} rax` +
        (hashPlan ? " · caps from Walkr's Menu" : " · caps from the panel") +
        (excluded.size ? ` · ${excluded.size} player(s) dropped from this run` : "")
      );
      // A menu built before a cap change hands over the old numbers, which reads
      // as "the cap didn't update". Say so instead of letting it look like a bug.
      if (hashPlan) {
        const drift = [];
        if (hashPlan.maxCards != null && Number(hashPlan.maxCards) !== SCRIPT_CAPS.maxCards)
          drift.push(`cards ${hashPlan.maxCards} vs ${SCRIPT_CAPS.maxCards}`);
        if (hashPlan.maxSpend != null && Number(hashPlan.maxSpend) !== SCRIPT_CAPS.maxSpend)
          drift.push(`spend ${hashPlan.maxSpend} vs ${SCRIPT_CAPS.maxSpend}`);
        if (hashPlan.maxRpr != null && Number(hashPlan.maxRpr) !== SCRIPT_CAPS.maxRpr &&
            !PRESET_CEILINGS.has(Number(hashPlan.maxRpr)))
          drift.push(`rpr ${hashPlan.maxRpr} vs ${SCRIPT_CAPS.maxRpr}`);
        if (drift.length)
          logLine(`note: Walkr's Menu sent different caps (${drift.join(", ")}) — that page is an older build. Hard-refresh the site and relaunch.`);
      }

      const candidates = await scan(targets, logLine);
      if (S.stop) { logLine("stopped."); return; }
      logLine(`found ${candidates.length} qualifying listing(s)`);

      const { plan, spend, limitedBy } = buildPlan(candidates);
      if (!plan.length) { logLine("nothing qualified — done."); S.lastPlan = null; lastBtn(); return; }

      logLine(`PLAN: ${plan.length} bid(s), ${spend} rax total`);
      for (const p of plan) logLine(`   ${p.player}  ${RARITY_LABEL[p.rarity]}  ${p.price} rax @ rating ${fmtR(p.rating)}  (${fmtR(p.rpr)} rpr${p.cap != null && p.cap !== DEFAULTS.maxRpr ? `, cap ${p.cap}` : ""})  #${p.listingId}`);
      const capped = candidates.length > plan.length;
      logLine(capped
        ? `— ${candidates.length} cards found | ${plan.length} in plan · ${limitedBy || "the caps"} cut it (limit ≤${DEFAULTS.maxCards} cards / ≤${DEFAULTS.maxSpend} rax) | ${spend} rax —`
        : `— ${plan.length} cards found | ${spend} rax total —`);

      // Cache it so it can be fired later without paying for a second scan.
      S.lastPlan = plan; S.lastSpend = spend; S.lastAt = Date.now(); S.lastLabel = label;
      lastBtn();

      if (!DEFAULTS.live) {
        logLine('DRY RUN — nothing bid. Tick LIVE and Run again, or hit "Bid these" to fire this exact list.');
        return;
      }
      await executePlan(plan, logLine);
    } catch (e) {
      logLine(`ERROR: ${e.message}`);
    } finally {
      S.running = false;
      render();
      lastBtn();
    }
  }

  /** Fire the cached plan — the dry-run results, exactly as listed. */
  async function bidCached() {
    if (S.running || !S.lastPlan) return;
    S.stop = false; S.running = true; S.bids = [];
    logLine(`bidding the cached plan (${S.lastPlan.length} card(s), ${S.lastSpend} rax)…`);
    render();
    try {
      if (!haveCreds()) { logLine("STOP: page credentials not harvested yet."); return; }
      await executePlan(S.lastPlan, logLine);
    } catch (e) {
      logLine(`ERROR: ${e.message}`);
    } finally {
      S.running = false;
      render();
      lastBtn();
    }
  }

  // ── targets ──────────────────────────────────────────────────────────────
  // Priority: a plan handed over by Walkr's Menu (URL hash) > Quick Search > fields.
  let hashPlan = null;
  try {
    const m = /[#&]walkr=([^&]+)/.exec(location.hash);
    if (m) {
      let b = m[1].replace(/-/g, "+").replace(/_/g, "/");
      while (b.length % 4) b += "=";
      const bytes = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
      hashPlan = JSON.parse(new TextDecoder().decode(bytes));
    }
  } catch (_) { hashPlan = null; }

  function currentLabel() {
    if (hashPlan) return hashPlan.label || "Walkr's Menu";
    const p = PRESETS.find((x) => x.id === (quickEl && quickEl.value));
    if (p) return p.label;
    return "";
  }

  /** The rpr ceiling for THIS run, in priority order: a Walkr's Menu handoff,
   * then a preset that declares its own (the Daily Pack Buys presets screen at
   * 21 — the pack's own price is 20), then the script's shipped cap. Presets
   * other than those fall back to SCRIPT_CAPS, so picking one after another
   * can't leave a loosened ceiling behind. */
  function effectiveMaxRpr() {
    if (hashPlan && hashPlan.maxRpr != null) return Number(hashPlan.maxRpr);
    const p = quickEl && PRESETS.find((x) => x.id === quickEl.value);
    if (p && p.maxRpr != null) return Number(p.maxRpr);
    return SCRIPT_CAPS.maxRpr;
  }

  /** Ceilings some preset ships with on purpose — a handoff quoting one of these
   * isn't a stale menu, so it shouldn't trip the drift note. Per-player ceilings
   * count too: 15 is a deliberate looseness, not a stale 11. */
  const PRESET_CEILINGS = new Set([
    ...PRESETS.filter((p) => p.maxRpr != null).map((p) => Number(p.maxRpr)),
    ...PRESETS.flatMap((p) => Object.values(p.playerCaps || {}).map(Number)),
  ]);

  // ── per-run player exclusions (the chip row under "Players") ─────────────
  /** Players dropped from THIS run only, keyed `sport|season|player`. Cleared
   * every time a Quick Search is picked, so an × is a one-run decision and never
   * edits the preset — same as clicking a player off in Walkr's Menu. */
  let excluded = new Set();
  const playerKey = (sport, season, name) => `${sport}|${season}|${name}`;

  const SPORT_LABEL = {
    mlb: "MLB", wnba: "WNBA", nba: "NBA", ncaaf: "CFB",
    ncaam: "CBB", nfl: "NFL", nhl: "NHL", soccer: "FC",
  };

  /** Same season wording the site uses (lib/deals.ts seasonLabel). */
  function seasonLabel(sport, season) {
    if (sport === "mlb" || sport === "wnba") return String(season);
    if (sport === "ncaam" || sport === "nba") return `${season - 1}-${String(season).slice(-2)}`;
    return `${season}-${String((season % 100) + 1).padStart(2, "0")}`;
  }

  /** The player list the chip row is showing: a Walkr's Menu handoff, or the
   * selected Quick Search. Manual typing returns null — there the input *is*
   * the list, so there is nothing to chip. */
  function sourceSlices() {
    if (hashPlan && Array.isArray(hashPlan.targets)) return hashPlan.targets;
    const p = quickEl && PRESETS.find((x) => x.id === quickEl.value);
    return p ? p.slices : null;
  }

  /** Drop excluded players, then drop slices left with nobody in them — an empty
   * player list means "sweep the whole market" in scan(), which is not what
   * removing one chip should ask for. */
  function applyExclusions(targets) {
    if (!excluded.size) return targets;
    return targets
      .map((t) => ({
        ...t,
        players: (t.players || []).filter(
          (n) => !excluded.has(playerKey(t.sport, t.season, n))
        ),
      }))
      .filter((t) => (t.players || []).length);
  }

  function currentTargets() {
    if (hashPlan && Array.isArray(hashPlan.targets)) {
      if (hashPlan.maxCards != null) DEFAULTS.maxCards = Number(hashPlan.maxCards);
      if (hashPlan.maxSpend != null) DEFAULTS.maxSpend = Number(hashPlan.maxSpend);
      return applyExclusions(hashPlan.targets.map((t) => ({ ...t })));
    }
    const preset = PRESETS.find((x) => x.id === quickEl.value);
    if (preset)
      return applyExclusions(
        preset.slices.map((s) => ({ sport: s.sport, season: s.season, players: s.players }))
      );
    const players = playersEl.value.split(",").map((s) => s.trim()).filter(Boolean);
    const sp = sportEl.value;
    const sports = sp === "all" ? ALL_SPORTS : [SPORT_ALIAS[sp] || sp];
    return sports.map((s) => ({ sport: s, season: SEASON[s], players }));
  }

  /** Rebuild the chip row. × drops a player for this run; the chip greys out and
   * its × becomes ↺, so a misclick is one click back. */
  function renderChips() {
    if (!chipsEl) return;
    chipsEl.textContent = "";
    const src = sourceSlices();
    if (!src || !src.length) {
      chipsEl.style.display = "none";
      return;
    }
    chipsEl.style.display = "flex";
    let removed = 0;
    for (const s of src) {
      for (const name of s.players || []) {
        const key = playerKey(s.sport, s.season, name);
        const gone = excluded.has(key);
        if (gone) removed++;
        const chip = document.createElement("span");
        chip.style.cssText = [
          "display:inline-flex", "align-items:center", "gap:5px",
          "padding:2px 3px 2px 8px", "border-radius:999px",
          `border:1px solid ${gone ? "#33415a" : "#2f4a72"}`,
          `background:${gone ? "#141c2b" : "#122036"}`,
          `color:${gone ? "#63748f" : "#cfe0f7"}`,
          gone ? "text-decoration:line-through" : "",
        ].filter(Boolean).join(";");
        const nm = document.createElement("span");
        nm.textContent = name;
        const ctx = document.createElement("span");
        ctx.textContent = `${SPORT_LABEL[s.sport] || s.sport} ${seasonLabel(s.sport, s.season)}`;
        ctx.style.cssText = "color:#7f93b0;font-size:11px";
        const x = document.createElement("button");
        x.type = "button";
        x.textContent = gone ? "\u21ba" : "\u00d7";
        x.title = gone
          ? `put ${name} back in this run`
          : `drop ${name} from this run only — the preset keeps them`;
        x.setAttribute("aria-label", gone ? `restore ${name}` : `remove ${name}`);
        x.style.cssText =
          "background:none;border:0;color:inherit;cursor:pointer;font:inherit;padding:0 4px;line-height:1.1";
        x.onclick = () => {
          if (gone) excluded.delete(key);
          else excluded.add(key);
          renderChips();
          render();
        };
        chip.append(nm, ctx, x);
        chipsEl.appendChild(chip);
      }
    }
    if (removed) {
      const all = btn(
        "restore all",
        () => { excluded.clear(); renderChips(); render(); },
        "font-size:11px;padding:2px 8px;border-radius:999px;"
      );
      chipsEl.appendChild(all);
      const note = document.createElement("span");
      note.textContent = `${removed} out of this run only`;
      note.style.cssText = "color:#7f93b0;font-size:11px;align-self:center";
      chipsEl.appendChild(note);
    }
  }

  // ── UI ───────────────────────────────────────────────────────────────────
  let panel, logEl, statusEl, sportEl, playersEl, quickEl, liveEl, capsEl, chipsEl, lastBtnEl;
  let intervalEl, intervalMaxEl, allowanceEl, primerEl, loopEl, loopBtnEl;
  /** boot() runs two or three times (readyState, DOMContentLoaded, load) — the
   * loop must only be resumed once, or every pass would arm another timer. */
  let loopResumed = false;
  const btn = (label, fn, css) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = "background:#1a2b45;color:#cfe0f7;border:1px solid #2a3a55;border-radius:6px;padding:4px 9px;cursor:pointer;" + (css || "");
    b.onclick = fn;
    return b;
  };
  const opt = (value, text) => {
    const o = document.createElement("option");
    o.value = value; o.textContent = text;
    return o;
  };
  const labeled = (t) => {
    const d = document.createElement("div");
    d.textContent = t; d.style.color = "#7f93b0";
    return d;
  };

  function buildPanel() {
    panel = document.createElement("div");
    panel.style.cssText = ["position:fixed", "right:14px", "bottom:14px", "z-index:2147483647",
      "width:430px", "max-height:74vh", "display:flex", "flex-direction:column",
      "background:#0b1120", "color:#e6edf7", "border:1px solid #2a3a55", "border-radius:10px",
      "overflow:hidden",
      "font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace", "box-shadow:0 10px 30px rgba(0,0,0,.5)"].join(";");

    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 10px;background:#111c30;border-bottom:1px solid #2a3a55;cursor:move";
    head.innerHTML = '<b style="flex:1">Walkr Autobid</b>';
    // STOP is the kill switch for whatever is running — a single run and an
    // armed loop both. It also clears the loop's stored state, so a reload
    // after pressing it doesn't quietly re-arm the thing.
    head.appendChild(btn("STOP", () => {
      S.stop = true;
      if (LOOP.on || LOOP.phase !== "idle") loopStop("STOP pressed.");
      else logLine("STOP pressed.");
    }, "background:#c0392b;color:#fff;font-weight:700;"));
    makeDraggable(panel, head);

    const cfg = document.createElement("div");
    cfg.style.cssText = "padding:8px 10px;border-bottom:1px solid #2a3a55;display:grid;grid-template-columns:auto 1fr;gap:5px 8px;align-items:center;flex:0 1 auto;min-height:0;overflow:auto";

    quickEl = document.createElement("select");
    quickEl.appendChild(opt("", "— none —"));
    for (const p of PRESETS) quickEl.appendChild(opt(p.id, p.label));
    quickEl.style.cssText = selCss();

    sportEl = document.createElement("select");
    sportEl.appendChild(opt("all", "all"));
    for (const s of ALL_SPORTS) sportEl.appendChild(opt(s, s));
    sportEl.style.cssText = selCss();

    playersEl = document.createElement("input");
    playersEl.placeholder = "players, comma separated (or pick a Quick Search)";
    playersEl.style.cssText = "background:#0b1120;color:#e6edf7;border:1px solid #2a3a55;border-radius:5px;padding:3px 6px;width:100%";

    /** The bubble row under Players — the selected Quick Search's lineup, each
     * player removable for this run. Hidden while typing players by hand. */
    chipsEl = document.createElement("div");
    chipsEl.style.cssText =
      "grid-column:1/-1;display:none;flex-wrap:wrap;gap:4px;align-items:center;margin:1px 0 2px";

    capsEl = document.createElement("div");
    capsEl.style.cssText = "grid-column:1/-1;color:#9fb3d1";
    liveEl = document.createElement("label");
    liveEl.style.cssText = "grid-column:1/-1;display:flex;gap:6px;align-items:center;color:#ffb4a2";
    liveEl.innerHTML = '<input type="checkbox"> LIVE (actually bid — spends rax)';
    liveEl.querySelector("input").onchange = (e) => { DEFAULTS.live = e.target.checked; render(); };

    /** Loop row: run the selected Quick Search every N minutes off one rax
     * allowance. The allowance is a ceiling on rax *committed* (bids reserve
     * their price whether they win or not), not on what the loop may look at. */
    const loopRow = document.createElement("div");
    loopRow.style.cssText = "grid-column:1/-1;display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding-top:2px";
    const numCss = "width:56px;" + selCss();
    intervalEl = document.createElement("input");
    intervalEl.type = "number";
    intervalEl.min = String(LOOP_CAPS.minIntervalMin);
    intervalEl.max = String(LOOP_CAPS.maxIntervalMin);
    intervalEl.step = "1";
    intervalEl.value = String(LOOP.intervalMin);
    intervalEl.title = `shortest wait between cycles, in minutes (${LOOP_CAPS.minIntervalMin}–${LOOP_CAPS.maxIntervalMin})`;
    intervalEl.style.cssText = numCss;
    intervalMaxEl = document.createElement("input");
    intervalMaxEl.type = "number";
    intervalMaxEl.min = String(LOOP_CAPS.minIntervalMin);
    intervalMaxEl.max = String(LOOP_CAPS.maxIntervalMin);
    intervalMaxEl.step = "1";
    intervalMaxEl.value = String(LOOP.intervalMax);
    intervalMaxEl.title = `longest wait between cycles, in minutes — each cycle picks a random wait in between, so the cadence isn't a metronome`;
    intervalMaxEl.style.cssText = numCss;
    const applyInterval = () => {
      const clamp = (v, d) =>
        Math.min(LOOP_CAPS.maxIntervalMin, Math.max(LOOP_CAPS.minIntervalMin, Math.round(Number(v) || d)));
      LOOP.intervalMin = clamp(intervalEl.value, LOOP_CAPS.defaultIntervalMin);
      LOOP.intervalMax = Math.max(LOOP.intervalMin, clamp(intervalMaxEl.value, LOOP_CAPS.defaultIntervalMax));
      intervalEl.value = String(LOOP.intervalMin);
      intervalMaxEl.value = String(LOOP.intervalMax);
      saveLoop();
      render();
    };
    intervalEl.onchange = applyInterval;
    intervalMaxEl.onchange = applyInterval;
    allowanceEl = document.createElement("input");
    allowanceEl.type = "number";
    allowanceEl.min = "0";
    allowanceEl.step = "500";
    allowanceEl.value = String(LOOP.allowance);
    allowanceEl.title = "total rax the loop may commit before it stops itself";
    allowanceEl.style.cssText = "width:78px;" + selCss();
    allowanceEl.onchange = () => {
      LOOP.allowance = Math.max(0, Math.round(Number(allowanceEl.value) || 0));
      allowanceEl.value = String(LOOP.allowance);
      saveLoop();
      render();
    };
    primerEl = document.createElement("input");
    primerEl.type = "checkbox";
    primerEl.checked = true;
    const primerLbl = document.createElement("label");
    primerLbl.title =
      "once a cycle, click the page's own Buy Now on the cheapest target — that is " +
      "what mints a fresh Turnstile token, and it places that one bid. Without it a " +
      "20-minute cadence has a stale token and Real 401s every bid.";
    primerLbl.style.cssText = "display:flex;gap:5px;align-items:center;color:#9fb3d1";
    primerLbl.append(primerEl, document.createTextNode("primer"));
    loopBtnEl = btn("Arm loop", () => loopArm(), "background:#26364f;color:#dce8f8;");
    loopRow.append(
      labeled("every"), intervalEl, labeled("\u2013"), intervalMaxEl, labeled("min \u00b7"),
      labeled("allowance"), allowanceEl, labeled("rax"),
      primerLbl, loopBtnEl,
      btn("Reset allowance", () => {
        LOOP.committed = 0;
        LOOP.cards = 0;
        saveLoop();
        logLine(`loop: allowance reset — ${fmtRax(LOOP.allowance)} rax available again, 0 cards bid.`);
        render();
      }),
      btn("Primer report", () => primerReport()),
    );
    loopEl = document.createElement("div");
    loopEl.style.cssText = "grid-column:1/-1;color:#9fb3d1";

    cfg.append(labeled("Quick Search"), quickEl, labeled("Sport"), sportEl, labeled("Players"), playersEl,
      chipsEl, capsEl, liveEl, loopRow, loopEl);

    quickEl.onchange = () => {
      hashPlan = null;   // a manual pick overrides a menu handoff
      excluded.clear();  // picking a Quick Search restores every player it lists
      const p = PRESETS.find((x) => x.id === quickEl.value);
      // Picking a preset sets its sport (Low PerRax and All Sports are multi-sport,
      // so those show "all"). The preset carries its own players, so the box is
      // cleared and parked.
      if (p) { sportEl.value = p.sport; playersEl.value = ""; playersEl.disabled = true; }
      else { playersEl.disabled = false; }
      render();
    };
    sportEl.onchange = () => { hashPlan = null; quickEl.value = ""; excluded.clear(); playersEl.disabled = false; render(); };
    playersEl.oninput = () => { if (playersEl.value.trim()) { hashPlan = null; quickEl.value = ""; excluded.clear(); } render(); };

    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;gap:6px;padding:8px 10px;flex-wrap:wrap;flex:0 0 auto";
    lastBtnEl = btn("Bid these", () => bidCached(), "background:#14432b;color:#b8f5cf;border-color:#1f6b45;");
    bar.append(btn("Run", () => { if (!S.running) run(); }), lastBtnEl, btn("Clear log", () => { S.log = []; render(); }));

    statusEl = document.createElement("div");
    statusEl.style.cssText = "padding:0 10px 8px;color:#9fb3d1;white-space:pre-wrap;flex:0 0 auto";
    logEl = document.createElement("div");
    logEl.style.cssText = "overflow:auto;padding:6px 10px 10px;border-top:1px solid #2a3a55;white-space:pre-wrap;flex:1 1 auto;min-height:0";

    /** The resize grip the pointer grabs; sits over the bottom-right corner. */
    const grip = document.createElement("div");
    grip.title = "drag to resize · double-click to reset";
    grip.setAttribute("aria-label", "resize panel");
    grip.style.cssText = [
      "position:absolute", "right:0", "bottom:0", "width:22px", "height:22px",
      "cursor:nwse-resize", "border-bottom-right-radius:10px", "touch-action:none",
      "background:linear-gradient(135deg, transparent 0 52%, #35507c 52% 60%," +
        " transparent 60% 70%, #35507c 70% 78%, transparent 78% 88%, #35507c 88% 96%, transparent 96% 100%)",
    ].join(";");

    panel.append(head, cfg, bar, statusEl, logEl, grip);
    makeResizable(panel, grip);
    // A remembered size re-opens the panel exactly as it was left.
    const saved = storedSize();
    if (saved) {
      panel.style.width = saved.w + "px";
      panel.style.height = saved.h + "px";
      panel.style.maxHeight = "none";
    }
    window.addEventListener("resize", clampPanel);
    mount(panel);
    if (hashPlan && hashPlan.label) {
      const match = PRESETS.find((p) => p.label === hashPlan.label);
      if (match) { quickEl.value = match.id; sportEl.value = match.sport; }
    }
    lastBtn();
    render();
  }

  const selCss = () => "background:#0b1120;color:#e6edf7;border:1px solid #2a3a55;border-radius:5px;padding:2px 4px";

  function mount(el) {
    const host = document.body || document.documentElement;
    if (host) host.appendChild(el);
  }

  function makeDraggable(el, handle) {
    let sx, sy, ox, oy, drag = false;
    handle.addEventListener("mousedown", (e) => {
      drag = true; sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
      el.style.right = "auto"; el.style.bottom = "auto"; el.style.left = ox + "px"; el.style.top = oy + "px";
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => { if (drag) { el.style.left = (ox + e.clientX - sx) + "px"; el.style.top = (oy + e.clientY - sy) + "px"; } });
    window.addEventListener("mouseup", () => { drag = false; });
  }

  // ── panel size: resizable + remembered ───────────────────────────────────
  const SIZE_KEY = "walkr.autobid.size.v1";
  const SIZE_MIN = { w: 340, h: 240 };
  const SIZE_DEFAULT_W = 430;
  const SIZE_DOCK_MAX_H = "74vh";

  function storedSize() {
    try {
      const s = JSON.parse(localStorage.getItem(SIZE_KEY) || "null");
      if (s && Number.isFinite(s.w) && Number.isFinite(s.h)) return { w: s.w, h: s.h };
    } catch (_) {}
    return null;
  }
  function saveSize(w, h) {
    try { localStorage.setItem(SIZE_KEY, JSON.stringify({ w: Math.round(w), h: Math.round(h) })); } catch (_) {}
  }
  function clearSize() {
    try { localStorage.removeItem(SIZE_KEY); } catch (_) {}
  }

  /** Sizes are free to be large, but never larger than the window. */
  const sizeCaps = () => ({
    w: Math.max(SIZE_MIN.w, window.innerWidth - 12),
    h: Math.max(SIZE_MIN.h, window.innerHeight - 12),
  });

  /** Keep an explicitly-sized panel on screen when the window shrinks. */
  function clampPanel() {
    if (!panel || !panel.style.width) return;
    const caps = sizeCaps();
    panel.style.width = Math.min(parseFloat(panel.style.width), caps.w) + "px";
    if (panel.style.height) panel.style.height = Math.min(parseFloat(panel.style.height), caps.h) + "px";
    const r = panel.getBoundingClientRect();
    if (r.right > window.innerWidth) panel.style.left = Math.max(4, window.innerWidth - r.width - 8) + "px";
    if (r.bottom > window.innerHeight) panel.style.top = Math.max(4, window.innerHeight - r.height - 8) + "px";
  }

  /** Bottom-right grip: drag to resize, double-click to go back to the default
   * dock. The size is remembered across reloads; the *position* still comes from
   * dragging the header. Pinning the top-left on mousedown means growing always
   * goes down-and-right and a resize can't walk the panel off the screen. */
  function makeResizable(el, grip) {
    let sx, sy, sw, sh, on = false;
    grip.addEventListener("mousedown", (e) => {
      const r = el.getBoundingClientRect();
      el.style.right = "auto"; el.style.bottom = "auto";
      el.style.left = r.left + "px"; el.style.top = r.top + "px";
      el.style.width = r.width + "px"; el.style.height = r.height + "px";
      el.style.maxHeight = "none";
      sx = e.clientX; sy = e.clientY; sw = r.width; sh = r.height; on = true;
      el.style.userSelect = "none";
      e.preventDefault();
      e.stopPropagation();
    });
    window.addEventListener("mousemove", (e) => {
      if (!on) return;
      const caps = sizeCaps();
      el.style.width = Math.min(caps.w, Math.max(SIZE_MIN.w, sw + (e.clientX - sx))) + "px";
      el.style.height = Math.min(caps.h, Math.max(SIZE_MIN.h, sh + (e.clientY - sy))) + "px";
    });
    window.addEventListener("mouseup", () => {
      if (!on) return;
      on = false;
      el.style.userSelect = "";
      saveSize(parseFloat(el.style.width), parseFloat(el.style.height));
      render();
    });
    grip.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearSize();
      el.style.width = SIZE_DEFAULT_W + "px";
      el.style.height = "";
      el.style.maxHeight = SIZE_DOCK_MAX_H;
      el.style.left = "auto"; el.style.top = "auto";
      el.style.right = "14px"; el.style.bottom = "14px";
      render();
    });
  }

  /** The "Bid these" button only lights up once a plan exists. */
  function lastBtn() {
    if (!lastBtnEl) return;
    if (S.lastPlan && S.lastPlan.length) {
      lastBtnEl.disabled = false;
      lastBtnEl.textContent = `Bid these ${S.lastPlan.length} (${S.lastSpend} rax)`;
    } else {
      lastBtnEl.disabled = true;
      lastBtnEl.textContent = "Bid these";
    }
  }

  /** Header age matters: a Turnstile token lives about five minutes, and the
   * page only re-sends headers when it makes a request. Age = "go refresh". */
  function cred(k) {
    if (!creds[k]) return "—";
    const a = Math.round((Date.now() - credsAt[k]) / 1000);
    return a > 240 ? `✓ ${Math.round(a / 60)}m old` : "✓";
  }

  function render() {
    if (!panel || !panel.isConnected) return;
    DEFAULTS.maxRpr = effectiveMaxRpr();
    renderChips();
    const age = S.lastAt ? Math.round((Date.now() - S.lastAt) / 1000) : null;
    statusEl.textContent =
      `maxRpr ${DEFAULTS.maxRpr} · maxCards ${DEFAULTS.maxCards} · maxSpend ${DEFAULTS.maxSpend} rax\n` +
      `sent: auth-info ${cred("real-auth-info")} · session ${cred("real-session-token")} · turnstile ${cred("real-turnstile-token")}\n` +
      (hashPlan ? "targets: from Walkr's Menu\n" : "") +
      (S.lastPlan ? `cached plan: ${S.lastPlan.length} card(s) · ${S.lastSpend} rax · ${age}s old\n` : "") +
      (DEFAULTS.live ? "MODE: LIVE" : "MODE: dry run");
    const pc = activePlayerCaps();
    const pcTxt = Object.keys(pc).length
      ? ` (${Object.entries(pc).map(([n, c]) => `${n} ${c}`).join(", ")})`
      : "";
    capsEl.textContent = `caps: ${DEFAULTS.maxRpr} rax/rating${pcTxt} · ≤${DEFAULTS.maxCards} cards · ≤${DEFAULTS.maxSpend} rax`;
    if (loopEl) loopEl.textContent = loopStatus();
    if (loopBtnEl) {
      loopBtnEl.textContent = LOOP.on ? "Disarm loop" : "Arm loop";
      loopBtnEl.style.background = LOOP.on ? "#3b2233" : "#26364f";
    }
    if (intervalEl && document.activeElement !== intervalEl) intervalEl.value = String(LOOP.intervalMin);
    if (intervalMaxEl && document.activeElement !== intervalMaxEl) intervalMaxEl.value = String(LOOP.intervalMax);
    if (allowanceEl && document.activeElement !== allowanceEl) allowanceEl.value = String(LOOP.allowance);
    // Keep the LIVE box honest about what the code is actually doing, including
    // after a primer navigation re-armed it from localStorage.
    if (liveEl) {
      const cb = liveEl.querySelector("input");
      if (cb && document.activeElement !== cb) cb.checked = !!DEFAULTS.live;
    }
    logEl.textContent = S.log.join("\n");
    logEl.scrollTop = logEl.scrollHeight;
  }

  function boot() {
    if (!document.body) { setTimeout(boot, 300); return; }
    if (!panel) buildPanel();
    if (!loopResumed) { loopResumed = true; resumeLoop(); }
    if (!selfTestOk && !S.log.some((l) => l.includes("SELF-TEST"))) {
      S.log.unshift("SELF-TEST FAILED — the request-token encoder is wrong, every call will 401 as \"Malformed request\".");
      render();
    }
    setInterval(() => { if (panel && !panel.isConnected) mount(panel); }, 2000);
    setInterval(() => { if (panel && panel.isConnected) render(); }, 1000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  window.addEventListener("load", boot);
})();
