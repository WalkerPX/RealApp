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
