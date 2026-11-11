// ==UserScript==
// @name         Walkr Autobid
// @namespace    walkr.realapp
// @version      0.7.4
// @description  Bids the buy-now trigger price on Real marketplace listings that clear a rax-per-rating ceiling, and watches the same searches on a timer to hand back a buy list. Dry-run by default. Hard caps. Kill switch.
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

  THE QUICK SEARCHES ARE THE IOS APP'S
  ------------------------------------
  The dropdown is not a generated family any more — it is exactly the saved
  Quick Searches from the iOS app (the Made tweak mirrors them to the IPA host,
  because a sideload update wipes the app container). Each is a nickname plus a
  player list sliced by sport/season, which is all the app saves. Regenerate
  with `node scripts/autobid/export_quick.mjs` after editing them in the app.

  The app's deal screen screens at a factor of 21 rax/rating by default, so a
  baked search carries that ceiling; the "bid ceiling" field in the panel
  overrides it for a run, and the script's own 11 is what a run with no search
  at all falls back to.

  THE FLOW
  --------
  Run  → scans and prints the plan. Spends nothing unless LIVE is ticked.
  Then, if you like the list, "Bid these" fires exactly that plan — no re-scan.
  A plan older than 5 minutes warns before it bids, because listings turn over.

  THE CONSISTENT TAB (NO BIDDING)
  -------------------------------
  The third tab watches instead of buying. Arm it and every selected search runs
  once immediately, back to back 10–30 s apart; after that each search keeps its
  OWN clock — 7 to 15 minutes by default, re-rolled every time it runs, editable
  in the panel — and a search that comes due starts the moment the previous scan
  finishes. Two scans are never in flight at once. Every listing
  that clears the watch ceiling lands in the list; each row is a button that
  opens that listing's buy screen in a new tab, so the purchase is still a click
  you make. "Pop out list" mirrors the list into its own window for a second
  monitor. The console shows what is running, what it found, and when each
  search is next due. Nothing here bids, ever.

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

  The allowance counts rax COMMITTED: a bid reserves its price and Real charges
  only if nobody outbids you in the 10-minute window. A bid that LOSES hands its
  rax back — once the window has closed the listing is looked up again, and a
  refund is only ever given when the page shows somebody else on top. So the
  balance falls card by card and recovers the ones that got away; a refund can
  free rax, never spend past the allowance.

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
  /** The version actually installed, rendered in the panel header. "Did it
   * update?" should never be a guess: Tampermonkey's own metadata is the truth
   * when it is available, and the literal is the fallback for the managers that
   * hide GM_info. Bump the literal with @version on every release. */
  const RUNNING_VERSION = (typeof GM_info !== "undefined" && GM_info &&
    GM_info.script && GM_info.script.version) || "0.7.4";

  /** This script's own caps. A Walkr's Menu handoff can override them via the
   * URL, and a menu built before a cap change would quietly send the old number
   * — so the shipped values are kept here to compare against. */
  const SCRIPT_CAPS = { maxRpr: 11, maxCards: 50, maxSpend: 1000 };

  const DEFAULTS = {
    maxRpr: SCRIPT_CAPS.maxRpr,      // rax per rating point ceiling, per card
    maxCards: SCRIPT_CAPS.maxCards,  // hard ceiling on bids in one run
    maxSpend: SCRIPT_CAPS.maxSpend,  // hard ceiling on total rax in one run
    gapMin: 350,         // jittered politeness floor
    gapMax: 900,
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
  // Baked from the iOS app's saved Quick Searches (Made tweak → IPA host
  // /ipa/menu/quick). Regenerate: node scripts/autobid/export_quick.mjs
  // 11 searches · 71 cards · screens at ×21
  const PRESETS = [
    {"id":"ios-qmwar9itb","label":"Farm?-FC","sport":"soccer","cards":6,"maxRpr":21,"slices":[{"sport":"soccer","season":2025,"players":["Kylian Mbappe","Erling Haaland","Harry Kane","Lamine Yamal","Lionel Messi","Michael Olise"]}]},
    {"id":"ios-qmwar3ukg","label":"Current-FC","sport":"soccer","cards":9,"maxRpr":21,"slices":[{"sport":"soccer","season":2026,"players":["Bruno Fernandes","Erling Haaland","Lamine Yamal","Nico Paz","Michael Olise","Kylian Mbappe","Declan Rice","Jude Bellingham","Harry Kane"]}]},
    {"id":"ios-qmwaqp0nx","label":"Current-NFL","sport":"nfl","cards":8,"maxRpr":21,"slices":[{"sport":"nfl","season":2026,"players":["Bijan Robinson","Kenneth Walker","Brock Purdy","Caleb Williams","Christian McCaffrey","Josh Allen","James Cook III","Joe Burrow"]}]},
    {"id":"ios-qmw9w8sjk","label":"Current-NBA","sport":"nba","cards":14,"maxRpr":21,"slices":[{"sport":"nba","season":2027,"players":["Ty Jerome","Victor Wembanyama","Shai Gilgeous-Alexander","Jared McCain","Luka Dončić","Kelly Oubre Jr.","VJ Edgecombe","Tyrese Haliburton","Pascal Siakam","LeBron James","Jay Huff","Ivica Zubac","Tyrese Maxey","Austin Reaves"]}]},
    {"id":"ios-qmw9w4gya","label":"Current-NHL","sport":"nhl","cards":7,"maxRpr":21,"slices":[{"sport":"nhl","season":2026,"players":["Macklin Celebrini","Nathan MacKinnon","Leon Draisaitl","Kirill Kaprizov","Connor McDavid","Auston Matthews","Quinn Hughes"]}]},
    {"id":"ios-qmw9vxhse","label":"Farm-NHL","sport":"nhl","cards":5,"maxRpr":21,"slices":[{"sport":"nhl","season":2023,"players":["Connor McDavid","Sergei Bobrovsky","Igor Shesterkin","Leon Draisaitl"]},{"sport":"nhl","season":2024,"players":["Leon Draisaitl"]}]},
    {"id":"ios-qmw9vnfmq","label":"Farm-WNBA","sport":"wnba","cards":1,"maxRpr":21,"slices":[{"sport":"wnba","season":2025,"players":["A'ja Wilson"]}]},
    {"id":"ios-qmw9vmxkz","label":"Farm-NFL","sport":"nfl","cards":5,"maxRpr":21,"slices":[{"sport":"nfl","season":2025,"players":["Christian McCaffrey","Puka Nacua"]},{"sport":"nfl","season":2024,"players":["Saquon Barkley","Derrick Henry"]},{"sport":"nfl","season":2023,"players":["Christian McCaffrey"]}]},
    {"id":"ios-qmw9vk4us","label":"Farm-CFB","sport":"ncaaf","cards":5,"maxRpr":21,"slices":[{"sport":"ncaaf","season":2024,"players":["Ashton Jeanty","Cam Skattebo","Travis Hunter"]},{"sport":"ncaaf","season":2023,"players":["Ollie Gordon II"]},{"sport":"ncaaf","season":2025,"players":["Caleb Hawkins"]}]},
    {"id":"ios-qmw9vhjne","label":"Farm-Mens BB","sport":"all","cards":6,"maxRpr":21,"slices":[{"sport":"ncaam","season":2024,"players":["Zach Edey"]},{"sport":"ncaam","season":2025,"players":["Yaxel Lendeborg"]},{"sport":"ncaam","season":2026,"players":["Cameron Boozer"]},{"sport":"nba","season":2024,"players":["Luka Dončić","Nikola Jokić"]},{"sport":"nba","season":2025,"players":["Shai Gilgeous-Alexander"]}]},
    {"id":"ios-qmw9vegtb","label":"Farm-MLB","sport":"mlb","cards":5,"maxRpr":21,"slices":[{"sport":"mlb","season":2025,"players":["Shohei Ohtani","Yoshinobu Yamamoto"]},{"sport":"mlb","season":2023,"players":["Shohei Ohtani"]},{"sport":"mlb","season":2026,"players":["Drew Rasmussen","Jacob Misiorowski"]}]},
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
    const ps = selectedPresets();
    if (!ps.length) return NO_CAPS;
    const merged = {};
    for (const p of ps) Object.assign(merged, p.playerCaps || {});
    return Object.keys(merged).length ? merged : NO_CAPS;
  }

  /** A ceiling that belongs to one scan rather than to the panel — the
   * Consistent tab screens at its own factor, and it must not leak into a bid
   * run (or be overwritten mid-scan by render()'s once-a-second pass). */
  let scanCeiling = null;

  /** The rax-per-rating ceiling for one player: their own when the lineup names
   * one (the deep-market cards worth a looser price because they level fast),
   * otherwise the run's ceiling. */
  function capFor(name) {
    if (scanCeiling != null) return scanCeiling;
    const c = activePlayerCaps()[name];
    return c == null ? DEFAULTS.maxRpr : Number(c);
  }

  /** One listing → a plan candidate, or nothing. `pid` rides along so a bid
   * that loses its auction can be looked up again at reconciliation time. */
  function consider(l, sport, season, label, found, pid, opts) {
    const watch = !!(opts && opts.watch);
    const ends = l.endsAt ? Date.parse(l.endsAt) : NaN;
    const price = listingPrice(l);
    const rating = listingRating(l);
    const rpr = price != null && price > 0 && rating ? price / rating : null;
    if (Number.isFinite(ends) && ends <= Date.now()) return;   // auction already ended
    if (!l.canBid) return;                                     // Real won't take a bid on it
    if (l.buyNowPrice == null && !watch) return;               // no trigger price to bid
    if (price == null || price <= 0) return;
    if (rating == null) return;                                // nothing to price against
    const cap = capFor(label);
    if (rpr > cap) return;                                     // over the rax/rating ceiling
    if (found.some((f) => f.listingId === l.id)) return;
    found.push({
      listingId: l.id, sport, season, player: label, rarity: l.rarity,
      rating, price, rpr: Math.round(rpr * 100) / 100, cap,
      pid: pid == null ? null : pid, endsAt: l.endsAt || null, url: listingUrl(l.id),
      /** How the price was quoted: a buy-now trigger, or a live auction's
       * current/minimum bid. Only the watch list ever sees the second kind —
       * a bid run needs a trigger price. */
      how: l.buyNowPrice != null ? "buy now" : "auction",
    });
  }

  /** Find every live listing of every target that clears the ceiling. A target
   * with players is scoped to them; one without is a whole-market sweep. */
  async function scan(targets, log, opts) {
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
          for (const l of ls) consider(l, sport, season, listingLabel(l), found, null, opts);
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
          for (const l of ls) consider(l, sport, season, name, found, pid, opts);
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
  /** How long a bid needs before its auction has resolved: the countdown runs
   * 10 minutes from the moment a bid goes top, so past this the card is either
   * won (rax charged) or lost (rax free). */
  const RECONCILE_MS = 11 * 60 * 1000;
  /** How many cycles a still-live bid is re-checked before it is left alone —
   * the auction resolved somewhere we can't read, so the rax stays spent. */
  const RECONCILE_MAX_CHECKS = 4;

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
    presetIds: [],
    /** Rax reserved by bids the loop has placed. Real only charges winners, so
     * this over-counts on purpose: the allowance can stop early, never overshoot. */
    committed: 0,
    /** Cards the loop has bid on — the count that ticks the balance down. */
    cards: 0,
    /** Bids whose 10-minute window is still open. Each holds its rax until the
     * listing is looked at again: outbid hands the rax back, anything else keeps
     * it spent. Reset allowance clears this too. */
    pending: [],
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
        presetIds: LOOP.presetIds,
        committed: LOOP.committed, cards: LOOP.cards, pending: LOOP.pending,
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
    // Bids still inside their 10-minute window count against the balance, but
    // it is worth seeing how much of it is only provisionally spent.
    const pend = LOOP.pending.length
      ? ` · ${LOOP.pending.length} awaiting the 10-min window` : "";
    if (!LOOP.on) {
      return LOOP.committed
        ? `loop: off · ${fmtRax(left)} rax left of ${fmtRax(LOOP.allowance)} · ${bid}${pend}`
        : `loop: off · allowance ${fmtRax(LOOP.allowance)} rax`;
    }
    const next = LOOP.nextAt ? LOOP.nextAt - Date.now() : null;
    return `loop: ON · ${fmtRax(left)} rax left of ${fmtRax(LOOP.allowance)} · ${bid} · ` +
      `every ${LOOP.intervalMin}\u2013${LOOP.intervalMax} min · cycle ${LOOP.cycles}/${LOOP_CAPS.maxCycles}` +
      (next != null && next > 0 ? ` · next in ${Math.max(1, Math.ceil(next / 60000))} min` : "") +
      (LOOP.phase === "prime" ? " · priming a token" : "") + pend;
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

  /** Book one bid against the allowance, win or lose — and remember it, so the
   * rax can come back if somebody outbids it. Keyed by listing id: the primer's
   * click and the API bid that follows can hit the same card, and one card is
   * one reservation. */
  function loopCommit(card) {
    const id = card && card.listingId;
    if (id == null) return;
    if (LOOP.pending.some((p) => p.listingId === id)) return;
    const price = Number(card.price) || 0;
    LOOP.committed += price;
    LOOP.cards += 1;
    LOOP.pending.push({
      listingId: id, price, at: Date.now(), checks: 0,
      sport: card.sport, season: card.season, rarity: card.rarity,
      player: card.player, pid: card.pid == null ? null : card.pid,
    });
    saveLoop();
    render();
  }

  /** The allowance is a reservation, not a bill: Real only charges a winner, and
   * a winner is a bid nobody outbid inside 10 minutes. So once a bid is older
   * than that, look its listing up again — gone means the auction resolved and
   * the rax stays spent; still listed with a HIGHER current bid means somebody
   * beat us to it and the rax goes back on the balance.
   *
   * A refund can only ever free rax, so the run can never outspend the
   * allowance: the only thing that releases a reservation is Real's own listing
   * page saying somebody else is on top. Anything unreadable keeps its rax. */
  async function loopReconcile(log) {
    if (!LOOP.pending.length) return;
    const due = LOOP.pending.filter((p) => Date.now() - p.at >= RECONCILE_MS);
    if (!due.length) return;
    for (const p of due) {
      if (S.stop) return;
      p.checks = (p.checks || 0) + 1;
      let list = [];
      try {
        list = p.pid != null
          ? await playerListings(p.sport, p.season, p.pid, p.rarity, "card")
          : await bucketListings(p.sport, p.season, p.rarity, "card");
      } catch (e) {
        log(`reconcile #${p.listingId}: ${e.message} — its ${fmtRax(p.price)} rax stay reserved.`);
        continue;
      }
      const l = list.find((x) => x.id === p.listingId);
      const top = l ? Number(l.currentBidAmount || 0) || 0 : 0;
      const outbid = !!l && (top > p.price || l.isTopBidder === false || l.userIsTopBidder === false);
      const drop = (why) => { LOOP.pending = LOOP.pending.filter((x) => x.listingId !== p.listingId); log(why); };
      if (!l) {
        drop(`reconcile #${p.listingId} (${p.player}): the listing is gone, so the auction resolved — ` +
          `${fmtRax(p.price)} rax stay spent.`);
      } else if (outbid) {
        LOOP.committed = Math.max(0, LOOP.committed - p.price);
        LOOP.cards = Math.max(0, LOOP.cards - 1);
        drop(`↩ outbid on #${p.listingId} (${p.player})${top ? ` at ${fmtRax(top)} rax` : ""} — ` +
          `${fmtRax(p.price)} rax back on the allowance: ${fmtRax(loopRemaining())} left.`);
      } else if (p.checks >= RECONCILE_MAX_CHECKS) {
        drop(`#${p.listingId} (${p.player}) is still listed and unreconciled after ` +
          `${p.checks} checks — leaving its ${fmtRax(p.price)} rax reserved.`);
      }
      saveLoop();
      render();
      await sleep(gap());
    }
  }

  /** A placed bid reserves its price (Real charges only winners), and the
   * balance is debited and repainted as each card lands — so the panel ticks
   * down card by card while a plan is firing. */
  async function executePlanLoop(plan) {
    const r = (await executePlan(plan, logLine, (p) => loopCommit(p))) || { placed: 0, committed: 0, failed: 0 };
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
    if (!LOOP.on) return;
    if (S.running) {
      logLine("loop: a run is already in progress — checking again in a minute.");
      loopSchedule(60000);
      return;
    }
    // Reconcile before spending anything: a bid that lost its auction hands its
    // rax back, and that can be the difference between "allowance left" and
    // "the allowance is gone".
    await loopReconcile(logLine);
    const why = loopBoundHit();
    if (why === "disarmed") return;
    // A fully-committed allowance is only the end once nothing is still inside
    // its 10-minute window: a pending bid that gets outbid hands its rax back.
    if (why && /^allowance committed/.test(why) && LOOP.pending.length) {
      const wait = loopWaitMs();
      logLine(`loop: allowance fully committed (${fmtRax(LOOP.committed)} of ${fmtRax(LOOP.allowance)} rax), ` +
        `but ${LOOP.pending.length} bid(s) are still inside their 10-minute window — looking again in ` +
        `${Math.round(wait / 60000)} min, in case one is outbid and hands its rax back.`);
      loopSchedule(wait);
      return;
    }
    if (why) { loopStop(why); return; }

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
      // The page's own click placed that bid itself — book it against the same
      // allowance, so the balance is honest about what has been spent.
      loopCommit(card);
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
    // The WHOLE plan, card 0 included. The click above is supposed to have
    // placed card 0 itself, but if it landed on something that minted a token
    // without bidding, this bid is the repair — and when the click did bid,
    // Real answers a duplicate at the same price with "minimum bid", which is
    // one of the ordinary skips. Either way the card is charged once:
    // loopCommit keys reservations by listing id.
    const rest = plan;
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
    const armed = selectedPresets();
    if (!armed.length) {
      logLine("loop: pick a Quick Search first — a loop needs a fixed lineup, not a whole-market sweep.");
      return;
    }
    if (S.running) { logLine("loop: a run is already in progress — wait for it to finish."); return; }
    if (!DEFAULTS.live) logLine("loop: LIVE is off, so every cycle is a dry run for now.");
    // A spent allowance refuses to arm — unless there are bids still inside
    // their 10-minute window, because those can hand their rax back on the
    // first cycle's reconciliation.
    if (loopRemaining() <= 0 && !LOOP.pending.length) {
      logLine("loop: the allowance is already committed — hit Reset allowance first.");
      return;
    }
    LOOP.on = true;
    LOOP.cycles = 0;
    LOOP.consecFails = 0;
    LOOP.startedAt = Date.now();
    LOOP.lastRunAt = Date.now();
    LOOP.nextAt = 0;
    LOOP.presetIds = armed.map((p) => p.id);
    LOOP.phase = "idle";
    LOOP.plan = null;
    S.stop = false;
    saveLoop();
    logLine(`loop armed — ${armed.map((p) => p.label).join(" + ")} · ${fmtRax(loopRemaining())} rax allowance · a random ` +
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
    LOOP.pending = Array.isArray(st.pending) ? st.pending : [];
    LOOP.cycles = Number(st.cycles) || 0;
    LOOP.consecFails = Number(st.consecFails) || 0;
    LOOP.startedAt = Number(st.startedAt) || 0;
    LOOP.lastRunAt = Number(st.lastRunAt) || 0;
    LOOP.nextAt = Number(st.nextAt) || 0;
    LOOP.plan = st.plan || null;
    // Restore the Quick Search the loop was armed on — every lineup of it. A
    // reload (including the one the primer causes) otherwise leaves the panel
    // unselected, and the next cycle would sweep the whole market instead.
    // Older builds stored a single `presetId`; read that as a one-item list.
    LOOP.presetIds = (Array.isArray(st.presetIds) ? st.presetIds : (st.presetId ? [st.presetId] : []))
      .map(String).filter(Boolean);
    if (LOOP.presetIds.length && quickEl) {
      const found = LOOP.presetIds.map((id) => PRESETS.find((x) => x.id === id)).filter(Boolean);
      // All of them, or none: quietly dropping one lineup the loop was armed on
      // would bid a different set of cards than the one that was chosen.
      if (found.length !== LOOP.presetIds.length) {
        LOOP.on = false;
        saveLoop();
        logLine(`loop: the lineup it was armed on (${LOOP.presetIds.join(", ")}) is gone from this build — loop left off.`);
        return;
      }
      setSelectedPresets(found.map((p) => p.id));
      sportEl.value = found[0].sport;
      playersEl.value = "";
      playersEl.disabled = true;
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

  /** The lineups this run carries, in menu order. The dropdown ADDS one at a
   * time and each pick becomes a bubble, so a loop can carry several off the one
   * allowance (Optimal Setup · NHL + · NBA + · CBB, say). Nothing reads
   * `quickEl.value` — this list is the single source of truth. */
  let selectedIds = [];
  /** The panel's own ceiling override, persisted, so "screen at 14 today"
   * survives a reload. Null means "whatever the lineups say" (see
   * effectiveMaxRpr) — which is why picking a lineup still changes the number. */
  const FACTOR_KEY = "walkr.autobid.factor.v1";
  let factorOverride = null;
  try {
    const f = Number(localStorage.getItem(FACTOR_KEY));
    if (Number.isFinite(f) && f > 0) factorOverride = f;
  } catch (_) {}
  function selectedPresets() {
    return PRESETS.filter((p) => selectedIds.includes(p.id));
  }

  /** Select exactly these preset ids and nothing else. */
  function setSelectedPresets(ids) {
    const want = new Set(ids || []);
    selectedIds = PRESETS.filter((p) => want.has(p.id)).map((p) => p.id);
    if (quickEl) quickEl.value = "";
    renderPresetChips();
  }

  /** Add one lineup to the run (a no-op if it is already in it), keeping the
   * list in menu order so the label always reads the same way. */
  function addPreset(id) {
    if (id && !selectedIds.includes(id)) selectedIds.push(id);
    setSelectedPresets(selectedIds);
  }

  function currentLabel() {
    if (hashPlan) return hashPlan.label || "Walkr's Menu";
    const ps = selectedPresets();
    return ps.length ? ps.map((p) => p.label).join(" + ") : "";
  }

  /** The rpr ceiling for THIS run, in priority order: a Walkr's Menu handoff,
   * then a preset that declares its own (the Daily Pack Buys presets screen at
   * 21 — the pack's own price is 20), then the script's shipped cap. Presets
   * other than those fall back to SCRIPT_CAPS, so picking one after another
   * can't leave a loosened ceiling behind. */
  function effectiveMaxRpr() {
    if (hashPlan && hashPlan.maxRpr != null) return Number(hashPlan.maxRpr);
    if (factorOverride != null) return Number(factorOverride);
    // A loosened ceiling is only inherited when *every* selected lineup declares
    // one. Mixing a capped preset with an uncapped one falls back to the shipped
    // cap, so selecting a second preset can never leave 21 behind on a lineup
    // that never asked for it.
    const ps = selectedPresets();
    if (ps.length && ps.every((p) => p.maxRpr != null))
      return Math.max(...ps.map((p) => Number(p.maxRpr)));
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
    const ps = selectedPresets();
    return ps.length ? ps.flatMap((p) => p.slices) : null;
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
    const presets = selectedPresets();
    if (presets.length)
      return applyExclusions(
        presets.flatMap((p) =>
          p.slices.map((s) => ({ sport: s.sport, season: s.season, players: s.players }))
        )
      );
    const players = playersEl.value.split(",").map((s) => s.trim()).filter(Boolean);
    const sp = sportEl.value;
    const sports = sp === "all" ? ALL_SPORTS : [SPORT_ALIAS[sp] || sp];
    return sports.map((s) => ({ sport: s, season: SEASON[s], players }));
  }

  /** The chosen lineups as bubbles — one × each, so a lineup is added and taken
   * back out in the same place. */
  function renderPresetChips() {
    if (!presetChipsEl) return;
    presetChipsEl.textContent = "";
    const ps = selectedPresets();
    if (!ps.length) { presetChipsEl.style.display = "none"; return; }
    presetChipsEl.style.display = "flex";
    for (const p of ps) {
      const chip = document.createElement("span");
      chip.style.cssText = "display:inline-flex;align-items:center;gap:3px;padding:1px 2px 1px 8px;" +
        "border-radius:999px;border:1px solid #3a5a8a;background:#152744;color:#dbe9ff";
      const nm = document.createElement("span");
      nm.textContent = p.label;
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "\u00d7";
      x.title = `take ${p.label} out of this run`;
      x.setAttribute("aria-label", `remove ${p.label}`);
      x.style.cssText =
        "background:none;border:0;color:inherit;cursor:pointer;font:inherit;padding:0 4px;line-height:1.1";
      x.onclick = () => {
        excluded.clear();
        setSelectedPresets(selectedIds.filter((id) => id !== p.id));
        applySelection();
      };
      chip.append(nm, x);
      presetChipsEl.appendChild(chip);
    }
  }

  /** A chosen lineup sets the sport and parks the players box — the lineup
   * carries its own players. The manual fields come back when nothing is
   * chosen. */
  function applySelection() {
    const ps = selectedPresets();
    if (ps.length) { sportEl.value = ps[0].sport; playersEl.value = ""; playersEl.disabled = true; }
    else { playersEl.disabled = false; }
    render();
  }

  /** Rebuild the chip row: a muted tag per sport/season, then that slice's
   * players. × drops a player for this run; the chip greys out and its × becomes
   * ↺, so a misclick is one click back. The chips are deliberately small — the
   * sport/season lives in the slice tag and the tooltip, so a whole lineup takes
   * a couple of lines instead of a screen. */
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
      const tag = document.createElement("span");
      tag.textContent = `${SPORT_LABEL[s.sport] || s.sport} ${seasonLabel(s.sport, s.season)}`;
      tag.style.cssText = "color:#7f93b0;font-size:11px;padding:2px 1px 2px 3px";
      chipsEl.appendChild(tag);
      for (const name of s.players || []) {
        const key = playerKey(s.sport, s.season, name);
        const gone = excluded.has(key);
        if (gone) removed++;
        const chip = document.createElement("span");
        chip.style.cssText = [
          "display:inline-flex", "align-items:center", "gap:2px",
          "padding:1px 2px 1px 7px", "border-radius:999px",
          `border:1px solid ${gone ? "#33415a" : "#2f4a72"}`,
          `background:${gone ? "#141c2b" : "#122036"}`,
          `color:${gone ? "#63748f" : "#cfe0f7"}`,
          gone ? "text-decoration:line-through" : "",
        ].filter(Boolean).join(";");
        chip.title = `${name} · ${SPORT_LABEL[s.sport] || s.sport} ${seasonLabel(s.sport, s.season)}`;
        const nm = document.createElement("span");
        nm.textContent = name;
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
        chip.append(nm, x);
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

  // ── the Consistent tab: watch the market, hand back a buy list ────────────
  /** Nothing in this block bids. Each search keeps its OWN cadence — 7 to 15
   * minutes, re-rolled every time it runs — so with three searches picked, one
   * fires, then another a minute or two later, then the third: staggered, never
   * together. Runs are serialised through one timer and separated by a short
   * breather, so two scans can never be in flight at once. */
  const WATCH_CAPS = {
    /** What a search's own clock may be set to. The panel edits the range; these
     * are the rails around it. */
    minIntervalMin: 2,
    maxIntervalMin: 60,
    defaultIntervalMin: 7,
    defaultIntervalMax: 15,
    /** Between the end of one search and the start of the next: long enough that
     * two can't touch, short enough that a due search starts as soon as the
     * previous scan finishes — the first pass uses the same gap. */
    breathMinS: 10,
    breathMaxS: 30,
    maxResults: 80,
    maxLog: 400,
  };
  const WATCH_KEY = "walkr.autobid.watch.v1";
  const WATCH = {
    on: false,
    presetIds: [],
    /** Names typed into the panel, searched in every sport/season the chosen
     * searches already carry (or in the sport picked beside them). */
    extra: [],
    sport: "auto",
    factor: 21,
    results: [],
    logLines: [],
    cycle: 0,
    /** Each search's own 7–15 min clock, editable in the panel. */
    intervalMin: WATCH_CAPS.defaultIntervalMin,
    intervalMax: WATCH_CAPS.defaultIntervalMax,
    /** The arming pass: every selected search, once, back to back 10–30 s apart.
     * Ids are removed as they run; empty means "steady state". */
    pass: [],
    /** presetId → epoch ms that search is next due. Each search has its own
     * clock; the runner always takes the earliest one. */
    next: {},
    /** "idle" | "running" — the overlap guard. One scan in flight, ever. */
    phase: "idle",
    nextAt: 0,
    nextLabel: "",
    /** When the last search finished and the breather it earned, so a queue of
     * due searches runs one at a time instead of back to back. */
    lastEndAt: 0,
    breathMs: 0,
    /** A counter bumped by every merge, so rows can be grouped by the scan that
     * found them — newest batch first, best value inside it. */
    batch: 0,
    /** Listing ids already opened from the list. Purple outline, and it survives
     * a reload: opening the same card twice is a wasted trip. */
    seen: [],
    lastSearch: "",
    timer: null,
  };
  /** 0 while the DOM matches WATCH.results / the console; bumped by anything
   * that changes them, so the once-a-second render() doesn't rebuild 80 buttons
   * every tick. */
  let watchDirty = 0;
  let watchRendered = -1;
  let watchLogRendered = -1;

  function saveWatch() {
    try {
      localStorage.setItem(WATCH_KEY, JSON.stringify({
        on: WATCH.on, presetIds: WATCH.presetIds, extra: WATCH.extra,
        sport: WATCH.sport, factor: WATCH.factor, results: WATCH.results,
        logLines: WATCH.logLines.slice(-120), cycle: WATCH.cycle, nextAt: WATCH.nextAt,
        next: WATCH.next, lastEndAt: WATCH.lastEndAt, breathMs: WATCH.breathMs,
        intervalMin: WATCH.intervalMin, intervalMax: WATCH.intervalMax, pass: WATCH.pass,
        batch: WATCH.batch, seen: WATCH.seen,
      }));
    } catch (_) {}
  }
  function loadWatch() {
    try {
      const s = JSON.parse(localStorage.getItem(WATCH_KEY) || "null");
      return s && typeof s === "object" ? s : null;
    } catch (_) { return null; }
  }

  const hhmmss = () => new Date().toLocaleTimeString("en-GB", { hour12: false });
  function wlog(line) {
    WATCH.logLines.push(`${hhmmss()} ${line}`);
    if (WATCH.logLines.length > WATCH_CAPS.maxLog)
      WATCH.logLines = WATCH.logLines.slice(-WATCH_CAPS.maxLog);
    watchLogRendered = -1;
    saveWatch();
  }

  const watchPresets = () => PRESETS.filter((p) => WATCH.presetIds.includes(p.id));

  /** The slices one cycle walks: the search's own players, plus the hand-typed
   * ones. Typed names ride on every sport/season the search already covers
   * (Farm-Mens BB is CBB + NBA at once) unless a sport is picked for them. */
  function watchTargets(preset) {
    const targets = (preset ? preset.slices : []).map((s) => ({
      sport: s.sport, season: s.season, players: (s.players || []).slice(),
    }));
    if (!WATCH.extra.length) return targets;
    const extra = WATCH.extra.slice();
    if (WATCH.sport !== "auto") {
      const sp = SPORT_ALIAS[WATCH.sport] || WATCH.sport;
      return targets.concat([{ sport: sp, season: SEASON[sp], players: extra }]);
    }
    const pairs = [];
    for (const t of targets)
      if (!pairs.some((p) => p.sport === t.sport && p.season === t.season))
        pairs.push({ sport: t.sport, season: t.season });
    if (!pairs.length) return targets;   // nothing to inherit from — armed guard warns instead
    return targets.concat(pairs.map((p) => ({ sport: p.sport, season: p.season, players: extra })));
  }

  /** The things that get their own clock: one per selected search, plus a
   * pseudo-entry for hand-typed players when no search is selected. */
  function watchEntries() {
    const out = watchPresets().map((p) => ({ id: p.id, label: p.label, preset: p }));
    if (!out.length && WATCH.extra.length)
      out.push({ id: "__extra", label: "typed players", preset: null });
    return out;
  }

  /** A fresh random wait in [7, 15] minutes, re-rolled every time that search
   * runs — a metronome is the easiest thing about a bot to spot, and Real's own
   * listings turn over on a human-ish cadence anyway. */
  function watchWaitMs() {
    const lo = Math.min(WATCH_CAPS.maxIntervalMin,
      Math.max(WATCH_CAPS.minIntervalMin, Math.round(Number(WATCH.intervalMin) || 7)));
    const hi = Math.max(lo, Math.min(WATCH_CAPS.maxIntervalMin,
      Math.round(Number(WATCH.intervalMax) || 15)));
    return (lo + Math.floor(Math.random() * (hi - lo + 1))) * 60000;
  }
  const watchBreathMs = () => {
    const lo = WATCH_CAPS.breathMinS, hi = WATCH_CAPS.breathMaxS;
    return (lo + Math.floor(Math.random() * (hi - lo + 1))) * 1000;
  };

  /** The entry that is due soonest — the runner never cares about order, only
   * about whose clock has run down first. */
  function watchEarliest(entries) {
    let best = null;
    for (const e of entries) {
      const t = Number(WATCH.next[e.id]) || 0;
      if (!best || t < best.t) best = { entry: e, t };
    }
    return best;
  }

  const watchTimerClear = () => {
    if (WATCH.timer) { clearTimeout(WATCH.timer); WATCH.timer = null; }
  };

  /** One tick: work out whose turn is next, arm a timer for it, and fire it when
   * the wait is over. Deliberately the ONLY place that starts a scan — so a
   * search that becomes due while another is running just waits in the map
   * instead of racing it. */
  function watchTick() {
    watchTimerClear();
    if (!WATCH.on) { WATCH.nextAt = 0; WATCH.nextLabel = ""; saveWatch(); render(); return; }
    if (WATCH.phase === "running") return;      // never two at once
    if (S.stop) { watchStop("STOP pressed."); return; }
    const entries = watchEntries();
    if (!entries.length) { watchStop("nothing selected to search."); return; }
    // A search that has no clock yet (just added to a running watch) gets one.
    for (const e of entries) if (!Number(WATCH.next[e.id])) WATCH.next[e.id] = Date.now() + watchWaitMs();
    for (const id of Object.keys(WATCH.next))
      if (!entries.some((e) => e.id === id)) delete WATCH.next[id];   // removed while armed
    // The arming pass comes first: every selected search once, in the order it
    // was picked, 10–30 s apart. Its own clock is already ticking underneath, so
    // the first search of the pass leaves a 7–15 min gap behind it either way.
    WATCH.pass = (WATCH.pass || []).filter((id) => entries.some((e) => e.id === id));
    const queued = WATCH.pass.length
      ? entries.find((e) => e.id === WATCH.pass[0]) : null;
    const due = queued ? { entry: queued, t: Date.now() } : watchEarliest(entries);
    const now = Date.now();
    const floor = WATCH.lastEndAt ? WATCH.lastEndAt + WATCH.breathMs : 0;
    const at = Math.max(Number(due.t) || 0, floor);
    WATCH.nextAt = at || now;
    WATCH.nextLabel = due.entry.label;
    saveWatch();
    const wait = at - now;
    if (wait > 250) {
      WATCH.timer = setTimeout(() => { WATCH.timer = null; watchTick(); }, wait);
      render();
      return;
    }
    watchRun(due.entry);
  }

  /** Run one search, then put its own clock forward and hand the tick back. The
   * `finally` is the invariant that matters: `phase` is cleared and the next
   * tick is armed even if the scan threw. */
  /** Opened from the list — the row goes purple and stays purple. Persisted, so
   * the marker survives the reload that following errands usually needs. */
  function markSeen(id) {
    if (id == null) return;
    if (WATCH.seen.includes(id)) return;
    WATCH.seen.push(id);
    watchDirty++;
    saveWatch();
    render();
  }
  // The pop-out lives in its own window; it can only reach the state through
  // the opener, so leave a door open for it.
  try { window.__walkrWatchSeen = markSeen; } catch (_) {}

  /** Rows grouped by the scan that found them: newest batch first, and best
   * rax-per-rating first inside each batch. That is the order a sweep reads in —
   * "what just appeared" before "what was always there, cheapest". */
  function watchGroups() {
    const byBatch = new Map();
    for (const r of WATCH.results) {
      const b = Number(r.batch) || 0;
      if (!byBatch.has(b)) byBatch.set(b, []);
      byBatch.get(b).push(r);
    }
    return [...byBatch.keys()]
      .sort((a, b) => b - a)
      .map((batch) => {
        const rows = byBatch.get(batch).slice().sort((x, y) => x.rpr - y.rpr);
        const at = rows.reduce((t, r) => Math.min(t, Number(r.seenAt) || Infinity), Infinity);
        return { batch, rows, at: Number.isFinite(at) ? at : 0 };
      });
  }
  const batchLabel = (g) => {
    const t = g.at ? new Date(g.at) : null;
    const when = t ? t.toLocaleTimeString("en-GB", { hour12: false }) : "earlier";
    return `scan ${when} \u00b7 ${g.rows.length} card${g.rows.length === 1 ? "" : "s"}`;
  };

  async function watchRun(entry) {
    WATCH.phase = "running";
    WATCH.cycle++;
    WATCH.lastSearch = entry.label;
    const targets = watchTargets(entry.preset);
    const ceiling = Math.max(1, Math.round(Number(WATCH.factor) || 21));
    const players = targets.reduce((n, t) => n + (t.players || []).length, 0);
    wlog(`search running — ${entry.label} · ${players} player(s) · ×${ceiling} · cycle ${WATCH.cycle}`);
    render();
    const t0 = Date.now();
    let found = [];
    scanCeiling = ceiling;
    try {
      // The per-player chatter rides in the log for a bid run; here the console
      // only wants the search line, what it found, and anything that failed.
      found = await scan(targets, (s) => { if (/^!/.test(s)) wlog(s); }, { watch: true });
    } catch (e) {
      wlog(`! search failed: ${e.message || e}`);
    } finally {
      scanCeiling = null;
      WATCH.phase = "idle";
      WATCH.lastEndAt = Date.now();
      WATCH.breathMs = watchBreathMs();
      WATCH.next[entry.id] = Date.now() + watchWaitMs();
      WATCH.pass = (WATCH.pass || []).filter((id) => id !== entry.id);
    }
    if (!WATCH.on) { saveWatch(); render(); return; }
    const added = watchMerge(found);
    const secs = Math.round((Date.now() - t0) / 1000);
    const gap = Math.max(1, Math.round((WATCH.next[entry.id] - Date.now()) / 60000));
    wlog(`${entry.label}: ${found.length} live listing(s) at or under ${ceiling} rax/rating · ` +
      `${added} new · ${WATCH.results.length} on the list · ${secs}s · back in ${gap} min`);
    saveWatch();
    watchTick();
  }

  function watchStop(reason) {
    watchTimerClear();
    const was = WATCH.on;
    WATCH.on = false;
    WATCH.phase = "idle";
    WATCH.nextAt = 0;
    WATCH.nextLabel = "";
    if (was) wlog(`watch stopped — ${reason}`);
    saveWatch();
    render();
  }

  function timeLeft(endsAt) {
    if (!endsAt) return "";
    const ms = Date.parse(endsAt) - Date.now();
    if (!Number.isFinite(ms)) return "";
    if (ms <= 0) return "ended";
    const m = Math.floor(ms / 60000);
    if (m < 60) return `${m}m left`;
    return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m left`;
  }

  /** Fold this cycle's findings into the list: drop anything whose auction has
   * ended, add what is new, keep it cheapest-rax-per-rating first, cap the row
   * count so a night of cycles can't grow an unusable list. */
  function watchMerge(found) {
    const now = Date.now();
    const keep = WATCH.results.filter((r) => !(r.endsAt && Date.parse(r.endsAt) <= now));
    let added = 0;
    WATCH.batch = (Number(WATCH.batch) || 0) + 1;
    for (const f of found) {
      if (keep.some((r) => r.listingId === f.listingId)) continue;
      keep.push({ ...f, seenAt: now, batch: WATCH.batch });
      added++;
    }
    keep.sort((a, b) => a.rpr - b.rpr);
    WATCH.results = keep.slice(0, WATCH_CAPS.maxResults);
    watchDirty++;
    return added;
  }

  function watchArm() {
    if (WATCH.on) { watchStop("disarmed."); return; }
    const picks = watchPresets();
    if (!picks.length && !WATCH.extra.length) {
      wlog("pick a quick search (or type some players) before arming.");
      render();
      return;
    }
    // "auto" only has sports to inherit when a saved search is carrying them.
    if (!picks.length && WATCH.sport === "auto") {
      wlog("typed players need a sport — pick one in \"their sport\" (auto follows the saved searches).");
      render();
      return;
    }
    WATCH.on = true;
    WATCH.cycle = 0;
    WATCH.results = [];
    WATCH.seen = [];
    WATCH.batch = 0;
    WATCH.logLines = [];
    WATCH.phase = "idle";
    WATCH.lastEndAt = 0;
    WATCH.breathMs = 0;
    watchDirty++;
    watchLogRendered = -1;
    S.stop = false;                       // a STOP from a bid run mustn't kill this
    const entries = watchEntries();
    // The arming pass runs every search once, back to back; each also gets its
    // own 7–15 min clock, so the steady state starts from the moment the pass
    // ends instead of everything coming due at once.
    WATCH.next = {};
    for (const e of entries) WATCH.next[e.id] = Date.now() + watchWaitMs();
    WATCH.pass = entries.map((e) => e.id);
    const names = entries.map((e) => e.label).join(" + ") || "typed players";
    wlog(`watch armed — ${names}` +
      (WATCH.extra.length ? ` + ${WATCH.extra.length} hand-typed name(s)` : "") +
      ` · first pass all ${entries.length} now, ${WATCH_CAPS.breathMinS}\u2013${WATCH_CAPS.breathMaxS} s apart · ` +
      `then each every ${WATCH.intervalMin}\u2013${WATCH.intervalMax} min, one at a time · ` +
      `ceiling ×${Math.max(1, Math.round(Number(WATCH.factor) || 21))}`);
    if (entries.length) wlog(`first pass: ${entries.map((e) => e.label).join(" \u2192 ")}`);
    saveWatch();
    watchTick();
  }

  function watchResume() {
    const s = loadWatch();
    if (!s) return;
    WATCH.presetIds = Array.isArray(s.presetIds) ? s.presetIds.filter((id) => PRESETS.some((p) => p.id === id)) : [];
    WATCH.extra = Array.isArray(s.extra) ? s.extra : [];
    WATCH.sport = s.sport || "auto";
    WATCH.factor = Number(s.factor) || 21;
    WATCH.results = Array.isArray(s.results) ? s.results : [];
    WATCH.logLines = Array.isArray(s.logLines) ? s.logLines : [];
    WATCH.cycle = Number(s.cycle) || 0;
    WATCH.next = s.next && typeof s.next === "object" ? { ...s.next } : {};
    WATCH.batch = Number(s.batch) || 0;
    WATCH.seen = Array.isArray(s.seen) ? s.seen.map(Number).filter((n) => Number.isFinite(n)) : [];
    WATCH.intervalMin = Number(s.intervalMin) || WATCH_CAPS.defaultIntervalMin;
    WATCH.intervalMax = Number(s.intervalMax) || WATCH_CAPS.defaultIntervalMax;
    WATCH.pass = Array.isArray(s.pass) ? s.pass : [];
    WATCH.lastEndAt = Number(s.lastEndAt) || 0;
    WATCH.breathMs = Number(s.breathMs) || 0;
    WATCH.phase = "idle";
    watchDirty++;
    if (!s.on) return;
    WATCH.on = true;
    // A reload must not turn the cadence into a hammer: anything that came due
    // while the page was down is pushed 20–70 s out, and the rest keep their
    // clocks, so the stagger survives the reload.
    const now = Date.now();
    for (const id of Object.keys(WATCH.next))
      if (!Number(WATCH.next[id]) || Number(WATCH.next[id]) < now + 20000)
        WATCH.next[id] = now + 20000 + Math.floor(Math.random() * 50000);
    watchTick();
  }

  // ── UI ───────────────────────────────────────────────────────────────────
  let panel, logEl, statusEl, sportEl, playersEl, quickEl, liveEl, capsEl, chipsEl, presetChipsEl, lastBtnEl;
  let intervalEl, intervalMaxEl, allowanceEl, primerEl, loopEl, loopBtnEl;
  let ceilEl, miniEl;
  let watchEl, watchChipsEl, watchPlayersEl, watchSportEl, watchFactorEl, watchArmEl,
    watchStatusEl, watchConsoleEl, watchListEl, watchCountEl, watchEveryMinEl, watchEveryMaxEl;
  /** boot() runs two or three times (readyState, DOMContentLoaded, load) — the
   * loop must only be resumed once, or every pass would arm another timer. */
  let loopResumed = false;
  /** Same for the watch: one resume, one timer. */
  let watchResumed = false;
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
    head.innerHTML = `<b style="flex:1">Walkr Autobid</b>` +
      `<span title="installed version — compare with the repo" style="color:#7f93b0">v${RUNNING_VERSION}</span>`;
    // Fold the whole panel back into the little "Walkr's Menu" box. Always
    // available, including mid-run: nothing stops, it just gets out of the way.
    head.appendChild(btn("\u2013", () => hidePanel(), "padding:2px 8px;font-weight:700;"));
    // STOP is the kill switch for whatever is running — a single run and an
    // armed loop both. It also clears the loop's stored state, so a reload
    // after pressing it doesn't quietly re-arm the thing.
    head.appendChild(btn("STOP", () => {
      S.stop = true;
      const watching = WATCH.on;
      if (watching) watchStop("STOP pressed.");
      if (LOOP.on || LOOP.phase !== "idle") loopStop("STOP pressed.");
      else if (!watching) logLine("STOP pressed.");
    }, "background:#c0392b;color:#fff;font-weight:700;"));
    makeDraggable(panel, head);

    /** Three panes behind a tab strip. The search is the thing that changes
     * between runs, the loop is a set-once thing, and Consistent is a different
     * job entirely (watch, don't bid) — side by side they made the panel noisy.
     * The strip sits inside the same scrolling block as the panes, so the log
     * still gets the slack. */
    const cfg = document.createElement("div");
    cfg.style.cssText = "border-bottom:1px solid #2a3a55;flex:0 1 auto;min-height:0;overflow:auto";
    const paneCss = "padding:8px 10px;display:grid;grid-template-columns:auto 1fr;gap:5px 8px;align-items:center";
    const paneSetup = document.createElement("div");
    paneSetup.style.cssText = paneCss;
    const paneLoop = document.createElement("div");
    paneLoop.style.cssText = paneCss + ";display:none";
    const paneWatch = document.createElement("div");
    paneWatch.style.cssText = paneCss + ";display:none";
    const panes = [
      { id: "bid", label: "Search", el: paneSetup },
      { id: "loop", label: "Loop", el: paneLoop },
      { id: "watch", label: "Consistent", el: paneWatch },
    ];
    const paneBtns = {};
    /** Filled in further down; showPane runs before them, so it has to tolerate
     * the bid run's chrome not existing yet. */
    let barEl = null;
    /** Opens on the watcher — that is what the folded box is for — and keeps
     * whichever tab was last looked at while the panel stays open. */
    let activePane = "watch";
    const showPane = (id) => {
      activePane = id;
      for (const p of panes) {
        p.el.style.display = p.id === id ? "grid" : "none";
        const b = paneBtns[p.id];
        if (!b) continue;
        const on = p.id === id;
        b.style.background = on ? "#26405f" : "#1a2b45";
        b.style.borderColor = on ? "#3f6699" : "#2a3a55";
        b.style.color = on ? "#ffffff" : "#cfe0f7";
      }
      // The bid run's own furniture — Run / Bid these / Clear log, the caps and
      // credential readout, and the shared log — is noise on the watch tab and
      // eats the height its list wants. Each tab shows only its own data.
      const watching = id === "watch";
      if (barEl) barEl.style.display = watching ? "none" : "flex";
      if (statusEl) statusEl.style.display = watching ? "none" : "block";
      if (logEl) logEl.style.display = watching ? "none" : "block";
      cfg.style.flex = watching ? "1 1 auto" : "0 1 auto";
      render();
    };
    const tabBar = document.createElement("div");
    tabBar.style.cssText = "display:flex;gap:6px;padding:6px 10px;border-bottom:1px solid #2a3a55;background:#0e1728";
    for (const p of panes) {
      paneBtns[p.id] = btn(p.label, () => showPane(p.id), "padding:3px 10px;");
      tabBar.appendChild(paneBtns[p.id]);
    }
    showPane(activePane);

    quickEl = document.createElement("select");
    // A single dropdown that ADDS: pick a lineup and it becomes a bubble below,
    // pick another and both run off the one allowance. (The old
    // <select multiple> needed ctrl-click and reported only its first value.)
    quickEl.title = "pick a lineup to add it to this run — each one becomes a bubble underneath";
    quickEl.appendChild(opt("", "— add a lineup —"));
    for (const p of PRESETS) quickEl.appendChild(opt(p.id, p.label));
    quickEl.style.cssText = selCss() + "width:100%;";

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

    /** The lineups this run carries, as bubbles — the × takes one back out. */
    presetChipsEl = document.createElement("div");
    presetChipsEl.style.cssText =
      "grid-column:1/-1;display:none;flex-wrap:wrap;gap:4px;align-items:center;margin:1px 0 2px";

    /** The iOS app's deal screen screens at "price under factor × the card's
     * own rating", and the factor is editable there. Same field: it overrides
     * whatever ceiling the chosen searches carry, and sticks across reloads. */
    ceilEl = document.createElement("input");
    ceilEl.type = "number";
    ceilEl.min = "1";
    ceilEl.max = "100";
    ceilEl.step = "1";
    ceilEl.value = String(effectiveMaxRpr());
    ceilEl.title =
      "rax/rating ceiling for a bid run — the iOS deal screen's factor. Blank/" +
      "unchanged means whatever the chosen searches carry (they ship 21).";
    ceilEl.style.cssText = "width:64px;" + selCss();
    ceilEl.onchange = () => {
      const v = Math.min(100, Math.max(1, Math.round(Number(ceilEl.value) || 0)));
      if (!v) { ceilEl.value = String(effectiveMaxRpr()); return; }
      factorOverride = v;
      try { localStorage.setItem(FACTOR_KEY, String(v)); } catch (_) {}
      ceilEl.value = String(v);
      render();
    };
    /** ...and a way back: an override is persisted, so without this a single
     * edit would pin the ceiling forever and the searches' own 21 could never
     * take over again. */
    const ceilWrap = document.createElement("div");
    ceilWrap.style.cssText = "display:flex;gap:6px;align-items:center";
    ceilWrap.append(ceilEl, btn("follow searches", () => {
      factorOverride = null;
      try { localStorage.removeItem(FACTOR_KEY); } catch (_) {}
      render();
    }, "font-size:11px;padding:2px 8px;"));

    capsEl = document.createElement("div");
    capsEl.style.cssText = "grid-column:1/-1;color:#9fb3d1";
    liveEl = document.createElement("label");
    liveEl.style.cssText = "grid-column:1/-1;display:flex;gap:6px;align-items:center;color:#ffb4a2";
    liveEl.innerHTML = '<input type="checkbox"> LIVE (actually bid — spends rax)';
    liveEl.querySelector("input").onchange = (e) => { DEFAULTS.live = e.target.checked; render(); };

    /* ── Consistent: the watch list (nothing here bids) ─────────────────── */
    watchEl = document.createElement("select");
    watchEl.title = "add a saved search to the watch — each pick becomes a bubble";
    watchEl.appendChild(opt("", "— add a search to watch —"));
    for (const p of PRESETS) watchEl.appendChild(opt(p.id, p.label));
    watchEl.style.cssText = selCss() + "width:100%;";
    watchEl.onchange = () => {
      const pick = watchEl.value;
      watchEl.value = "";
      if (!pick) return;
      if (!WATCH.presetIds.includes(pick)) {
        WATCH.presetIds.push(pick);
        if (WATCH.on) {
          // A search added mid-watch gets its own clock AND a turn in the pass,
          // so it is scanned within seconds instead of waiting up to 15 minutes.
          WATCH.next[pick] = Date.now() + watchWaitMs();
          WATCH.pass.push(pick);
          watchTick();
        }
      }
      saveWatch();
      render();
    };

    watchChipsEl = document.createElement("div");
    watchChipsEl.style.cssText =
      "grid-column:1/-1;display:none;flex-wrap:wrap;gap:4px;align-items:center;margin:1px 0 2px";

    watchPlayersEl = document.createElement("input");
    watchPlayersEl.placeholder = "extra players, comma separated (optional)";
    watchPlayersEl.style.cssText =
      "background:#0b1120;color:#e6edf7;border:1px solid #2a3a55;border-radius:5px;padding:3px 6px;width:100%";
    watchPlayersEl.oninput = () => {
      WATCH.extra = watchPlayersEl.value.split(",").map((s) => s.trim()).filter(Boolean);
      saveWatch();
      render();
    };

    watchSportEl = document.createElement("select");
    watchSportEl.title =
      "which sport the hand-typed names belong to — auto keeps every sport/season the chosen searches already cover";
    watchSportEl.appendChild(opt("auto", "auto (from the searches)"));
    for (const s of ALL_SPORTS) watchSportEl.appendChild(opt(s, s));
    watchSportEl.style.cssText = selCss();
    watchSportEl.onchange = () => {
      WATCH.sport = watchSportEl.value;
      saveWatch();
      render();
    };

    watchFactorEl = document.createElement("input");
    watchFactorEl.type = "number";
    watchFactorEl.min = "1";
    watchFactorEl.max = "100";
    watchFactorEl.step = "1";
    watchFactorEl.value = String(WATCH.factor);
    watchFactorEl.title = "rax/rating ceiling for the watch — 21 is the iOS app's default factor";
    watchFactorEl.style.cssText = "width:64px;" + selCss();
    watchFactorEl.onchange = () => {
      WATCH.factor = Math.min(100, Math.max(1, Math.round(Number(watchFactorEl.value) || 21)));
      watchFactorEl.value = String(WATCH.factor);
      saveWatch();
      render();
    };

    /** The per-search clock, editable — 7–15 min by default. */
    watchEveryMinEl = document.createElement("input");
    watchEveryMinEl.type = "number";
    watchEveryMinEl.min = String(WATCH_CAPS.minIntervalMin);
    watchEveryMinEl.max = String(WATCH_CAPS.maxIntervalMin);
    watchEveryMinEl.step = "1";
    watchEveryMinEl.value = String(WATCH.intervalMin);
    watchEveryMinEl.title = "shortest gap between one search's own runs, in minutes";
    watchEveryMinEl.style.cssText = "width:56px;" + selCss();
    watchEveryMaxEl = document.createElement("input");
    watchEveryMaxEl.type = "number";
    watchEveryMaxEl.min = String(WATCH_CAPS.minIntervalMin);
    watchEveryMaxEl.max = String(WATCH_CAPS.maxIntervalMin);
    watchEveryMaxEl.step = "1";
    watchEveryMaxEl.value = String(WATCH.intervalMax);
    watchEveryMaxEl.title =
      "longest gap between one search's own runs — each run re-rolls a random gap in the range. " +
      "Two runs of the same search inside 15 minutes needs a max of 7.";
    watchEveryMaxEl.style.cssText = "width:56px;" + selCss();
    const everyRow = document.createElement("div");
    everyRow.style.cssText = "display:flex;gap:6px;align-items:center";
    everyRow.append(watchEveryMinEl, labeled("\u2013"), watchEveryMaxEl, labeled("min each"));
    const applyEvery = () => {
      const clamp = (v, d) => Math.min(WATCH_CAPS.maxIntervalMin,
        Math.max(WATCH_CAPS.minIntervalMin, Math.round(Number(v) || d)));
      WATCH.intervalMin = clamp(watchEveryMinEl.value, WATCH_CAPS.defaultIntervalMin);
      WATCH.intervalMax = Math.max(WATCH.intervalMin,
        clamp(watchEveryMaxEl.value, WATCH_CAPS.defaultIntervalMax));
      watchEveryMinEl.value = String(WATCH.intervalMin);
      watchEveryMaxEl.value = String(WATCH.intervalMax);
      saveWatch();
      render();
    };
    watchEveryMinEl.onchange = applyEvery;
    watchEveryMaxEl.onchange = applyEvery;

    watchArmEl = btn("Arm watch", () => watchArm(), "background:#26364f;color:#dce8f8;");
    watchStatusEl = document.createElement("div");
    watchStatusEl.style.cssText = "color:#9fb3d1";

    /** The console: one line per event, timestamped — "search running", what it
     * found, what failed, when the next sweep is due. */
    watchConsoleEl = document.createElement("div");
    watchConsoleEl.style.cssText =
      "grid-column:1/-1;height:96px;overflow:auto;background:#080d18;border:1px solid #22304a;" +
      "border-radius:6px;padding:4px 6px;white-space:pre-wrap;color:#9fb3d1;font-size:11px;line-height:1.35";

    /** The buy list: one button per listing, cheapest rax-per-rating first. */
    watchCountEl = document.createElement("div");
    watchCountEl.style.cssText =
      "grid-column:1/-1;display:flex;gap:6px;align-items:center;color:#9fb3d1;padding-top:2px";
    watchListEl = document.createElement("div");
    watchListEl.style.cssText =
      "grid-column:1/-1;display:flex;flex-direction:column;gap:3px;max-height:220px;overflow:auto";

    const watchNote = document.createElement("div");
    watchNote.style.cssText = "grid-column:1/-1;color:#7f93b0";
    watchNote.textContent =
      "Runs ONE of the chosen searches every random 8–11 min and keeps what clears the ceiling. " +
      "Nothing is bid: a row opens that listing's buy screen in a new tab.";

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
      labeled("every"), intervalEl, labeled("\u2013"), intervalMaxEl, labeled("min \u00b7 "),
      labeled("allowance"), allowanceEl, labeled("rax"),
      primerLbl, loopBtnEl,
      btn("Reset allowance", () => {
        LOOP.committed = 0;
        LOOP.cards = 0;
        LOOP.pending = [];
        saveLoop();
        logLine(`loop: allowance reset — ${fmtRax(LOOP.allowance)} rax available again, 0 cards bid.`);
        render();
      }),
      btn("Primer report", () => primerReport()),
    );
    loopEl = document.createElement("div");
    loopEl.style.cssText = "grid-column:1/-1;color:#9fb3d1";

    const loopNote = document.createElement("div");
    loopNote.style.cssText = "grid-column:1/-1;color:#7f93b0";
    loopNote.textContent =
      "Runs the chosen lineups on a timer off one rax allowance. A bid that somebody outbids hands its " +
      "rax back once its 10-minute window has closed. Hard stops: allowance \u00b7 72 cycles \u00b7 24 h \u00b7 3 failed cycles \u00b7 STOP.";

    cfg.append(tabBar, paneSetup, paneLoop, paneWatch);
    paneSetup.append(labeled("Quick Search"), quickEl, presetChipsEl,
      labeled("Sport"), sportEl, labeled("Players"), playersEl, chipsEl,
      labeled("Bid ceiling"), ceilWrap, capsEl, liveEl);
    paneLoop.append(loopNote, loopRow, loopEl);
    paneWatch.append(watchNote,
      labeled("Quick Search"), watchEl, watchChipsEl,
      labeled("Extra players"), watchPlayersEl,
      labeled("Their sport"), watchSportEl,
      labeled("Watch ceiling"), watchFactorEl,
      labeled("Every"), everyRow,
      watchArmEl, watchStatusEl,
      labeled("Console"), watchConsoleEl,
      watchCountEl, watchListEl);

    quickEl.onchange = () => {
      hashPlan = null;   // a manual pick overrides a menu handoff
      excluded.clear();  // picking a lineup restores every player it lists
      const pick = quickEl.value;
      quickEl.value = "";            // the dropdown adds, it does not hold a value
      if (pick) addPreset(pick);
      applySelection();
    };
    sportEl.onchange = () => { hashPlan = null; setSelectedPresets([]); excluded.clear(); playersEl.disabled = false; render(); };
    playersEl.oninput = () => { if (playersEl.value.trim()) { hashPlan = null; setSelectedPresets([]); excluded.clear(); } render(); };

    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;gap:6px;padding:8px 10px;flex-wrap:wrap;flex:0 0 auto";
    barEl = bar;
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

    /** The folded state: one small box, and it is what the page starts with.
     * Clicking it opens the panel; the header's dash folds it back. Nothing is
     * persisted about being open, on purpose — a reload always lands on the box,
     * so the panel never reappears in the middle of the marketplace. */
    miniEl = document.createElement("div");
    miniEl.textContent = "Walkr's Menu";
    miniEl.title = "open Walkr's Menu";
    miniEl.setAttribute("role", "button");
    miniEl.setAttribute("tabindex", "0");
    miniEl.style.cssText = [
      "position:fixed", "right:14px", "bottom:14px", "z-index:2147483647",
      "display:flex", "align-items:center", "gap:6px",
      "padding:8px 13px", "background:#111c30", "color:#e6edf7",
      "border:1px solid #2a3a55", "border-radius:9px", "cursor:pointer",
      "font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace",
      "box-shadow:0 6px 18px rgba(0,0,0,.45)", "user-select:none",
    ].join(";");
    miniEl.onclick = () => showPanel();
    miniEl.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showPanel(); } };
    panel.style.display = "none";
    // A remembered size re-opens the panel exactly as it was left.
    const saved = storedSize();
    if (saved) {
      panel.style.width = saved.w + "px";
      panel.style.height = saved.h + "px";
      panel.style.maxHeight = "none";
    }
    window.addEventListener("resize", clampPanel);
    mount(panel);
    mount(miniEl);
    if (hashPlan && hashPlan.label) {
      const match = PRESETS.find((p) => p.label === hashPlan.label);
      if (match) { setSelectedPresets([match.id]); sportEl.value = match.sport; playersEl.disabled = true; }
    }
    lastBtn();
    showPane(activePane);   // now that the bid chrome exists, apply its visibility
    render();
  }

  const selCss = () => "background:#0b1120;color:#e6edf7;border:1px solid #2a3a55;border-radius:5px;padding:2px 4px";

  function mount(el) {
    const host = document.body || document.documentElement;
    if (host) host.appendChild(el);
  }

  /** Fold out / fold back. Neither touches timers — a watch or a loop keeps
   * running while the panel is a box in the corner. */
  function showPanel() {
    if (!panel || !miniEl) return;
    miniEl.style.display = "none";
    panel.style.display = "flex";
    clampPanel();
    render();
  }
  function hidePanel() {
    if (!panel || !miniEl) return;
    panel.style.display = "none";
    miniEl.style.display = "flex";
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

  /** The searches the watch is carrying, as bubbles with their own × — same
   * pattern as the bid run's lineup chips, kept separate on purpose so picking
   * something to watch never edits what the next bid run would buy. */
  function renderWatchChips() {
    if (!watchChipsEl) return;
    watchChipsEl.textContent = "";
    const ps = watchPresets();
    if (!ps.length) { watchChipsEl.style.display = "none"; return; }
    watchChipsEl.style.display = "flex";
    for (const p of ps) {
      const chip = document.createElement("span");
      chip.style.cssText = "display:inline-flex;align-items:center;gap:3px;padding:1px 2px 1px 8px;" +
        "border-radius:999px;border:1px solid #3a5a8a;background:#152744;color:#dbe9ff";
      const nm = document.createElement("span");
      nm.textContent = p.label;
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "\u00d7";
      x.title = `stop watching ${p.label}`;
      x.setAttribute("aria-label", `remove ${p.label}`);
      x.style.cssText =
        "background:none;border:0;color:inherit;cursor:pointer;font:inherit;padding:0 4px;line-height:1.1";
      x.onclick = () => {
        WATCH.presetIds = WATCH.presetIds.filter((id) => id !== p.id);
        saveWatch();
        render();
      };
      chip.append(nm, x);
      watchChipsEl.appendChild(chip);
    }
  }

  /** One listing → the button that opens its buy screen. The row carries what
   * the decision needs (price, rax/rating, rarity, how it is priced, how long is
   * left); the click is the only thing that can spend. */
  function watchRow(r) {
    const row = document.createElement("button");
    row.type = "button";
    row.style.cssText = "display:flex;gap:8px;align-items:center;width:100%;text-align:left;" +
      "background:#122036;color:#cfe0f7;border:1px solid #2f4a72;border-radius:6px;" +
      "padding:3px 7px;cursor:pointer;font:inherit;font-size:11px";
    const left = document.createElement("span");
    left.style.flex = "1";
    left.textContent = `${SPORT_LABEL[r.sport] || r.sport} \u00b7 ${r.player} \u00b7 ` +
      `${RARITY_LABEL[r.rarity] || `r${r.rarity}`} \u00b7 ${fmtRax(r.price)} rax ` +
      `(${fmtR(r.rpr)} rpr \u00b7 rating ${fmtR(r.rating)})`;
    const right = document.createElement("span");
    right.style.cssText = "color:#8fb0dd;white-space:nowrap";
    right.textContent = [r.how, timeLeft(r.endsAt)].filter(Boolean).join(" \u00b7 ");
    const seen = WATCH.seen.includes(r.listingId);
    if (seen) {
      row.style.borderColor = "#a855f7";
      row.style.boxShadow = "inset 0 0 0 1px #a855f7";
    }
    row.title = `open #${r.listingId} in a new tab — the buy screen for this listing` +
      (seen ? " (already opened)" : "");
    row.append(left, right);
    row.onclick = () => {
      WATCH.last = r.listingId;
      markSeen(r.listingId);
      wlog(`opened ${r.player} #${r.listingId} (${fmtRax(r.price)} rax) — buy screen in a new tab`);
      render();
      window.open(r.url, "_blank", "noopener,noreferrer");
    };
    return row;
  }

  /** The list in its own window — same rows, same order — so the buy decisions
   * can sit on a second monitor while the panel stays on whatever tab you were
   * using. It is read-only: adding, clearing and arming stay in the panel, and
   * every row is a plain link, so nothing in that window can spend by itself. */
  let listWin = null;
  const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function renderListWindow() {
    if (!listWin) return;
    if (listWin.closed) { listWin = null; return; }
    let doc;
    try { doc = listWin.document; } catch (_) { listWin = null; return; }
    if (!doc || !doc.body) return;
    // Grouped by the scan that found them — newest batch on top, best value
    // first inside it, so a fresh sweep reads before the older stock.
    const rows = watchGroups().map((g) => {
      const head = `<div class="group">${escHtml(batchLabel(g))}</div>`;
      const body = g.rows.map((r) => {
        const left = escHtml(
          `${SPORT_LABEL[r.sport] || r.sport} \u00b7 ${r.player} \u00b7 ` +
          `${RARITY_LABEL[r.rarity] || `r${r.rarity}`} \u00b7 ${fmtRax(r.price)} rax ` +
          `(${fmtR(r.rpr)} rpr \u00b7 rating ${fmtR(r.rating)})`);
        const right = escHtml([r.how, timeLeft(r.endsAt)].filter(Boolean).join(" \u00b7 "));
        const seen = WATCH.seen.includes(r.listingId);
        return `<a class="row${seen ? " seen" : ""}" data-id="${escHtml(r.listingId)}"` +
          ` href="${escHtml(r.url)}" target="_blank" rel="noopener noreferrer">` +
          `<span class="l">${left}</span><span class="r">${right}</span></a>`;
      }).join("");
      return head + body;
    }).join("");
    doc.title = `Walkr watch \u00b7 ${WATCH.results.length}`;
    doc.body.innerHTML =
      `<style>
        html,body{margin:0;background:#0b1120;color:#e6edf7;
          font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
        header{position:sticky;top:0;display:flex;gap:8px;align-items:baseline;
          padding:10px 12px;background:#111c30;border-bottom:1px solid #2a3a55}
        h1{font-size:13px;margin:0;flex:1;font-weight:600}
        .meta{color:#7f93b0;font-size:11px}
        main{display:flex;flex-direction:column;gap:5px;padding:10px 12px}
        .row{display:flex;gap:10px;align-items:center;padding:7px 9px;border-radius:7px;
          background:#122036;border:1px solid #2f4a72;color:#cfe0f7;text-decoration:none}
        .row:hover{border-color:#4a7ab8;background:#16294a}
        .l{flex:1}.r{color:#8fb0dd;white-space:nowrap;font-size:11px}
        .group{color:#7f93b0;font-size:10.5px;letter-spacing:.03em;padding:6px 2px 0}
        .row.seen{border-color:#a855f7;box-shadow:inset 0 0 0 1px #a855f7}
        .empty{color:#7f93b0;padding:10px 2px}
        footer{color:#5d6f8a;font-size:11px;padding:0 12px 12px}
      </style>
      <header><h1>Walkr watch \u00b7 ${WATCH.results.length} listing(s)</h1>
        <span class="meta">${WATCH.on ? "watching" : "disarmed"} \u00b7
        ${hhmmss()}</span></header>
      <main>${rows || '<div class="empty">nothing on the list yet</div>'}</main>
      <footer>Click a row to open its buy screen in a new tab \u2014 opened rows get
        a purple outline. The list is managed in the Walkr Autobid panel.</footer>`;
    // innerHTML can't run a script, so the mark-as-opened listener is attached
    // here: the row goes purple at once, and the panel is told so the outline
    // (and a reload) keeps it.
    for (const a of doc.querySelectorAll("a.row")) {
      a.addEventListener("click", () => {
        const id = Number(a.getAttribute("data-id"));
        a.classList.add("seen");
        // Let the new tab open before the parent re-renders this document —
        // rewriting the body inside the click can eat the default action.
        setTimeout(() => {
          try {
            const op = (listWin && listWin.opener) || window;
            if (op && typeof op.__walkrWatchSeen === "function") op.__walkrWatchSeen(id);
          } catch (_) {}
        }, 0);
      });
    }
  }

  function watchPopOut() {
    try {
      if (listWin && !listWin.closed) { listWin.close(); listWin = null; watchDirty++; render(); return; }
      listWin = window.open("", "walkr-watch-list", "popup,width=620,height=680");
      if (!listWin) {
        wlog("pop-out blocked — allow pop-ups for realapp.com, then try again.");
        render();
        return;
      }
      renderListWindow();
      try { listWin.focus(); } catch (_) {}
      watchDirty++;      // the button label lives in the (otherwise cached) list block
      render();
    } catch (e) {
      wlog(`! pop-out failed: ${e.message || e}`);
      render();
    }
  }

  /** The watch pane: status, console, and the list. The console and the list are
   * only rebuilt when they actually changed — render() runs once a second and
   * rebuilding eighty buttons on every tick is how a panel starts to stutter. */
  function renderWatch() {
    if (!watchListEl) return;
    const entries = watchEntries();
    const names = entries.map((e) => e.label).join(" + ");
    const now = Date.now();
    const schedule = entries
      .map((e) => ({ label: e.label, t: Number(WATCH.next[e.id]) || 0 }))
      .filter((x) => x.t && x.label !== WATCH.lastSearch)
      .sort((a, b) => a.t - b.t)
      .slice(0, 3)
      .map((x) => `${x.label} in ${Math.max(1, Math.ceil((x.t - now) / 60000))}m`);
    watchStatusEl.textContent = (WATCH.on ? "watch: ON" : "watch: off") +
      ` \u00b7 ${names || "nothing"}` +
      (WATCH.extra.length ? ` + ${WATCH.extra.length} typed` : "") +
      ` \u00b7 \u00d7${WATCH.factor} \u00b7 ${WATCH.results.length} on the list` +
      ` \u00b7 ${WATCH.intervalMin}\u2013${WATCH.intervalMax} min` +
      (WATCH.on ? ` \u00b7 cycle ${WATCH.cycle}` : "") +
      (WATCH.on
        ? (WATCH.phase === "running"
          ? ` \u00b7 running ${WATCH.lastSearch}`
          : schedule.length ? ` \u00b7 next ${schedule.join(" \u00b7 ")}` : "")
        : "");
    if (watchArmEl) {
      watchArmEl.textContent = WATCH.on ? "Disarm watch" : "Arm watch";
      watchArmEl.style.background = WATCH.on ? "#3b2233" : "#26364f";
    }
    if (watchLogRendered !== WATCH.logLines.length) {
      watchLogRendered = WATCH.logLines.length;
      watchConsoleEl.textContent = WATCH.logLines.join("\n");
      watchConsoleEl.scrollTop = watchConsoleEl.scrollHeight;
    }
    if (watchRendered === watchDirty) return;
    watchRendered = watchDirty;
    watchCountEl.textContent = "";
    const head = document.createElement("span");
    head.style.flex = "1";
    const n = WATCH.results.length;
    head.textContent = n
      ? `${n} listing(s) \u2014 cheapest rax/rating first`
      : "nothing on the list yet";
    watchCountEl.append(head, btn(
      listWin && !listWin.closed ? "Close window" : "Pop out list",
      () => watchPopOut(),
      "font-size:11px;padding:2px 8px;"
    ), btn("Clear list", () => {
      WATCH.results = [];
      watchDirty++;
      saveWatch();
      render();
    }, "font-size:11px;padding:2px 8px;"));
    watchListEl.textContent = "";
    for (const g of watchGroups()) {
      const head = document.createElement("div");
      head.textContent = batchLabel(g);
      head.style.cssText = "color:#7f93b0;font-size:10px;padding:3px 2px 1px;letter-spacing:.02em";
      watchListEl.appendChild(head);
      for (const r of g.rows) watchListEl.appendChild(watchRow(r));
    }
    renderListWindow();
  }

  function render() {
    if (!panel || !panel.isConnected) return;
    DEFAULTS.maxRpr = effectiveMaxRpr();
    renderChips();
    renderPresetChips();
    renderWatchChips();
    renderWatch();
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
    if (ceilEl && document.activeElement !== ceilEl) ceilEl.value = String(DEFAULTS.maxRpr);
    if (watchFactorEl && document.activeElement !== watchFactorEl) watchFactorEl.value = String(WATCH.factor);
    if (watchEveryMinEl && document.activeElement !== watchEveryMinEl) watchEveryMinEl.value = String(WATCH.intervalMin);
    if (watchEveryMaxEl && document.activeElement !== watchEveryMaxEl) watchEveryMaxEl.value = String(WATCH.intervalMax);
    if (watchSportEl && document.activeElement !== watchSportEl) watchSportEl.value = WATCH.sport;
    if (watchPlayersEl && document.activeElement !== watchPlayersEl)
      watchPlayersEl.value = WATCH.extra.join(", ");
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
    if (!watchResumed) { watchResumed = true; watchResume(); }
    if (!selfTestOk && !S.log.some((l) => l.includes("SELF-TEST"))) {
      S.log.unshift("SELF-TEST FAILED — the request-token encoder is wrong, every call will 401 as \"Malformed request\".");
      render();
    }
    setInterval(() => {
      if (panel && !panel.isConnected) mount(panel);
      if (miniEl && !miniEl.isConnected) mount(miniEl);
    }, 2000);
    setInterval(() => { if (panel && panel.isConnected) render(); }, 1000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  window.addEventListener("load", boot);
})();
