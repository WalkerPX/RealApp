// ==UserScript==
// @name         Walkr Buy Capture
// @namespace    walkr.realapp
// @version      0.1.1
// @description  Records Real's marketplace WRITE requests (Buy Now / bid) so the exact flow can be learned. Captures only — never sends anything, never buys anything.
// @author       walkr
// @match        *://*.realapp.com/*
// @match        *://realapp.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
  WHY THIS EXISTS
  ---------------
  Real signs every write (POST/PUT/PATCH/DELETE) with a Cloudflare Turnstile
  token minted by the page. A server cannot produce one, so any buying
  automation has to live in this browser. Before anything can auto-buy we need
  the exact request the page sends: URL, method, headers, body, and where the
  Turnstile token rides.

  This script is deliberately dumb and safe:
    * It hooks fetch() and XMLHttpRequest and RECORDS writes.
    * It sends nothing. It buys nothing. It cannot spend money.
    * The red STOP button is a kill switch: it unhooks everything, immediately.

  HOW TO USE
  ----------
  1. Install in Tampermonkey / Violentmonkey. Open realapp.com, logged in.
  2. Click [Arm 90s].
  3. Do ONE Buy Now on a cheap card, exactly like you normally would.
  4. Click [Download JSON], then drop the file where Hermes can read it.

  The download contains real-auth-info / real-session-token. Treat it as a
  credential — have Hermes read the file, do not paste it into chat.
*/

