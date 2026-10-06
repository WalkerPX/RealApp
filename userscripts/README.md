# userscripts

Browser-side helpers for Real's marketplace. These exist for one reason: **Real
signs every write with a Cloudflare Turnstile token minted by the page.** A
server can never produce one, so anything that *spends* has to run in Walker's
logged-in browser. Reads (`/cardmarketplacelistings`, `/marketplace/fmv/...`)
stay server-side in `lib/real-api.ts`; writes live here.

Both scripts carry `@updateURL` / `@downloadURL` pointing at `main` on GitHub, so
Tampermonkey offers the new version on its own once `@version` is bumped — no
reinstall by hand. To pull one immediately: Tampermonkey → the script →
**Check for updates**, or open the raw URL.

## walkr-buy-capture.user.js — step 1, recon

Captures the exact Buy Now request so the buy flow can be replayed. It **records
only** — it sends nothing and cannot spend money.

Install (Tampermonkey / Violentmonkey), open `realapp.com` logged in, then:

1. **Arm 90s**
2. Do **one** Buy Now on a cheap card, exactly like normal
3. **Download JSON** → drop the file where Hermes can read it

The download contains `real-auth-info` / `real-session-token`. It is a
credential — hand Hermes the *file*, never paste it into chat.

Red **STOP** is the kill switch: unhooks `fetch` + `XHR` immediately.

## What we're looking for in the capture

- the write's **path + method** (e.g. `POST /listing/{id}/buy`)
- whether the Turnstile token rides in a **header** or the **body**
- the request body's shape (price? quantity? offer amount?)
- the success response shape (so a buyer can confirm a fill)

Once that's known, the auto-buyer userscript + the launcher button in Walkr's
Menu get built on top of it.

## Captured flow (recon #1 — 2026-10-03)

Listing 1447541296, bid of 40 rax.

```
POST https://web.realapp.com/cardmarketplacelistings/{listingId}/bid
Body: {"bidAmount": 40}
Resp: {"success":true,"message":null,
       "listingInfo":{"currentBidPriceDisplay":"40","bidCountDisplay":"1",
                      "numBids":1,"isTopBidder":true}}
```

So the marketplace write is a **bid**, not an instant purchase — even though the
UI button is "Buy Now". (`bidAmount` = the buy-now price; the bid goes top.)

### Headers on the write

| header | value |
|---|---|
| `real-device-type` | `desktop_web` |
| `real-device-name` | UA string |
| `real-device-uuid` | stable per browser |
| `real-version` | `37` |
| `real-request-token` | per-request, `Hashids("realwebapp",16).encode(now_ms)` — already ported in `lib/real-api.ts` and the tracker |
| `real-session-token` | session |
| `real-auth-info` | `{userId}!{deviceId}!{token}` credential |
| `real-turnstile-token` | **the Turnstile token** |

### The important detail

`real-turnstile-token` rode as a **header**, and the *same* token value was
attached to all four requests in that second (`/session`, `/tracking/web`,
`/timesegments`, `/cardmarketplacelistings/{id}/bid`). So Real's token is
**reusable within a window**, not burned on first use.

