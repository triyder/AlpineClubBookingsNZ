/**
 * The guest lines of a booking invoice (#713, #1163, #1930, #3170).
 *
 * Its own module so the member-money primary-invoice planner can call the
 * builder the sender calls, without importing the sender (`INV-SSOT`).
 * `xero-booking-invoices.ts` re-exports it for its existing importers. The
 * per-guest runs are the shared, provider-neutral builder's (fork #115).
 */

import type { LineItem } from "xero-node";
import {
  describeGuestRateMembershipLabel,
  type HutFeeItemCodeResolver,
} from "./xero-mappings";
import {
  applyHutFeeLineCodes,
  resolveHutFeeLineItemCode,
} from "@/lib/xero-hut-fee-line-codes";
import { formatDateOnly } from "@/lib/date-only";
import {
  buildGuestInvoiceLines,
  type GuestInvoiceRun,
} from "@/lib/booking-guest-invoice-lines";

/**
 * Build Xero invoice line items from a booking's guests and stay nights.
 * Exported for testing.
 *
 * @param itemCodeResolver - Per-guest hut-fee item code resolver keyed by
 *   membership type (#1930, E4). When provided with a seasonType, each guest
 *   gets its own item code from its rateMembershipType snapshot (NULL falls
 *   back isMember -> FULL/NON_MEMBER).
 * @param itemCode - Single hutFeesIncome item code applied to all guests, used
 *   only when the resolver is absent/unconfigured or no seasonType is known —
 *   never as a fallback for a per-guest miss once keyed rows exist.
 */
export function buildInvoiceLineItems(
  guests: Array<{
    firstName: string;
    lastName: string;
    ageTier: string;
    isMember: boolean;
    // Rate-membership-type snapshot (#1930, E4) — drives the hut-fee item code.
    rateMembershipTypeId?: string | null;
    priceCents: number;
    // Per-night rows (issue #713). When present, line items are emitted per
    // contiguous run; otherwise the guest is billed as one line over the whole
    // booking range, the pre-#713 behaviour.
    // #3170: a night whose stored price is `null` is a night whose sold price is
    // NOT KNOWN — written by a parked edit that committed a structural change
    // without valuing it. See the guest branch below for what this builder does
    // with one, and why it does not simply drop it.
    nights?: Array<{ stayDate: Date; priceCents: number | null }> | null;
  }>,
  checkIn: Date,
  checkOut: Date,
  nights: number,
  accountCode: string = "200",
  itemCode?: string | null,
  accountCodeExplicitlyConfigured: boolean = false,
  itemCodeResolver?: HutFeeItemCodeResolver,
  seasonType?: string | null,
): LineItem[] {
  // The precedence itself (#1930, E4) lives in `xero-hut-fee-line-codes.ts`,
  // shared with the itemised modification documents (#3530) so a night's money
  // is coded the same way whichever document carries it.
  const applyCodes = (
    lineItem: LineItem,
    guest: { ageTier: string; isMember: boolean; rateMembershipTypeId?: string | null },
  ) =>
    applyHutFeeLineCodes(lineItem, {
      itemCode: resolveHutFeeLineItemCode(guest, { itemCodeResolver, seasonType, itemCode }),
      accountCode,
      accountCodeExplicitlyConfigured,
    });

  const runToLineItem = (
    run: GuestInvoiceRun,
    guest: {
      firstName: string;
      lastName: string;
      ageTier: string;
      isMember: boolean;
      rateMembershipTypeId?: string | null;
    }
  ): LineItem => {
    const description = [
      `${guest.firstName} ${guest.lastName}`,
      // #2543: the label follows the RATE snapshot, so it agrees with the item
      // code `applyCodes` resolves from the same field. See
      // `describeGuestRateMembershipLabel`.
      `(${guest.ageTier}, ${describeGuestRateMembershipLabel(itemCodeResolver, guest)})`,
      `${run.nightCount} night${run.nightCount !== 1 ? "s" : ""}`,
      `${formatDateOnly(run.startDate)} - ${formatDateOnly(run.endExclusive)}`,
    ].join(" - ");
    // perNightCents * nightCount === totalCents by construction, so the line
    // reconciles to the exact cent total (#1163).
    return applyCodes({
      description,
      quantity: run.nightCount,
      unitAmount: run.perNightCents / 100, // Xero uses dollars, not cents
      taxType: "OUTPUT2", // GST on Income (NZ)
    }, guest);
  };

  // The per-guest runs are the shared, provider-neutral builder's (fork #115),
  // so the generated booking invoice PDF bills exactly these cents; this
  // function only words and codes them for Xero.
  return buildGuestInvoiceLines(guests, checkIn, checkOut, nights).map((line) =>
    runToLineItem(line.run, line.guest),
  );
}
