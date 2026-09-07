# walkr

Real Sports boost control — look up a username, see their cards playing today,
and get a suggested booster per card. Modeled on slybot.vercel.app, self-hosted.

## Stack

Next.js 15 (App Router) · TypeScript · plain CSS. One API route
(`/api/dashboard`) proxies Real's private web API from the server so your
session secret never reaches the browser.

## Auth

Real has no public API. walkr authenticates as **one account** — the session
you configure — which is also whose `boostcontrol` data it reads. Set either:

- **Mode A (preferred):** `REAL_AUTH_INFO`, `REAL_SESSION_TOKEN` (+ optional
  `REAL_DEVICE_TYPE`, `REAL_DEVICE_NAME`, `REAL_DEVICE_UUID`, `REAL_VERSION`).
  Grab values from a logged-in web.realapp.com session: DevTools → Application →
  Local Storage → `real-auth-info` and `real-session-token`.
- **Mode B:** `REAL_AUTH_COOKIE` — full Cookie header from a logged-in request.

A per-request `real-request-token` is generated automatically (verified Hashids
port of Real's encoder — see `lib/hashids.ts`).

## Caveat

`boostcontrol` (who's playing today) is session-scoped, so results are exact
for the configured account's own username and partial for others (intersection
of both collections). See `.env.example` for details.

## Endpoints (all verified live against web.realapp.com)

| call | path |
|---|---|
| user search | `/searchusers?query=` → `{users}` |
| collection | `/userpasses/{id}/passes?sport=mlb&season=2026` → `{passes}` |
| playing today | `/home/mlb/boostcontrol?day=YYYY-MM-DD` → `{userPasses}` (curated top-N for the session account; `cohort` is ignored server-side) |
| booster stock | `/userpassboostercards/{passId}/entity/player?displayType=userpass&sport=mlb&version=stat` → `{boosterCardInfo}` |
| schedule | `/home/mlb/next?cohort=0` → `{latestDayContent.games}` |

## Add a league

1. Flip the sport's `implemented` flag in `lib/types.ts`.
2. Capture one session of the same endpoints with `sport=wnba` (etc.) to
   confirm param parity (MLB 400s if you send `entityType`, for example).
3. Re-verify `boostcontrol` day/cohort semantics — offseasons may return empty.

## Local dev

```bash
cp .env.example .env   # fill in your session
npm install
npm run dev            # http://localhost:3000
```
