import {
  fetchFmvMedian,
  fetchMarketplaceListings,
  fetchPlayerEarnings,
  realListingUrl,
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
} from "./deals";

// The route declares maxDuration = 60 (Vercel Pro/fluid), so a scan may run
// long — this cap stays clear of it. Each slice is its own request, so a
// multi-sport sweep is bounded by slices × this budget, not by one call.
const MAX_ELAPSED_MS = 45_000;
const MAX_LOOKUPS = 130; // FMV + earnings lookups per scan (~3/s of the budget)
const MAX_BUCKET_PAGES = 200; // safety ceiling per rarity/type bucket (10/page)
// Sequential paging only (never parallel): a rate-limit hit on Real is sticky,
// so a small floor between page requests keeps volume polite over a long scan.
const PAGE_GAP_MS = 100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Scan a filtered slice of the marketplace for deals:
 *   - discount deal: price ≥ minDiscountPct below the FMV median, or
 *   - ROI deal (past seasons only): remaining OTD earnings > price.
 * Auctions-only by default, ending-soonest first. Each rarity/type bucket is
 * paged until fully covered (the API's listingCount for that query) so the
 * scanned count matches the market; time-boxed and page-capped for safety.
 * Returns best-first by upside (max of FMV gap / remaining margin).
 *
 * `mode: "rating"` swaps the whole screen: instead of an FMV discount (or ROI)
 * a listing qualifies when its price is under `ratingFactor` × the card's own
 * rating. No FMV/earnings lookups are made in that mode — the rating is already
 * on the listing — so the scan is fast and spends no lookup budget.
 */
export async function scanDeals(f: DealFilters): Promise<DealsResult> {
  const started = Date.now();
  const queries = (f.players ?? []).map(normName).filter(Boolean);
  const out: Deal[] = [];
  const seen = new Set<number>();
  let scanned = 0;
  let lookedUp = 0;
  let timedOut = false;

  const ratingMode = f.mode === "rating";
  const factor = f.ratingFactor && f.ratingFactor > 0 ? f.ratingFactor : 12;
  const roiEligible = !ratingMode && CURRENT_SEASONS[f.sport] !== f.season;

  outer: for (const ltype of f.listingTypes) {
    for (const rarity of f.rarities) {
      let cursor: string | undefined;
      let prevCursor = "";
      let fetched = 0;
      let bucketTotal = 0; // market count for this query, from the first page
      for (let page = 0; page < MAX_BUCKET_PAGES; page++) {
        if (Date.now() - started > MAX_ELAPSED_MS) {
          timedOut = true;
          break outer;
        }
        if (page > 0) await sleep(PAGE_GAP_MS); // politeness floor between pages
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

        for (const l of listings) {
          if (Date.now() - started > MAX_ELAPSED_MS) {
            timedOut = true;
            break outer;
          }
          if (seen.has(l.id)) continue;
          if (f.auctionOnly && !l.canBid) continue;
          const price = listingPrice(l);
          if (price == null || price <= 0) continue;
          const player = listingPlayerLabel(l);
          if (queries.length && !playerMatches(player, queries)) continue;
          // Lookup budget only matters in discount mode — rating mode reads
          // everything it needs straight off the listing.
          if (!ratingMode && lookedUp >= MAX_LOOKUPS) continue;

          const card = l.card ?? {};
          const level = card.boostInfo?.level ?? null;
          const rating = listingRating(l);
          let median: number | null = null;
          let discountPct: number | null = null;

          if (ratingMode) {
            if (rating == null) continue; // no rating on the listing — can't screen it
          } else {
            median = await fetchFmvMedian(l.cardId, ltype).catch(() => null);
            lookedUp++;
            discountPct =
              median && median > 0 ? ((median - price) / median) * 100 : null;
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
            const earn = await fetchPlayerEarnings(
              f.sport,
              f.season,
              l.playerId,
              level
            );
            lookedUp++;
            if (earn) remaining = earn.remaining;
          }

          const isDiscountDeal =
            !ratingMode && discountPct != null && discountPct >= f.minDiscountPct;
          const isRoiDeal = !ratingMode && remaining != null && remaining > price;
          const ratingCap = ratingMode && rating != null ? rating * factor : null;
          const isRatingDeal = ratingCap != null && price < ratingCap;
          if (!isDiscountDeal && !isRoiDeal && !isRatingDeal) continue;

          seen.add(l.id);
          out.push({
            listingId: l.id,
            type: ltype,
            rarity,
            rarityLabel: RARITY_LABELS[rarity] ?? String(rarity),
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
        }
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

  out.sort((a, b) => b.upside - a.upside);
  return { deals: out, scanned, lookedUp, timedOut, elapsedMs: Date.now() - started };
}
