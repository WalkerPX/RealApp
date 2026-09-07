# walkr

Real Sports boost control — look up a username, see their cards playing today,
and get a suggested booster per card. Modeled on slybot.vercel.app, self-hosted.

## Stack

Next.js 15 (App Router) · TypeScript · plain CSS. One API route
(`/api/dashboard`) proxies Real's private web API from the server so your
session secret never reaches the browser.

## Auth

Real has no public API. walkr proxies Real's private web API from the server.
One session is required for any lookup — the booster-inventory endpoint is
account-scoped. Set either:

- **Mode A (preferred):** `REAL_AUTH_INFO` (the only required var; device
  headers are embedded in `lib/real-api.ts` as code defaults, env-overridable
  via `REAL_DEVICE_TYPE`, `REAL_DEVICE_NAME`, `REAL_DEVICE_UUID`,
  `REAL_VERSION`).
  Grab values from a logged-in web.realapp.com session: DevTools → Application →
  Local Storage → `real-auth-info` and `real-session-token`.
- **Mode B:** `REAL_AUTH_COOKIE` — full Cookie header from a logged-in request.

A per-request `real-request-token` is generated automatically (verified Hashids
port of Real's encoder — see `lib/hashids.ts`).

## Caveat

The booster-inventory endpoint is scoped to the configured session account, so
the per-card "suggested booster" reflects *that* account's booster stock. The
collection and schedule are per-username, so any username works — suggestions
are just limited to stock on the session's account.

## Endpoints (all verified live against web.realapp.com)

| call | path |
|---|---|
| user search | `/searchusers?query=` → `{users}` |
| collection | `/userpasses/{id}/passes?sport=mlb&season=2026` → `{passes}` (includes per-card boost state) |
| schedule | `/home/mlb/next?cohort=0` → `{latestDayContent.games}` |
| booster stock | `/userpassboostercards/{passId}/entity/player?displayType=userpass&sport=mlb&version=stat` → `{boosterCardInfo}` |

"Playing today" = collection joined against the schedule by team. (Not
`boostcontrol` — its list is a fixed curated 5 that ignores day/paging params.)

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