No `cf-turnstile` widget, no `data-sitekey`, no hidden input was visible in the
DOM — the challenge runs invisibly (managed mode, almost certainly in a
cross-origin iframe we can't read).

Consequence: a buyer has two viable doors, and the second is much safer.

1. **Reuse** a token scraped off the page's own outgoing traffic, then forge the
   POST ourselves. Works until the token ages out; we don't yet know its TTL.
2. **Click the page's own Buy Now button.** The page mints a fresh token and
   attaches it itself — we never touch the token, and it's byte-for-byte what a
   human does. Fragile only in that it depends on the button's selector.

Door 2 is the one to build on.

## walkr-autobid.user.js — the bidder

Bids the buy-now trigger price on listings under a rax-per-rating ceiling.
Starts in **dry run**.

Two ways in:

- **Walkr's Menu → Autobid → "Bid <lineup>"** — the lineup and the caps ride in
  the URL hash (`#walkr=<base64url>`), and the panel shows *from Walkr's Menu*.
- **Standalone** — pick a **Quick Search** (the same lineups), or set
  **Sport** (including `all`) + **Players**.

Flow: **Run** scans and caches the plan, spending nothing unless LIVE is ticked.
Then **Bid these N (X rax)** fires *that cached plan* — no second scan. A plan
older than 5 minutes warns first, because listings turn over.

Picking a Quick Search fills a **row of player bubbles under "Players"** — the
lineup it is about to search, one chip per player with a sport/season tag. The
**×** drops that player for this run only (the chip greys out and its × becomes
**↺** to undo, plus a *restore all* button). Picking a Quick Search again — or
touching Sport/Players — clears every exclusion, so the preset is never edited.
A slice whose players are all dropped disappears entirely rather than falling
back to a whole-market sweep.

A bid at the trigger price starts a 10-minute countdown; nobody outbids you and
the card is yours. Bids are **not** deduped — duplicates, repeat players and low
rarities are all bid on, on purpose.

### Resizing the panel

The panel is **resizable**: drag the diagonal grip in the bottom-right corner,
or **double-click it to snap back to the default dock** (bottom-right, 74vh).
The size is remembered in `localStorage` (`walkr.autobid.size.v1`) across
reloads; the *position* is still whatever you last dragged the header to. The
grip pins the panel's top-left on grab, so growing always goes down-and-right
and a resize can't walk the panel off screen — `clampPanel()` also re-clamps on
window resize. Minimum 340×240; nothing can exceed the window.

Inside the panel the log takes up the slack (`flex:1; min-height:0`) and the
config block shrinks and scrolls before anything gets clipped, so the chips and
the preset dropdown stay reachable at any height.

Hard caps, enforced in code: **≤11 rax/rating · ≤50 cards · ≤1000 rax per run**.
STOP halts between every step. A failed bid stops the run — except the two
ordinary auction losses: the listing vanished, or somebody bid a moment first and
the floor moved above the price we were going to pay. Those skip, log what Real
said, and the run continues.

The caps can come from two places, and the log now names which: **from the
panel** (this script's `SCRIPT_CAPS`) or **from Walkr's Menu** (the URL hash). A
menu page built before a cap change sends the old number, so the script compares
the two and says so rather than letting it look like the cap failed to update.

### The preset block is generated

`const PRESETS` is baked in — the userscript runs on realapp.com and can't import
`lib/`. Regenerate it after a budget sweep or a daily-pack edit:

```
node scripts/autobid/export_presets.mjs
```

It reads `BUDGET_SEARCH_PRESETS` (lib/budget-searches.ts), `MAX_SEARCH_PRESETS`
(lib/max-searches.ts), `SETUP_SEARCH_PRESETS` (lib/setup-searches.ts),
`DAILY_PACK_PRESETS` (lib/daily-pack-searches.ts) and `LOW_PERRAX_SLICES`
(lib/deals.ts), so the dropdown and Walkr's Menu can't drift apart. Optimal MAX
and Optimal Setup presets carry `maxRpr` parsed straight out of `MAX_SEARCH_FACTOR`
/ `SETUP_SEARCH_FACTOR` (21), the same ceiling the shop menu screens them at —
without it the extension fell back to `SCRIPT_CAPS.maxRpr` (11) and the panel
quoted 11 for a lineup the menu had searched at 21.

### Per-preset rax/rating ceilings

A preset may carry its own `maxRpr`. The **Daily Pack Buys** presets ship
`maxRpr: 21`: a player pack costs 200 rax for ~10 rating (**20 rax per rating**),
so a marketplace listing at or under 21 rpr is cheaper fuel than the pack itself.
`effectiveMaxRpr()` resolves the ceiling per run — menu handoff → preset's own →
`SCRIPT_CAPS` — and `render()` re-derives it, so picking a daily-pack preset and
then switching to something else can't leave 21 behind. `PRESET_CEILINGS` keeps a
handoff quoting 21 from tripping the stale-menu drift note.

### The loop — unattended cycles off one allowance

"Arm loop" re-runs the selected Quick Search on a timer under a single rax
allowance (default 10,000). The wait between cycles is a **random value in
[8, 11] minutes** (both ends editable in the panel, clamped 5–240) — a metronome
is the easiest part of a bot to spot, and Real's listings turn over on a
human-ish cadence anyway. Hard stops, all in code: allowance committed · 72
cycles · 24 h wall clock · 3 consecutive failed cycles · STOP (which also clears
the stored state, so a reload after STOP can't re-arm it).

The panel shows the allowance as a running **balance** — `9,760 rax left of
10,000 · 2 cards bid` — which drops card by card as the loop bids, and the same
number is appended to every `BID OK` line. It tracks rax **committed**, not
spent: a bid reserves its price and Real charges only the winners, so the
balance can stop the loop early but can never overshoot it. The per-run rails
stay: ≤50 cards and ≤1000 rax a cycle, with the allowance sitting above them.

Bids need a page-minted Turnstile token (~5 min TTL, and the page only mints one
when it makes a write of its own), so any loop cadence carries a stale token —
the **primer** (on by default) once a cycle mints one by clicking the page's own
Buy Now: in place when the listing is already on the page, otherwise after
navigating to `PRIMER.route(listingId)` (verified: listing 1454281451 →
`/VVtaFVFra9A1D`, titled "Marketplace Listing 90 Rax | Jalen Brunson NBA Play…").

It matches **text, not markup**. A live Primer report on a card page settled it:
the app is React Native Web, so there are **zero** `<button>`, `<a>` or
`[role=button]` elements, **503** pointer-cursor `<div>`s with generic `css-`/`r-`
class names, and exactly **one** element whose text said `Bid`. So text is the
only signal that survives:

- `clickCandidates()` keeps anything that looks interactive (a real control,
  `role=button`, a `tabindex`, an `onclick`, or a `pointer` cursor).
- `primerCandidates()` ranks matches: an exact `buy now` → an exact `bid` → an
  exact `buy` → then shortest text, so a wrapper can never outrank its own button.
- `primeByClicking()` clicks them **in order** and moves to the next whenever a
  click mints no token — with hundreds of generic divs, one ambiguous label must
  not kill the cycle. A click that mints nothing means "not the bid control"; it
  costs nothing.
- The confirm step deliberately does **not** match `buy now` (the primary control
  matches that, and the first version clicked it twice), and it ignores anything
  that was already on the page before the click — so only a dialog that *appeared*
  can be confirmed.
- The panel's own controls are always excluded. `Bid these 1 (90 rax)` is one
  regex away from being mistaken for Real's.

**Primer report** dumps the page's real controls, its pointer-cursor leaves, and
every leaf mentioning buy/bid/offer/rax — that is what to send if the primer logs
`no bid control found`.

Three jsdom suites cover this headlessly (`/tmp/walkr-test/`: `run.cjs` for the
loop, `primer.cjs` for the primer): dry-run plans and spends nothing, a small
allowance refuses to bid, LIVE bids at the buy-now price and debits the balance
card by card, a spent allowance refuses to re-arm, the cadence lands inside
`[min, max]`, and the primer finds/clicks a div-based `Buy Now` **before** a
second-ranked `Bid`, exactly once, while ignoring a non-matching pointer div and
its own panel.

Loop state lives in `localStorage["walkr.autobid.loop.v1"]`, including the armed
preset's id and the next-cycle timestamp — the primer reloads the page, and
without the preset id the cycle after the reload would fall back to a
whole-market sweep. The tab must stay open on realapp.com; background timers
throttle, so a cycle can start late, never early.

### The 401 that wasn't an auth problem

Real answers **401 "Malformed request."** for a bad `real-request-token` — the
same status and nearly the same wording as a dead session, which is why a broken
hashids port reads as "your session expired". Diagnostic map, verified live:

| response | actually means |
|---|---|
| `401 Malformed request.` | `real-request-token` missing or garbage |
| `401 Invalid request.` | token well-formed but stale (hour-old) |
| `401 Authentication required.` | bad `real-auth-info` |
| `400 Real cannot be used on this device` | missing `real-device-uuid` |

So the userscript now checks its encoder against a known vector at boot and
prints `SELF-TEST FAILED` if it drifts. A one-character typo in the hashids port
shipped once and cost an afternoon; that is what the check is for.