(function () {
  "use strict";

  const W = window;
  if (W.__walkrBuyCaptureLoaded) return;
  W.__walkrBuyCaptureLoaded = true;

  const TAG = "[walkr-buy-capture]";
  const log = (...a) => { try { console.log(TAG, ...a); } catch (_) {} };
  const warn = (...a) => { try { console.warn(TAG, ...a); } catch (_) {} };
  log("script started on", location.href);

  const ARM_MS = 90_000;
  const MAX_BODY = 120_000;
  const MAX_RECORDS = 500;

  // Writes are always recorded. While armed, reads are recorded too (so we see
  // the Turnstile/session handshake that precedes the write).
  const WRITE_RE = /^(POST|PUT|PATCH|DELETE)$/i;
  const NOISY_GET_RE = /(cardmarketplacelistings|userpasses|home\/|searchusers)/i;
  // Paths that look like the thing we actually want, flagged in the UI.
  const INTEREST_RE = /listing|buy|bid|offer|purchase|checkout|order|market|trade|turnstile|token/i;

  const S = {
    on: true,               // kill switch state
    armedUntil: 0,          // ms epoch; 0 = not armed
    records: [],
    writes: 0,
    tokenInBody: false,
    startedAt: new Date().toISOString(),
  };

  const armed = () => S.on && Date.now() < S.armedUntil;

  // ── helpers ───────────────────────────────────────────────────────────────
  function clip(v) {
    if (v == null) return null;
    let s;
    if (typeof v === "string") s = v;
    else { try { s = JSON.stringify(v); } catch (_) { s = String(v); } }
    return s.length > MAX_BODY ? s.slice(0, MAX_BODY) + "…[+" + (s.length - MAX_BODY) + " more]" : s;
  }

  function headersToObj(h) {
    const out = {};
    if (!h) return out;
    try {
      if (typeof h.forEach === "function" && typeof h.get === "function") {
        h.forEach((v, k) => { out[k] = v; });
      } else if (Array.isArray(h)) {
        for (const pair of h) out[pair[0]] = pair[1];
      } else {
        for (const k of Object.keys(h)) out[k] = h[k];
      }
    } catch (_) {}
    return out;
  }

  function noteToken(text) {
    if (!text) return;
    const s = String(text);
    if (/cf-turnstile-response|turnstile_token|turnstileToken|cf_turnstile|"turnstile"/i.test(s)) {
      S.tokenInBody = true;
    }
  }

  function pathOf(url) {
    try { return new URL(url, location.href).pathname + new URL(url, location.href).search; }
    catch (_) { return String(url); }
  }

  function push(rec) {
    if (!S.on) return;
    rec.t = new Date().toISOString();
    if (S.records.length >= MAX_RECORDS) S.records.shift();
    S.records.push(rec);
    if (WRITE_RE.test(rec.method)) S.writes++;
    render();
  }

  function shouldRecord(method, url) {
    if (WRITE_RE.test(method)) return true;
    if (!armed()) return false;
    if (NOISY_GET_RE.test(url)) return false;
    return true;
  }

  // ── hooks ────────────────────────────────────────────────────────────────
  const origFetch = W.fetch;
  W.fetch = function (input, init) {
    let url, method, reqHeaders;
    try {
      if (typeof input === "string" || input instanceof URL) {
        url = String(input);
        method = (init && init.method) || "GET";
        reqHeaders = headersToObj(init && init.headers);
      } else {
        url = input && input.url;
        method = (init && init.method) || (input && input.method) || "GET";
        reqHeaders = Object.assign(headersToObj(input && input.headers), headersToObj(init && init.headers));
      }
    } catch (_) { return origFetch.apply(this, arguments); }

    const rec = shouldRecord(method, url) ? {
      via: "fetch",
      method: String(method).toUpperCase(),
      url: String(url),
      path: pathOf(url),
      interesting: INTEREST_RE.test(String(url)),
      requestHeaders: reqHeaders,
      requestBody: clip(init && init.body),
    } : null;

    if (rec) noteToken(rec.requestBody);

    const p = origFetch.apply(this, arguments);
    if (!rec) return p;
    return p.then((res) => {
      try {
        const rc = res.clone();
        rc.text().then((t) => {
          rec.status = rc.status;
          rec.responseBody = clip(t);
          noteToken(t);
          push(rec);
        }).catch(() => { rec.status = rc.status; push(rec); });
      } catch (_) { push(rec); }
      return res;
    }, (err) => {
      rec.error = String(err && err.message || err);
      push(rec);
      throw err;
    });
  };

  const XHR = W.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    const origSetHeader = XHR.prototype.setRequestHeader;

    XHR.prototype.open = function (method, url) {
      try {
        this.__walkr = {
          via: "xhr",
          method: String(method).toUpperCase(),
          url: String(url),
          path: pathOf(url),
          interesting: INTEREST_RE.test(String(url)),
          requestHeaders: {},
        };
      } catch (_) {}
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.setRequestHeader = function (k, v) {
      try { if (this.__walkr) this.__walkr.requestHeaders[k] = v; } catch (_) {}
      return origSetHeader.apply(this, arguments);
    };

    XHR.prototype.send = function (body) {
      try {
        const rec = this.__walkr;
        if (rec && shouldRecord(rec.method, rec.url)) {
          rec.requestBody = clip(body);
          noteToken(rec.requestBody);
          const self = this;
          this.addEventListener("loadend", function () {
            try {
              rec.status = self.status;
              rec.responseBody = clip(self.responseText);
              noteToken(self.responseText);
            } catch (_) {}
            push(rec);
          });
        } else {
          this.__walkr = null;
        }
      } catch (_) {}
      return origSend.apply(this, arguments);
    };

    W.XMLHttpRequest = XHR;
  }

  // ── Turnstile fingerprint ────────────────────────────────────────────────
  function turnstileInfo() {
    const info = { sitekeys: [], hiddenInputs: [], widgets: 0 };
    try {
      document.querySelectorAll("[data-sitekey]").forEach((el) => {
        info.sitekeys.push(el.getAttribute("data-sitekey"));
      });
      document.querySelectorAll("input[name='cf-turnstile-response'], textarea[name='cf-turnstile-response']").forEach((el) => {
        info.hiddenInputs.push({ name: el.name, nonEmpty: !!(el.value && el.value.length) });
      });
      info.widgets = document.querySelectorAll(".cf-turnstile, [class*='turnstile']").length;
    } catch (_) {}
    info.tokenSeenInRequests = S.tokenInBody;
    return info;
  }

  // ── UI ───────────────────────────────────────────────────────────────────
  let panel, listEl, statusEl, armBtn;

  function buildPanel() {
    panel = document.createElement("div");
    panel.id = "walkr-buy-capture";
    panel.style.cssText = [
      "position:fixed", "right:14px", "bottom:14px", "z-index:2147483647",
      "width:360px", "max-height:62vh", "display:flex", "flex-direction:column",
      "background:#0b1120", "color:#e6edf7", "border:1px solid #2a3a55",
      "border-radius:10px", "font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace",
      "box-shadow:0 10px 30px rgba(0,0,0,.5)", "overflow:hidden",
    ].join(";");

    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 10px;background:#111c30;border-bottom:1px solid #2a3a55;cursor:move";
    head.innerHTML = '<b style="flex:1">Walkr Buy Capture</b>';
    const stop = document.createElement("button");
    stop.textContent = "STOP";
    stop.style.cssText = "background:#c0392b;color:#fff;border:0;border-radius:6px;padding:4px 10px;font-weight:700;cursor:pointer";
    stop.onclick = killSwitch;
    head.appendChild(stop);

    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;gap:6px;padding:8px 10px;flex-wrap:wrap";
    armBtn = mkBtn("Arm 90s", () => { S.armedUntil = Date.now() + ARM_MS; render(); });
    bar.append(
      armBtn,
      mkBtn("Download JSON", download),
      mkBtn("Clear", () => { S.records = []; S.writes = 0; S.tokenInBody = false; render(); })
    );

    statusEl = document.createElement("div");
    statusEl.style.cssText = "padding:0 10px 8px;color:#9fb3d1;white-space:pre-wrap";

    listEl = document.createElement("div");
    listEl.style.cssText = "overflow:auto;padding:6px 10px 10px;border-top:1px solid #2a3a55";

    panel.append(head, bar, statusEl, listEl);
    mount(panel);
    makeDraggable(panel, head);
    log("panel built");
  }

  function mount(el) {
    const host = document.body || document.documentElement;
    if (!host) { warn("no DOM host to mount into yet"); return false; }
    if (host === document.documentElement && !document.body) {
      // documentElement is the <html> element; appending there is legal but the
      // SPA may replace children. Prefer <body> the moment it exists.
      host.appendChild(el);
      return true;
    }
    host.appendChild(el);
    return true;
  }

  function mkBtn(label, fn) {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = "background:#1a2b45;color:#cfe0f7;border:1px solid #2a3a55;border-radius:6px;padding:4px 9px;cursor:pointer";
    b.onclick = fn;
    return b;
  }

  function makeDraggable(el, handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener("mousedown", (e) => {
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
      el.style.right = "auto"; el.style.bottom = "auto";
      el.style.left = ox + "px"; el.style.top = oy + "px";
      e.preventDefault();
    });
    W.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      el.style.left = (ox + e.clientX - sx) + "px";
      el.style.top = (oy + e.clientY - sy) + "px";
    });
    W.addEventListener("mouseup", () => { dragging = false; });
  }

  function render() {
    if (!panel || !S.on) return;
    const left = Math.max(0, Math.ceil((S.armedUntil - Date.now()) / 1000));
    const ts = turnstileInfo();
    statusEl.textContent =
      "writes: " + S.writes + "   records: " + S.records.length + "\n" +
      (armed() ? "ARMED  " + left + "s left" : "idle — arm before you click Buy Now") + "\n" +
      "turnstile: widgets=" + ts.widgets + " sitekey=" + (ts.sitekeys[0] || "—") +
      " tokenInRequests=" + (ts.tokenSeenInRequests ? "YES" : "no");
    armBtn.textContent = armed() ? "Armed " + left + "s" : "Arm 90s";

    const rows = S.records.slice(-60).reverse().map((r) =>
      '<div style="padding:2px 0;color:' + (r.interesting ? "#ffd166" : (WRITE_RE.test(r.method) ? "#8fd694" : "#8aa2c2")) + '">' +
      r.method + " " + escapeHtml(r.path) + (r.status ? " → " + r.status : "") + "</div>"
    ).join("");
    listEl.innerHTML = rows || '<div style="color:#5f7391">nothing captured yet</div>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function download() {
    const payload = {
      capturedAt: new Date().toISOString(),
      pageOrigin: location.origin,
      armedWindowMs: ARM_MS,
      turnstile: turnstileInfo(),
      records: S.records,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "walkr-real-capture-" + Date.now() + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function killSwitch() {
    S.on = false;
    S.armedUntil = 0;
    try { W.fetch = origFetch; } catch (_) {}
    if (panel) {
      panel.style.borderColor = "#c0392b";
      statusEl.textContent = "STOPPED — hooks removed, nothing further will be recorded.\nDownload before reloading if you still need the capture.";
      listEl.innerHTML = "";
      armBtn.disabled = true;
    }
  }

  function ensurePanel() {
    if (!S.on) return;
    if (!document.documentElement) return;
    if (!panel || !panel.isConnected) {
      buildPanel();
      render();
    }
  }

  function boot() {
    log("boot; readyState=" + document.readyState + " body=" + !!document.body);
    ensurePanel();
    setInterval(() => { if (S.on) render(); }, 1000);
    setInterval(ensurePanel, 1500);
  }

  log("hooks installed: fetch=" + (typeof W.fetch === "function") + " xhr=" + !!W.XMLHttpRequest);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
  W.addEventListener("load", boot);
})();
