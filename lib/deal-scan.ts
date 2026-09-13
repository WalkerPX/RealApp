import {
  fetchFmvMedian,
  fetchMarketplaceListings,
  fetchPlayerEarnings,
  fetchPlayerListings,
  realListingUrl,
  searchPlayerId,
} from "./real-api";
import {
  CURRENT_SEASONS,
  RARITY_LABELS,
  boostLabel,
  listingPlayerLabel,
  listingPrice,
  listingRating,
  normName,
  playerMatches,
  seasonErrorMessage,
  type Deal,
  type DealFilters,
  type DealsResult,
  type RawListing,
} from "./deals";

// The route declares maxDuration = 60 (Vercel Pro/fluid), so a scan may run
// long — this cap stays clear of it. Each slice is its own request, so a
// multi-sport sweep is bounded by slices × this budget, not by one call.
const MAX_ELAPSED_MS = 45_000;
const MAX_LOOKUPS = 130; // FMV + earnings lookups per scan (~3/s of the budget)
const MAX_BUCKET_PAGES = 200; // safety ceiling per rarity/type bucket (10/page)
// Sequential requests only (never parallel): a rate-limit hit on Real is
// sticky, so a small floor between requests keeps volume polite over a long
// scan. The gap is jittered — a fixed millisecond metronome is itself a bot
// fingerprint, and no real browser fetches at a perfectly constant cadence.
const GAP_MIN_MS = 140;
const GAP_MAX_MS = 420;
const gap = () =>
  GAP_MIN_MS + Math.floor(Math.random() * (GAP_MAX_MS - GAP_MIN_MS + 1));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Scan a filtered slice of the marketplace for deals:
 *   - discount deal: price ≥ minDiscountPct below the FMV median,
 *   - ROI deal (past seasons only): remaining OTD earnings > price, or
 *   - rating deal: price under `ratingFactor` × the card's own rating.
 *
 * Two search shapes, because the two are not interchangeable:
 *
 *  - **Named players** (`players`): the name is resolved to a player entity id
 *    through Real's own search, then that player's listings are asked for
 *    directly (`filterEntityType=player`). This is the only shape that can
 *    find a specific player's cards — see the note on bucket paging below.
 *  - **No names**: each rarity/type bucket is walked for its first pages.
 *
 * Bucket paging is best-effort by necessity: `/cardmarketplacelistings`
 * returns the same first page for a query no matter what `offset`/
 * `beforeEndsAt` say (verified against the live API — both are ignored), so a
 * bucket sweep can only ever see its first ~10 listings per rarity/type. Pass
 * player names when the target is a specific card or player.
 */
