/**
 * Single owner of the deferred non-member "guest portion" figure (#2003).
 *
 * A split party (#738) charges the member places up front and defers the
 * non-member guests' places to closer to the stay. Two surfaces show that
 * deferred sub-amount, hedged as "about $X":
 *
 *   - the wizard review-step banner (#1942), rendered BEFORE any booking exists,
 *     from the client's price quote; and
 *   - the pay step (#1976), rendered from the server split summary
 *     (getProvisionalNonMemberChildSummary → ProvisionalChildSummary), whose
 *     `deferredAmountCents` IS the split child's server-priced `finalPriceCents`.
 *
 * They agree under normal pricing but used to be summed independently. This is
 * the one function that defines the figure — the sum of the non-member guests'
 * own priced totals in integer cents — so the two surfaces cannot drift apart
 * from two hand-written reductions.
 *
 * It matches the server figure by construction: booking-create prices the
 * non-member subset with `calculateBookingPrice` and stores
 * `finalPriceCents = totalPriceCents = Σ non-member priceCents` on the child (no
 * promo on the child), and `calculateBookingPrice`'s own total is exactly this
 * same sum. Money stays in integer cents; this only adds, it never rounds. This
 * module is intentionally dependency-free so client components (the review step)
 * can import it without pulling in server-only code.
 */

/**
 * A guest row carrying just what the deferred-portion figure needs: whether the
 * guest is a member, and their own priced total in integer cents. The wizard's
 * `PriceQuote` guest rows and the server `PriceBreakdown` guest rows both
 * structurally satisfy this, so either can be summed by the same function.
 */
export interface DeferredGuestPortionGuest {
  isMember: boolean;
  priceCents: number;
}

/**
 * The deferred (non-member) guest portion in integer cents: the sum of the
 * non-member guests' own priced totals. See the module header for why this is
 * the single owner of the figure and why it equals the server's child
 * `finalPriceCents` by construction.
 */
export function sumDeferredGuestPortionCents(
  guests: readonly DeferredGuestPortionGuest[],
): number {
  return guests.reduce(
    (sum, guest) => (guest.isMember ? sum : sum + (guest.priceCents || 0)),
    0,
  );
}
