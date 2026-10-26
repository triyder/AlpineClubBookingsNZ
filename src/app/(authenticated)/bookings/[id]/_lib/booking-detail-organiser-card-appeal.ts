import { prisma } from "@/lib/prisma";
import { organiserCardAppealCeilingFor, type OrganiserCardAppealCeiling } from "@/lib/organiser-child-refund";

/**
 * #3956 (`INV-PAY-123`): on a cancelled booking the group organiser paid for by
 * card, the most a refund appeal can ask for is what the organiser's combined
 * payment can still return (`organiserCardAppealCeilingFor`) - the figure the
 * appeal route and its approval cap at - not the booking's own payment row alone.
 * Null for any other booking, which keeps `refundAppealCeilingParts`. While the group
 * cancel's own refund is not made, it says so (`combinedRefundPending`) rather
 * than reading as "nothing left".
 */
export async function loadOrganiserCardAppealCeiling(booking: {
  id: string;
  status: string;
  organiserSettled: boolean;
  parentBookingId: string | null;
  payment: { id: string; source: string; status: string; amountCents: number; refundedAmountCents: number } | null;
}): Promise<OrganiserCardAppealCeiling | null> {
  if (booking.status !== "CANCELLED" || !booking.payment) return null;
  return organiserCardAppealCeilingFor(prisma, booking, booking.payment);
}
