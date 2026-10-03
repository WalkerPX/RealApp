# userscripts

Browser-side helpers for Real's marketplace. These exist for one reason: **Real
signs every write with a Cloudflare Turnstile token minted by the page.** A
server can never produce one, so anything that *spends* has to run in Walker's
logged-in browser. Reads (`/cardmarketplacelistings`, `/marketplace/fmv/...`)
stay server-side in `lib/real-api.ts`; writes live here.

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

A bid at the trigger price starts a 10-minute countdown; nobody outbids you and
the card is yours. Bids are **not** deduped — duplicates, repeat players and low
rarities are all bid on, on purpose.

Hard caps, enforced in code: **≤11 rax/rating · ≤40 cards · ≤1000 rax per run**.
STOP halts between every step. A failed bid stops the run, except a listing that
vanished (sold/expired between scan and bid), which is skipped and reported.

### The preset block is generated

`const PRESETS` is baked in — the userscript runs on realapp.com and can't import
`lib/`. Regenerate it after a budget sweep:

```
node scripts/autobid/export_presets.mjs
```

It reads `BUDGET_SEARCH_PRESETS` (lib/budget-searches.ts) and `LOW_PERRAX_SLICES`
(lib/deals.ts), so the dropdown and Walkr's Menu can't drift apart.

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



