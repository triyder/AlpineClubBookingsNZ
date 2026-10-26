import type { EditFinancialReviewContext } from "@/lib/edit-financial-review-context";
import { requireCalendarDate } from "@/lib/club-time";

export function observationReviewContext(bookingId: string, modificationId: string): EditFinancialReviewContext {
  return {
    version: 1, bookingModificationId: modificationId, guestMemberId: null,
    bookingCheckIn: requireCalendarDate("2026-06-01"), bookingCheckOut: requireCalendarDate("2026-06-02"),
    occurrence: { bookingId, bookingGuestId: "synthetic-guest", cause: "NO_STORED_NIGHT_PRICES",
      surrenderedNightDates: [requireCalendarDate("2026-06-01")], addedNightDates: [], storedEvidence: { guestTotalCents: null, nightPrices: [] } },
  };
}
