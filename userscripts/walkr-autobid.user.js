// ==UserScript==
// @name         Walkr Autobid
// @namespace    walkr.realapp
// @version      0.1.2
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

  SAFETY
  ------
    * starts in DRY RUN: it prints exactly what it would bid, spends nothing
    * three hard caps, enforced in code, not in the UI: rpr / cards / total rax
    * STOP halts immediately, between every single step
    * any error stops the run and reports — nothing is retried silently

  This cannot be undone once a bid lands. A winning bid is a purchase.
*/

(function () {
  "use strict";

  // ── config ────────────────────────────────────────────────────────────────
  const DEFAULTS = {
    maxRpr: 11,          // rax per rating point ceiling, per card
    maxCards: 20,        // hard ceiling on bids in one run
    maxSpend: 1000,      // hard ceiling on total rax in one run
    gapMin: 600,         // jittered politeness floor
    gapMax: 1400,
    live: false,         // DRY RUN until you explicitly arm it
  };

  // Current season per sport (DEAL_SEASONS[0] in lib/deals.ts). A listing query
  // needs one; a stale season simply returns nothing.
  const SEASON = {
    mlb: 2026, wnba: 2026, nba: 2026, ncaam: 2026,
    ncaaf: 2026, nfl: 2025, nhl: 2025, soccer: 2026,
  };
  const SPORT_ALIAS = { cfb: "ncaaf", cbb: "ncaam", fc: "soccer" };

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
  const reqToken = () => buildHashids("realwebapp", 16)([Date.now()]);

  // ── credential harvester ─────────────────────────────────────────────────
  // We never mint anything. We watch the page's own traffic and keep the newest
  // copy of each header it sends, including the Turnstile token.
  const HARVEST = ["real-auth-info", "real-session-token", "real-device-type",
    "real-device-name", "real-device-uuid", "real-version", "real-turnstile-token"];
  const creds = {};
  const seenAt = {};

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
        if (hk.toLowerCase() === k && h[hk]) { creds[k] = h[hk]; seenAt[k] = Date.now(); }
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

  // Real's app boots with a POST /session that carries every header we need, so
  // a plain page load is enough to fill this. Wait a moment anyway.
  function haveCreds() {
    return !!(creds["real-auth-info"] && creds["real-turnstile-token"]);
  }

  // ── api ──────────────────────────────────────────────────────────────────
  const BASE = "https://web.realapp.com";

  function apiHeaders() {
    const h = {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      Origin: "https://realapp.com",
      Referer: "https://realapp.com/",
      "real-request-token": reqToken(),
    };
    for (const k of HARVEST) if (creds[k]) h[k] = creds[k];
    return h;
  }

  async function apiGet(path) {
    const res = await fetch(BASE + path, { headers: apiHeaders(), cache: "no-store" });
    if (!res.ok) throw new Error(`GET ${path.split("?")[0]} -> ${res.status}`);
    return res.json();
  }

  async function apiPost(path, body) {
    const res = await fetch(BASE + path, {
      method: "POST", headers: apiHeaders(), body: JSON.stringify(body), cache: "no-store",
    });
    const text = await res.text().catch(() => "");
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) {}
    return { status: res.status, ok: res.ok, data, text };
  }

  // ── scanning ─────────────────────────────────────────────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const gap = () => DEFAULTS.gapMin + Math.floor(Math.random() * (DEFAULTS.gapMax - DEFAULTS.gapMin + 1));
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

  async function playerListings(sport, season, pid, rarity, ltype) {
    const q = new URLSearchParams({
      sport, season: String(season), rarity: String(rarity), listingType: ltype,
      filterEntityType: "player", filterEntityId: String(pid),
    });
    const d = await apiGet(`/cardmarketplacelistings?${q}`);
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

  const RARITIES = [1, 2, 3, 4, 5, 6, 7];
  const RARITY_LABEL = { 1: "Common", 2: "Uncommon", 3: "Rare", 4: "Epic", 5: "Legendary", 6: "Mystic", 7: "Iconic" };
  /** Real reports ratings as float noise (4.799999999999999) — show 2dp. */
  const fmtR = (n) => (Number.isFinite(n) ? String(Number(n.toFixed(2))) : "—");

  /** Find every live listing of the target players that clears the ceiling. */
  async function scan(targets, log) {
    const found = [];
    for (const t of targets) {
      if (S.stop) return found;
      const sport = SPORT_ALIAS[t.sport] || t.sport;
      const season = t.season || SEASON[sport];
      for (const name of t.players) {
        if (S.stop) return found;
        log(`· ${sport} ${season} — ${name}`);
        let pid = null;
        try { pid = await resolvePlayer(sport, name); } catch (e) { log(`! resolve "${name}": ${e.message}`); }
        if (pid == null) { log(`! unresolved: ${name}`); await sleep(gap()); continue; }
        log(`  resolved → player ${pid}`);
        for (const rarity of RARITIES) {
          if (S.stop) return found;
          let ls = [];
          try { ls = await playerListings(sport, season, pid, rarity, "card"); }
          catch (e) { log(`! listings ${name} r${rarity}: ${e.message}`); }
          if (ls.length) log(`  ${RARITY_LABEL[rarity]}: ${ls.length} listing(s)`);
          for (const l of ls) {
            const ends = l.endsAt ? Date.parse(l.endsAt) : NaN;
            if (Number.isFinite(ends) && ends <= Date.now()) continue;
            if (!l.canBid) continue;
            const price = listingPrice(l);
            const rating = listingRating(l);
            if (price == null || price <= 0 || rating == null) continue;
            if (l.buyNowPrice == null) continue;   // no trigger price => can't start the clock
            const rpr = price / rating;
            if (rpr > DEFAULTS.maxRpr) continue;
            if (found.some((f) => f.listingId === l.id)) continue;
            found.push({
              listingId: l.id, sport, season, player: name, rarity,
              rating, price, rpr: Math.round(rpr * 100) / 100, endsAt: l.endsAt || null,
              url: `https://www.realapp.com/${buildHashids("routing", 11)([30, 0, 0, l.id])}`,
            });
          }
          await sleep(gap());
        }
      }
    }
    // Cheapest rax-per-rating first.
    found.sort((a, b) => a.rpr - b.rpr);
    return found;
  }

  /** Apply the three hard caps. */
  function buildPlan(candidates) {
    const plan = [];
    let spend = 0;
    for (const c of candidates) {
      if (plan.length >= DEFAULTS.maxCards) break;
      if (spend + c.price > DEFAULTS.maxSpend) continue;
      plan.push(c);
      spend += c.price;
    }
    return { plan, spend };
  }

  // ── the run ──────────────────────────────────────────────────────────────
  const S = { stop: false, running: false, log: [], bids: [] };

  function logLine(s) {
    S.log.push(`${new Date().toISOString().slice(11, 19)}  ${s}`);
    if (S.log.length > 400) S.log.shift();
    render();
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
      logLine(`plan: ${targets.length} target group(s) · cap ${DEFAULTS.maxRpr} rpr · ≤${DEFAULTS.maxCards} cards · ≤${DEFAULTS.maxSpend} rax`);

      const candidates = await scan(targets, logLine);
      if (S.stop) { logLine("stopped."); return; }
      logLine(`found ${candidates.length} qualifying listing(s)`);

      const { plan, spend } = buildPlan(candidates);
      if (!plan.length) { logLine("nothing qualified — done."); return; }
      logLine(`PLAN: ${plan.length} bid(s), ${spend} rax total`);
      for (const p of plan) logLine(`   ${p.player}  ${RARITY_LABEL[p.rarity]}  ${p.price} rax @ rating ${fmtR(p.rating)}  (${fmtR(p.rpr)} rpr)  #${p.listingId}`);

      if (!DEFAULTS.live) { logLine("DRY RUN — nothing bid. Flip to LIVE to execute."); return; }

      logLine("LIVE — bidding now");
      for (const p of plan) {
        if (S.stop) { logLine("STOPPED mid-run."); return; }
        const r = await apiPost(`/cardmarketplacelistings/${p.listingId}/bid`, { bidAmount: p.price });
        const ok = r.ok && r.data && r.data.success;
        S.bids.push({ ...p, ok, status: r.status, resp: r.data || r.text });
        if (!ok) {
          logLine(`FAIL #${p.listingId} (${p.player}) -> ${r.status} ${(r.text || "").slice(0, 120)}`);
          logLine("stopping on first failure — nothing further bid.");
          return;
        }
        const li = r.data.listingInfo || {};
        logLine(`BID OK #${p.listingId} ${p.player} @ ${p.price} rax · top=${li.isTopBidder} · bids=${li.numBids}`);
        await sleep(gap());
      }
      logLine("run complete.");
    } catch (e) {
      logLine(`ERROR: ${e.message}`);
    } finally {
      S.running = false;
      render();
    }
  }

  // ── targets ──────────────────────────────────────────────────────────────
  // Priority: a plan handed over by Walkr's Menu (URL hash) > the panel fields.
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

  function currentTargets() {
    if (hashPlan && Array.isArray(hashPlan.targets)) {
      if (hashPlan.maxRpr != null) DEFAULTS.maxRpr = Number(hashPlan.maxRpr);
      if (hashPlan.maxCards != null) DEFAULTS.maxCards = Number(hashPlan.maxCards);
      if (hashPlan.maxSpend != null) DEFAULTS.maxSpend = Number(hashPlan.maxSpend);
      return hashPlan.targets;
    }
    const sport = SPORT_ALIAS[sportEl.value] || sportEl.value;
    const players = playersEl.value.split(",").map((s) => s.trim()).filter(Boolean);
    return players.length ? [{ sport, season: SEASON[sport], players }] : [];
  }

  // ── UI ───────────────────────────────────────────────────────────────────
  let panel, logEl, statusEl, sportEl, playersEl, liveEl, capsEl;
  const btn = (label, fn, css) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = "background:#1a2b45;color:#cfe0f7;border:1px solid #2a3a55;border-radius:6px;padding:4px 9px;cursor:pointer;" + (css || "");
    b.onclick = fn;
    return b;
  };

  function buildPanel() {
    panel = document.createElement("div");
    panel.style.cssText = ["position:fixed", "right:14px", "bottom:14px", "z-index:2147483647",
      "width:420px", "max-height:70vh", "display:flex", "flex-direction:column",
      "background:#0b1120", "color:#e6edf7", "border:1px solid #2a3a55", "border-radius:10px",
      "font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace", "box-shadow:0 10px 30px rgba(0,0,0,.5)"].join(";");

    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 10px;background:#111c30;border-bottom:1px solid #2a3a55;cursor:move";
    head.innerHTML = '<b style="flex:1">Walkr Autobid</b>';
    const stop = btn("STOP", () => { S.stop = true; logLine("STOP pressed."); }, "background:#c0392b;color:#fff;font-weight:700;");
    head.appendChild(stop);
    makeDraggable(panel, head);

    const cfg = document.createElement("div");
    cfg.style.cssText = "padding:8px 10px;border-bottom:1px solid #2a3a55;display:grid;grid-template-columns:auto 1fr;gap:5px 8px;align-items:center";
    sportEl = document.createElement("select");
    for (const s of ["nhl", "nba", "mlb", "wnba", "nfl", "ncaaf", "ncaam", "soccer"]) {
      const o = document.createElement("option"); o.value = s; o.textContent = s; sportEl.appendChild(o);
    }
    sportEl.style.cssText = "background:#0b1120;color:#e6edf7;border:1px solid #2a3a55;border-radius:5px;padding:2px 4px";
    playersEl = document.createElement("input");
    playersEl.placeholder = "players, comma separated (or use Walkr's Menu)";
    playersEl.style.cssText = "background:#0b1120;color:#e6edf7;border:1px solid #2a3a55;border-radius:5px;padding:3px 6px;width:100%";
    capsEl = document.createElement("div");
    capsEl.style.cssText = "grid-column:1/-1;color:#9fb3d1";
    liveEl = document.createElement("label");
    liveEl.style.cssText = "grid-column:1/-1;display:flex;gap:6px;align-items:center;color:#ffb4a2";
    liveEl.innerHTML = '<input type="checkbox"> LIVE (actually bid — spends rax)';
    cfg.append(labeled("sport"), sportEl, labeled("players"), playersEl, capsEl, liveEl);

    liveEl.querySelector("input").onchange = (e) => { DEFAULTS.live = e.target.checked; render(); };

    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;gap:6px;padding:8px 10px;flex-wrap:wrap";
    bar.append(btn("Run", () => { if (!S.running) run(); }), btn("Clear log", () => { S.log = []; render(); }));
    statusEl = document.createElement("div");
    statusEl.style.cssText = "padding:0 10px 8px;color:#9fb3d1;white-space:pre-wrap";
    logEl = document.createElement("div");
    logEl.style.cssText = "overflow:auto;padding:6px 10px 10px;border-top:1px solid #2a3a55;white-space:pre-wrap";

    panel.append(head, cfg, bar, statusEl, logEl);
    mount(panel);
    render();
  }

  function labeled(t) { const d = document.createElement("div"); d.textContent = t; d.style.color = "#7f93b0"; return d; }

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

  function render() {
    if (!panel || !panel.isConnected) return;
    statusEl.textContent =
      `maxRpr ${DEFAULTS.maxRpr} · maxCards ${DEFAULTS.maxCards} · maxSpend ${DEFAULTS.maxSpend} rax\n` +
      `sent: auth-info ${creds["real-auth-info"] ? "✓" : "—"} · session ${creds["real-session-token"] ? "✓" : "—"} · turnstile ${creds["real-turnstile-token"] ? "✓" : "—"}\n` +
      (hashPlan ? "targets: from Walkr's Menu\n" : "targets: from the fields below\n") +
      (DEFAULTS.live ? "MODE: LIVE" : "MODE: dry run");
    capsEl.textContent = `caps: ${DEFAULTS.maxRpr} rax/rating · ≤${DEFAULTS.maxCards} cards · ≤${DEFAULTS.maxSpend} rax`;
    logEl.textContent = S.log.join("\n");
    logEl.scrollTop = logEl.scrollHeight;
  }

  function boot() {
    if (!document.body) { setTimeout(boot, 300); return; }
    buildPanel();
    setInterval(() => { if (panel && !panel.isConnected) mount(panel); }, 2000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  window.addEventListener("load", boot);
})();
