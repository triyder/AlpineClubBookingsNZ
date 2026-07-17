/**
 * LEGACY fallback for the deferred non-member "guest portion" figure (#2003).
 *
 * A split party (#738) charges the member places up front and defers the
 * non-member guests' places to closer to the stay, shown as "about $X" on the
 * wizard review-step banner (#1942) and the pay step (#1976).
 *
 * IMPORTANT — this whole-party sum is NOT the authoritative deferred figure, and
 * the two surfaces do NOT "agree by construction". The charge authority is
 * booking-create pricing the NON-MEMBER SUBSET on its own (its split child's
 * `finalPriceCents`), and a group discount can price that subset DIFFERENTLY
 * than the whole-party quote: the subset can fall under `minGroupSize` while the
 * full party meets it, so the whole party's non-member rows may be
 * group-discounted while the subset that is charged is not. Summing those rows
 * therefore UNDER-QUOTES the deferred charge under group discounts.
 *
 * The single source of the figure is instead the server helper
 * `priceDeferredNonMemberPortion` (src/lib/policies/booking-route-decisions.ts),
 * which both the booking quote and booking-create call so the review banner
 * shows exactly what is charged. The review step consumes
 * `priceQuote.deferredGuestPortionCents` from that helper; `sumDeferredGuestPortionCents`
 * below survives ONLY as the fallback for an old cached quote that predates the
 * field. This module stays dependency-free so the client review step can import
 * the fallback without pulling in server-only pricing code.
 */

/**
 * A guest row carrying just what the fallback sum needs: whether the guest is a
 * member, and their own priced total in integer cents. The wizard's
 * `PriceQuote` guest rows structurally satisfy this.
 */
export interface DeferredGuestPortionGuest {
  isMember: boolean;
  priceCents: number;
}

/**
 * LEGACY fallback: sum the whole-party quote's non-member guest rows in integer
 * cents. Used ONLY when `priceQuote.deferredGuestPortionCents` is absent (an old
 * cached quote). Under a group discount this can under-quote the real deferred
 * charge (see the module header); prefer the server figure. Money stays in
 * integer cents; this only adds, it never rounds.
 */
export function sumDeferredGuestPortionCents(
  guests: readonly DeferredGuestPortionGuest[],
): number {
  return guests.reduce(
    (sum, guest) => (guest.isMember ? sum : sum + (guest.priceCents || 0)),
    0,
  );
}