export async function scanDeals(f: DealFilters): Promise<DealsResult> {
  const started = Date.now();
  const queries = (f.players ?? []).map(normName).filter(Boolean);
  const requested = (f.players ?? []).map((p) => p.trim()).filter(Boolean);
  const out: Deal[] = [];
  const seen = new Set<number>();
  let scanned = 0;
  let lookedUp = 0;
  let timedOut = false;
  const unresolved: string[] = [];

  const over = () => {
    if (Date.now() - started > MAX_ELAPSED_MS) {
      timedOut = true;
      return true;
    }
    return false;
  };

  const ratingMode = f.mode === "rating";
  const factor = f.ratingFactor && f.ratingFactor > 0 ? f.ratingFactor : 12;
  const roiEligible = !ratingMode && CURRENT_SEASONS[f.sport] !== f.season;

  // Named players: resolve to entity ids first — everything downstream hangs
  // off the id, and an unresolved name is worth reporting rather than
  // silently returning zero deals.
  const playerIds: number[] = [];
  if (requested.length) {
    for (const name of requested) {
      if (over()) break;
      let id: number | null = null;
      try {
        id = await searchPlayerId(f.sport, name);
      } catch (e) {
        // A dead search endpoint is a real problem, not a missing player.
        if (e instanceof Error && /auth/i.test(e.message)) throw e;
        id = null;
      }
      if (id == null) unresolved.push(name);
      else if (!playerIds.includes(id)) playerIds.push(id);
      await sleep(gap());
    }
  }

  /** Screen one listing and, if it qualifies, add it to the result set.
   * `scoped` listings came back already filtered to a player by Real, so the
   * client-side name match is skipped for them (play cards are labelled with
   * initials — "R. Browne" would never match a typed "Ryan Browne"). */
  const consider = async (l: RawListing, scoped: boolean, ltype: string) => {
    if (over()) return;
    if (seen.has(l.id)) return;
    // Real returns a bucket/player's listings soonest-ending first, so the head
    // of every page is made of auctions that expire (or sell) within minutes.
    // Drop anything already past its end — a dead auction is not a deal.
    const endsAtMs = l.endsAt ? Date.parse(l.endsAt) : NaN;
    if (Number.isFinite(endsAtMs) && endsAtMs <= Date.now()) return;
    if (f.auctionOnly && !l.canBid) return;
    const price = listingPrice(l);
    if (price == null || price <= 0) return;
    const player = listingPlayerLabel(l);
    if (!scoped && queries.length && !playerMatches(player, queries)) return;
    // Lookup budget only matters in discount mode — rating mode reads
    // everything it needs straight off the listing.
    if (!ratingMode && lookedUp >= MAX_LOOKUPS) return;

    const card = l.card ?? {};
    const level = card.boostInfo?.level ?? null;
    const rating = listingRating(l);
    let median: number | null = null;
    let discountPct: number | null = null;

    if (ratingMode) {
      if (rating == null) return; // no rating on the listing — can't screen it
    } else {
      median = await fetchFmvMedian(l.cardId, ltype).catch(() => null);
      lookedUp++;
      discountPct = median && median > 0 ? ((median - price) / median) * 100 : null;
    }

    // ROI: only for bulk player passes of past seasons (play cards have
    // no earnings calendar; current seasons have no future dates yet).
    let remaining: number | null = null;
    if (
      roiEligible &&
      ltype === "userpassfull" &&
      l.playerId &&
      lookedUp < MAX_LOOKUPS
    ) {
      const earn = await fetchPlayerEarnings(f.sport, f.season, l.playerId, level);
      lookedUp++;
      if (earn) remaining = earn.remaining;
    }

    const isDiscountDeal =
      !ratingMode && discountPct != null && discountPct >= f.minDiscountPct;
    const isRoiDeal = !ratingMode && remaining != null && remaining > price;
    const ratingCap = ratingMode && rating != null ? rating * factor : null;
    const isRatingDeal = ratingCap != null && price < ratingCap;
    if (!isDiscountDeal && !isRoiDeal && !isRatingDeal) return;

    seen.add(l.id);
    out.push({
      listingId: l.id,
      type: ltype as Deal["type"],
      rarity: l.rarity,
      rarityLabel: RARITY_LABELS[l.rarity] ?? String(l.rarity),
      boost: boostLabel(l),
      player,
      price,
      median,
      discountPct: discountPct != null ? Math.round(discountPct * 10) / 10 : null,
      remaining,
      endsAt: l.endsAt ?? null,
      canBid: !!l.canBid,
      url: realListingUrl(l.id),
      isDiscountDeal,
      isRoiDeal,
      rating,
      isRatingDeal,
      ratingCap,
      // In rating mode the "upside" is how far under the ceiling it sits.
      upside: isRatingDeal
        ? (ratingCap as number) - price
        : Math.max(
            remaining != null ? remaining - price : -1,
            median != null ? median - price : -1
          ),
    });
  };

  if (playerIds.length) {
    // Player-scoped path: every rarity/type for each resolved player, one
    // request per combination (Real returns that player's full set, so there
    // is nothing to page).
    outer: for (const ltype of f.listingTypes) {
      for (const rarity of f.rarities) {
        for (const pid of playerIds) {
          if (over()) break outer;
          let page;
          try {
            page = await fetchPlayerListings({
              sport: f.sport,
              season: f.season,
              rarity,
              listingType: ltype,
              playerId: pid,
            });
          } catch (e) {
            if (e instanceof Error && seasonErrorMessage(e.message)) throw e;
            continue; // bucket hiccup — try the next one
          }
          scanned += page.listings.length;
          for (const l of page.listings) await consider(l, true, ltype);
          await sleep(gap());
        }
      }
    }
  } else {
    outer2: for (const ltype of f.listingTypes) {
      for (const rarity of f.rarities) {
        let cursor: string | undefined;
        let prevCursor = "";
        let fetched = 0;
        let bucketTotal = 0; // market count for this query, from the first page
        for (let page = 0; page < MAX_BUCKET_PAGES; page++) {
          if (over()) break outer2;
          if (page > 0) await sleep(gap()); // jittered politeness floor between pages
          let listings;
          try {
            const res = await fetchMarketplaceListings({
              sport: f.sport,
              season: f.season,
              rarity,
              listingType: ltype,
              beforeEndsAt: cursor,
            });
            listings = res.listings;
            bucketTotal = res.listingCount || bucketTotal;
          } catch (e) {
            // A bad sport/season slice is a config bug — abort loudly instead
            // of skipping it as a page hiccup.
            if (e instanceof Error && seasonErrorMessage(e.message)) throw e;
            break; // page/rarity hiccup — move on
          }
          if (!listings.length) break;
          fetched += listings.length;
          scanned += listings.length;

          for (const l of listings) await consider(l, false, ltype);

          cursor = listings.reduce(
            (m, x) => (x.endsAt && x.endsAt < m ? x.endsAt : m),
            listings[0].endsAt ?? ""
          );
          if (!cursor || cursor === prevCursor) break; // exhausted / no progress
          prevCursor = cursor;
          if (bucketTotal > 0 && fetched >= bucketTotal) break; // bucket fully covered
        }
      }
    }
  }

  out.sort((a, b) => b.upside - a.upside);
  return {
    deals: out,
    scanned,
    lookedUp,
    timedOut,
    elapsedMs: Date.now() - started,
    unresolved,
  };
}
