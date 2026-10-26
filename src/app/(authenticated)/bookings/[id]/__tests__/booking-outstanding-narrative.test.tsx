import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { resolveBookingNarrative, type NarrativeEvent } from "@/lib/booking-narrative";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import { bindClubFormat } from "@/lib/club-format-bound";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { BookingStatusBanners } from "../_components/booking-status-banners";
const club = bindClubTime(requireClubTimeZone("Pacific/Auckland"), CLUB_FORMAT_TEST);
function narrative(pending: boolean, review = false, events: NarrativeEvent[] = [], status = "COMPLETED") {
  return resolveBookingNarrative({ booking: { status, firstName: "Member", finalPriceCents: 3000,
    adminReviewStatus: null, adminReviewNotes: null, adminReviewReason: null,
    amountOwed: { owedCents: 3000, dueCents: 3000, appliedCreditCents: 0 }, checkIn: new Date("2026-06-01T00:00:00Z"), checkOut: new Date("2026-06-02T00:00:00Z") },
    events, club, additionalCollectionPending: pending, financialReviewPending: review }, CLUB_FORMAT_TEST);
}
describe("additional evidence and the status narrative", () => {
  it("suppresses no-payment/nothing-more-to-do reassurance for positive or unknown extras", () => {
    expect(narrative(true).message).not.toContain("No payment was required");
    expect(narrative(true).nextStep).not.toContain("Nothing more to do");
    expect(narrative(false).message).toContain("No payment was required");
  });
  it("preserves durable received-payment facts while an additional amount is owed", () => {
    const result = narrative(true, false, [{ type: "MEMBER_PAID", occurredAt: new Date("2026-06-01T00:00:00Z"), amountCents: 5000, reason: null, snapshot: null }]);
    expect(result.message).toContain("received your payment of $50.00");
    expect(result.nextStep).not.toContain("Nothing more to do");
  });
  it("keeps the canonical financial-review clauses when a separate priced addition coexists", () => {
    const result = narrative(true, true);
    expect(result.message).toContain("working out what that change means");
    expect(result.message).toContain("Nothing has been refunded or charged for it yet");
    expect(result.nextStep).toContain("about that change");
    expect(result.message).not.toContain("No payment was required");
  });
  it("keeps a linked guest's confirmation neutral while officers who are also guests see money", () => {
    const received = narrative(true, false, [{ type: "MEMBER_PAID", occurredAt: new Date("2026-06-01T00:00:00Z"), amountCents: 5000, reason: null, snapshot: null }]);
    const render = (canSeeOwnerCredit: boolean) => renderToStaticMarkup(<BookingStatusBanners
      booking={{ status: "COMPLETED", creditElectionCents: null } as never} club={club} money={bindClubFormat(CLUB_FORMAT_TEST)}
      viewer={{ isBookingOwner: false, nonOwnerAdminViewer: canSeeOwnerCredit, isLinkedGuestViewer: true, canSeeOwnerCredit } as never}
      access={{ isDeleted: false } as never} party={{} as never} payment={{ showCompletePaymentCard: false } as never}
      history={{ bookingNarrative: received, moneyReconciliation: { visibility: "WITHHELD" } } as never} messages={{} as never} />);
    expect(render(false)).toContain("This stay is confirmed");
    expect(render(false)).not.toContain("$50.00");
    expect(render(true)).toContain("$50.00");
  });
  it.each(["PENDING", "PAYMENT_PENDING", "CONFIRMED", "PAID", "COMPLETED"])("keeps guest financial-review copy private and accurate for %s", (status) => {
    const review = narrative(true, true, [], status);
    expect(review.state).toBe("financial_review_pending");
    const html = renderToStaticMarkup(<BookingStatusBanners
      booking={{ status, creditElectionCents: null } as never} club={club} money={bindClubFormat(CLUB_FORMAT_TEST)}
      viewer={{ isBookingOwner: false, isLinkedGuestViewer: true, canSeeOwnerCredit: false } as never}
      access={{ isDeleted: false } as never} party={{} as never} payment={{ showCompletePaymentCard: false } as never}
      history={{ bookingNarrative: review, moneyReconciliation: { visibility: "WITHHELD" } } as never}
      messages={{ financialReviewPendingDescription: "Private financial review detail" } as never} />);
    if (status === "PENDING" || status === "PAYMENT_PENDING") {
      expect(html).toContain("This booking is awaiting confirmation.");
      expect(html).not.toContain("This stay is confirmed");
      expect(html).not.toContain("Booking confirmed");
    } else expect(html).toContain("This stay is confirmed.");
    expect(html).not.toContain("$");
    expect(html).not.toContain("Private financial review detail");
    expect(html).not.toContain("charged");
  });
});
