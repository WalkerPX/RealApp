// ==UserScript==
// @name         Walkr Autobid
// @namespace    walkr.realapp
// @version      0.2.8
// @description  Bids the buy-now trigger price on Real marketplace listings that clear a rax-per-rating ceiling. Dry-run by default. Hard caps. Kill switch.
// @author       walkr
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

  SAFETY
  ------
    * starts in DRY RUN: Run prints what it would bid and stops
    * three hard caps, enforced in code, not in the UI: rpr / cards / total rax
    * STOP halts immediately, between every single step
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
    {"id":"budget-nhl","label":"Optimal Budget · NHL","sport":"nhl","cards":5,"slices":[{"sport":"nhl","season":2025,"players":["Matt Boldy","Mitch Marner"]},{"sport":"nhl","season":2024,"players":["Sam Bennett","Kyle Connor"]},{"sport":"nhl","season":2023,"players":["Stuart Skinner"]}]},
    {"id":"budget-nfl","label":"Optimal Budget · NFL","sport":"nfl","cards":5,"slices":[{"sport":"nfl","season":2025,"players":["Kyren Williams","Josh Allen"]},{"sport":"nfl","season":2024,"players":["Patrick Mahomes"]},{"sport":"nfl","season":2023,"players":["C.J. Stroud","James Cook III"]}]},
    {"id":"budget-ncaam","label":"Optimal Budget · CBB","sport":"ncaam","cards":5,"slices":[{"sport":"ncaam","season":2026,"players":["Juke Harris","Chris Bell","Rob Martin"]},{"sport":"ncaam","season":2024,"players":["Al-Amir Dawes","Ben Krikke"]}]},
    {"id":"budget-mlb","label":"Optimal Budget · MLB","sport":"mlb","cards":5,"slices":[{"sport":"mlb","season":2026,"players":["Fernando Tatis Jr.","Kyle Schwarber","CJ Abrams"]},{"sport":"mlb","season":2025,"players":["Vladimir Guerrero Jr."]},{"sport":"mlb","season":2024,"players":["Pete Alonso"]}]},
    {"id":"budget-wnba","label":"Optimal Budget · WNBA","sport":"wnba","cards":5,"slices":[{"sport":"wnba","season":2026,"players":["Kelsey Mitchell","Paige Bueckers"]},{"sport":"wnba","season":2025,"players":["Chelsea Gray","Satou Sabally"]},{"sport":"wnba","season":2024,"players":["Kayla McBride"]}]},
    {"id":"budget-ncaaf","label":"Optimal Budget · CFB","sport":"ncaaf","cards":5,"slices":[{"sport":"ncaaf","season":2025,"players":["Jalen Buckley","Jordan Pollard"]},{"sport":"ncaaf","season":2024,"players":["Brashard Smith","Kyle McCord","Dillon Gabriel"]}]},
    {"id":"budget-all","label":"Optimal Budget · All Sports","sport":"all","cards":35,"slices":[{"sport":"nba","season":2026,"players":["De'Aaron Fox","James Harden"]},{"sport":"nba","season":2025,"players":["Pascal Siakam"]},{"sport":"nba","season":2024,"players":["Pascal Siakam","Kyrie Irving"]},{"sport":"nhl","season":2025,"players":["Matt Boldy","Mitch Marner"]},{"sport":"nhl","season":2024,"players":["Sam Bennett","Kyle Connor"]},{"sport":"nhl","season":2023,"players":["Stuart Skinner"]},{"sport":"nfl","season":2025,"players":["Kyren Williams","Josh Allen"]},{"sport":"nfl","season":2024,"players":["Patrick Mahomes"]},{"sport":"nfl","season":2023,"players":["C.J. Stroud","James Cook III"]},{"sport":"ncaam","season":2026,"players":["Juke Harris","Chris Bell","Rob Martin"]},{"sport":"ncaam","season":2024,"players":["Al-Amir Dawes","Ben Krikke"]},{"sport":"mlb","season":2026,"players":["Fernando Tatis Jr.","Kyle Schwarber","CJ Abrams"]},{"sport":"mlb","season":2025,"players":["Vladimir Guerrero Jr."]},{"sport":"mlb","season":2024,"players":["Pete Alonso"]},{"sport":"wnba","season":2026,"players":["Kelsey Mitchell","Paige Bueckers"]},{"sport":"wnba","season":2025,"players":["Chelsea Gray","Satou Sabally"]},{"sport":"wnba","season":2024,"players":["Kayla McBride"]},{"sport":"ncaaf","season":2025,"players":["Jalen Buckley","Jordan Pollard"]},{"sport":"ncaaf","season":2024,"players":["Brashard Smith","Kyle McCord","Dillon Gabriel"]}]},
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
  const nameKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

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
    if (rpr > DEFAULTS.maxRpr) return;
    if (found.some((f) => f.listingId === l.id)) return;
    found.push({
      listingId: l.id, sport, season, player: label, rarity: l.rarity,
      rating, price, rpr: Math.round(rpr * 100) / 100, endsAt: l.endsAt || null,
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

  /** Apply the three hard caps, and report which one did the cutting. */
  function buildPlan(candidates) {
    const plan = [];
    let spend = 0;
    let limitedBy = null;
    for (const c of candidates) {
      if (plan.length >= DEFAULTS.maxCards) { limitedBy = "card cap"; break; }
      if (spend + c.price > DEFAULTS.maxSpend) { limitedBy = limitedBy || "spend cap"; continue; }
      plan.push(c);
      spend += c.price;
    }
    return { plan, spend, limitedBy };
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

  async function executePlan(plan, log) {
    const ages = Date.now() - S.lastAt;
    if (S.lastAt && ages > DEFAULTS.planTtlMs) {
      log(`note: this plan is ${Math.round(ages / 60000)} min old — listings turn over, expect skips`);
    }
    const tokAge = credsAt["real-turnstile-token"]
      ? (Date.now() - credsAt["real-turnstile-token"]) / 1000 : Infinity;
    if (tokAge > 240) {
      log(`WARNING: the Turnstile token is ${Math.round(tokAge / 60)} min old and lives about 5 — refresh realapp.com first, or Real will reject the bids.`);
    }
    let placed = 0, committed = 0, skipped = 0;
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
        log(`BID OK #${p.listingId} ${p.player} @ ${p.price} rax · top=${li.isTopBidder} · bids=${li.numBids}`);
      } else if (skippable(r)) {
        skipped++;
        log(`skip #${p.listingId} ${p.player} — ${respMsg(r)}`);
      } else {
        log(`FAIL #${p.listingId} (${p.player}) -> ${r.status} ${(r.text || "").slice(0, 140)}`);
        log("stopping on first real failure — nothing further bid.");
        break;
      }
      S.bids.push({ ...p, ok, status: r.status });
      await sleep(bidGap());
    }
    log(`— ${placed} bid(s) placed | ${committed} rax committed | ${skipped} skipped | each card lands only if nobody outbids it in 10 min —`);
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
      if (!targets.length) { logLine("STOP: nothing to search — pick a Quick Search or type players."); return; }
      const label = currentLabel();
      logLine(
        `plan${label ? ` (${label})` : ""}: ${targets.length} target group(s) · cap ${DEFAULTS.maxRpr} rpr · ≤${DEFAULTS.maxCards} cards · ≤${DEFAULTS.maxSpend} rax` +
        (hashPlan ? " · caps from Walkr's Menu" : " · caps from the panel")
      );
      // A menu built before a cap change hands over the old numbers, which reads
      // as "the cap didn't update". Say so instead of letting it look like a bug.
      if (hashPlan) {
        const drift = [];
        if (hashPlan.maxCards != null && Number(hashPlan.maxCards) !== SCRIPT_CAPS.maxCards)
          drift.push(`cards ${hashPlan.maxCards} vs ${SCRIPT_CAPS.maxCards}`);
        if (hashPlan.maxSpend != null && Number(hashPlan.maxSpend) !== SCRIPT_CAPS.maxSpend)
          drift.push(`spend ${hashPlan.maxSpend} vs ${SCRIPT_CAPS.maxSpend}`);
        if (hashPlan.maxRpr != null && Number(hashPlan.maxRpr) !== SCRIPT_CAPS.maxRpr)
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
      for (const p of plan) logLine(`   ${p.player}  ${RARITY_LABEL[p.rarity]}  ${p.price} rax @ rating ${fmtR(p.rating)}  (${fmtR(p.rpr)} rpr)  #${p.listingId}`);
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

  function currentTargets() {
    if (hashPlan && Array.isArray(hashPlan.targets)) {
      if (hashPlan.maxRpr != null) DEFAULTS.maxRpr = Number(hashPlan.maxRpr);
      if (hashPlan.maxCards != null) DEFAULTS.maxCards = Number(hashPlan.maxCards);
      if (hashPlan.maxSpend != null) DEFAULTS.maxSpend = Number(hashPlan.maxSpend);
      return hashPlan.targets;
    }
    const preset = PRESETS.find((x) => x.id === quickEl.value);
    if (preset) return preset.slices.map((s) => ({ sport: s.sport, season: s.season, players: s.players }));
    const players = playersEl.value.split(",").map((s) => s.trim()).filter(Boolean);
    const sp = sportEl.value;
    const sports = sp === "all" ? ALL_SPORTS : [SPORT_ALIAS[sp] || sp];
    return sports.map((s) => ({ sport: s, season: SEASON[s], players }));
  }

  // ── UI ───────────────────────────────────────────────────────────────────
  let panel, logEl, statusEl, sportEl, playersEl, quickEl, liveEl, capsEl, lastBtnEl;
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
      "font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace", "box-shadow:0 10px 30px rgba(0,0,0,.5)"].join(";");

    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 10px;background:#111c30;border-bottom:1px solid #2a3a55;cursor:move";
    head.innerHTML = '<b style="flex:1">Walkr Autobid</b>';
    head.appendChild(btn("STOP", () => { S.stop = true; logLine("STOP pressed."); }, "background:#c0392b;color:#fff;font-weight:700;"));
    makeDraggable(panel, head);

    const cfg = document.createElement("div");
    cfg.style.cssText = "padding:8px 10px;border-bottom:1px solid #2a3a55;display:grid;grid-template-columns:auto 1fr;gap:5px 8px;align-items:center";

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

    capsEl = document.createElement("div");
    capsEl.style.cssText = "grid-column:1/-1;color:#9fb3d1";
    liveEl = document.createElement("label");
    liveEl.style.cssText = "grid-column:1/-1;display:flex;gap:6px;align-items:center;color:#ffb4a2";
    liveEl.innerHTML = '<input type="checkbox"> LIVE (actually bid — spends rax)';
    liveEl.querySelector("input").onchange = (e) => { DEFAULTS.live = e.target.checked; render(); };

    cfg.append(labeled("Quick Search"), quickEl, labeled("Sport"), sportEl, labeled("Players"), playersEl, capsEl, liveEl);

    quickEl.onchange = () => {
      hashPlan = null;   // a manual pick overrides a menu handoff
      const p = PRESETS.find((x) => x.id === quickEl.value);
      // Picking a preset sets its sport (Low PerRax and All Sports are multi-sport,
      // so those show "all"). The preset carries its own players, so the box is
      // cleared and parked.
      if (p) { sportEl.value = p.sport; playersEl.value = ""; playersEl.disabled = true; }
      else { playersEl.disabled = false; }
      render();
    };
    sportEl.onchange = () => { hashPlan = null; quickEl.value = ""; playersEl.disabled = false; render(); };
    playersEl.oninput = () => { if (playersEl.value.trim()) { hashPlan = null; quickEl.value = ""; } render(); };

    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;gap:6px;padding:8px 10px;flex-wrap:wrap";
    lastBtnEl = btn("Bid these", () => bidCached(), "background:#14432b;color:#b8f5cf;border-color:#1f6b45;");
    bar.append(btn("Run", () => { if (!S.running) run(); }), lastBtnEl, btn("Clear log", () => { S.log = []; render(); }));

    statusEl = document.createElement("div");
    statusEl.style.cssText = "padding:0 10px 8px;color:#9fb3d1;white-space:pre-wrap";
    logEl = document.createElement("div");
    logEl.style.cssText = "overflow:auto;padding:6px 10px 10px;border-top:1px solid #2a3a55;white-space:pre-wrap";

    panel.append(head, cfg, bar, statusEl, logEl);
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
    const age = S.lastAt ? Math.round((Date.now() - S.lastAt) / 1000) : null;
    statusEl.textContent =
      `maxRpr ${DEFAULTS.maxRpr} · maxCards ${DEFAULTS.maxCards} · maxSpend ${DEFAULTS.maxSpend} rax\n` +
      `sent: auth-info ${cred("real-auth-info")} · session ${cred("real-session-token")} · turnstile ${cred("real-turnstile-token")}\n` +
      (hashPlan ? "targets: from Walkr's Menu\n" : "") +
      (S.lastPlan ? `cached plan: ${S.lastPlan.length} card(s) · ${S.lastSpend} rax · ${age}s old\n` : "") +
      (DEFAULTS.live ? "MODE: LIVE" : "MODE: dry run");
    capsEl.textContent = `caps: ${DEFAULTS.maxRpr} rax/rating · ≤${DEFAULTS.maxCards} cards · ≤${DEFAULTS.maxSpend} rax`;
    logEl.textContent = S.log.join("\n");
    logEl.scrollTop = logEl.scrollHeight;
  }

  function boot() {
    if (!document.body) { setTimeout(boot, 300); return; }
    if (!panel) buildPanel();
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
