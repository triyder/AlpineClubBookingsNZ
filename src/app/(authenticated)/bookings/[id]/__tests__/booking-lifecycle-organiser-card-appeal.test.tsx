import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/cancel-booking-button", () => ({ CancelBookingButton: () => null }));
vi.mock("@/components/delete-booking-button", () => ({ DeleteBookingButton: () => null }));
vi.mock("@/components/refund-appeal-button", () => ({
  RefundAppealButton: ({ maxRefundableCents, cardRefundOwedCents }: { maxRefundableCents: number; cardRefundOwedCents?: number }) => (
    <button type="button">Appeal up to {maxRefundableCents}, card owed {cardRefundOwedCents ?? 0}</button>
  ),
}));

import { bindClubFormat } from "@/lib/club-format-bound";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { BookingLifecycleActions } from "../_components/booking-lifecycle-actions";

/**
 * #3956 round 3: on a cancelled booking the group organiser paid for by card, a
 * zero appeal ceiling that is only a wait for the group cancellation's own
 * refund shows a line saying so, not a silently missing appeal.
 */
const WAITING = "The group's cancellation refund is still being processed; you can appeal once it has been made.";

function render(options: {
  maxRefundableCents: number;
  organiserCardAppealPending?: boolean;
  appealCardRefundOwedCents?: number;
  organiserCardAppeal?: boolean;
  refundRequests?: Array<{ status: string }>;
}) {
  return renderToStaticMarkup(
    <BookingLifecycleActions
      booking={{ id: "booking-1", status: "CANCELLED", noEmails: false, payment: { status: "SUCCEEDED" }, refundRequests: options.refundRequests ?? [] } as never}
      viewer={{ canManageBooking: true, actingOnBehalf: false, viewerAuthorizationRole: "USER" } as never}
      access={{ canCancel: false, isDeleted: false } as never}
      payment={{ maxRefundableCents: options.maxRefundableCents, appealCardRefundOwedCents: options.appealCardRefundOwedCents ?? 0 } as never}
      messages={{ refundAppealDescription: "" } as never}
      canDeleteDraft={false}
      canSoftDeleteCancelled={false}
      backHref="/bookings"
      money={bindClubFormat(CLUB_FORMAT_TEST)}
      organiserCardAppeal={options.organiserCardAppeal ?? true}
      organiserCardAppealPending={options.organiserCardAppealPending ?? false}
    />,
  );
}

describe("booking page organiser-card appeal while the group refund is pending (#3956)", () => {
  it("hides the appeal button and says the appeal waits", () => {
    const html = render({ maxRefundableCents: 0, organiserCardAppealPending: true });
    expect(html).toContain(WAITING.replace("'", "&#x27;"));
    expect(html).not.toContain("<button");
  });

  it("offers the appeal, with no waiting line, once the refund is made", () => {
    const html = render({ maxRefundableCents: 4_000 });
    expect(html).toContain("Appeal up to 4000, card owed 0");
    expect(html).not.toContain("still being processed");
  });

  it("shows neither the button nor the waiting line when the ceiling is zero and nothing is pending", () => {
    const html = render({ maxRefundableCents: 0 });
    expect(html).not.toContain("<button");
    expect(html).not.toContain("still being processed");
  });
});

/**
 * #4124: a card refund not yet made is netted from the appeal ceiling. The
 * owner is told so - in the form while something is still left to appeal for,
 * and in place of the button when that refund is everything still refundable.
 */
describe("booking page appeal ceiling lowered by a card refund not yet made (#4124)", () => {
  it("passes the card refund still owed to the appeal form beside a ceiling above zero", () => {
    const html = render({ maxRefundableCents: 1_500, appealCardRefundOwedCents: 2_500, organiserCardAppeal: false });
    expect(html).toContain("Appeal up to 1500, card owed 2500");
    expect(html).not.toContain("still owed back");
  });

  it("says why there is nothing to appeal for when that refund takes the ceiling to zero", () => {
    const html = render({ maxRefundableCents: 0, appealCardRefundOwedCents: 2_500, organiserCardAppeal: false });
    expect(html).not.toContain("<button");
    expect(html).toContain("is still owed back to you, so there is nothing more to appeal for while that refund is outstanding");
    expect(html).not.toContain("your card");
    expect(html).toContain("25.00");
  });

  it("says nothing beside an appeal already pending, where the button would not offer one either", () => {
    const html = render({
      maxRefundableCents: 0,
      appealCardRefundOwedCents: 2_500,
      organiserCardAppeal: false,
      refundRequests: [{ status: "PENDING" }],
    });
    expect(html).not.toContain("still owed back");
  });

  it("CONTROL: an earlier appeal already decided does not hide it", () => {
    const html = render({
      maxRefundableCents: 0,
      appealCardRefundOwedCents: 2_500,
      organiserCardAppeal: false,
      refundRequests: [{ status: "APPROVED" }],
    });
    expect(html).toContain("still owed back to you");
  });

  it("stays silent at a zero ceiling no card refund explains", () => {
    const html = render({ maxRefundableCents: 0, appealCardRefundOwedCents: 0, organiserCardAppeal: false });
    expect(html).not.toContain("still owed back");
  });
});
