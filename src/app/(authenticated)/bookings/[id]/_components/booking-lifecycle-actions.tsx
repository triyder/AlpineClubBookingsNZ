import type { BoundClubFormat } from "@/lib/club-format-bound";
import { CancelBookingButton } from "@/components/cancel-booking-button";
import { DeleteBookingButton } from "@/components/delete-booking-button";
import { RefundAppealButton } from "@/components/refund-appeal-button";
import { ORGANISER_CARD_APPEAL_PENDING_MEMBER_NOTE } from "@/lib/group-organiser-paid";
import { appealCardRefundOwedMemberNote } from "@/lib/refund-request-card-refund-copy";
import type { BookingDetailRecord } from "../_lib/load-booking-detail";
import type { BookingDetailViewer } from "../_lib/booking-detail-viewer";
import type { BookingDetailEditAccess } from "../_lib/booking-detail-edit-access";
import type { BookingDetailPayment } from "../_lib/booking-detail-payment";
import type { BookingDetailMessages } from "../_lib/booking-detail-messages";

/**
 * THE LIFECYCLE ACTIONS (#2958): cancel, delete (draft or soft-delete
 * cancelled) and the refund appeal. Each button fronts a server route that
 * authorizes for itself; the gates here are the page's own, unchanged, so no
 * button is offered that its route would refuse. Moved verbatim from
 * `page.tsx`.
 */
export function BookingLifecycleActions({
  booking,
  viewer,
  access,
  payment,
  messages,
  canDeleteDraft,
  canSoftDeleteCancelled,
  backHref,
  money,
  organiserCardAppeal = false,
  organiserCardAppealPending = false,
}: {
  booking: BookingDetailRecord;
  viewer: BookingDetailViewer;
  access: BookingDetailEditAccess;
  payment: BookingDetailPayment;
  messages: BookingDetailMessages;
  canDeleteDraft: boolean;
  canSoftDeleteCancelled: boolean;
  backHref: string;
  money: BoundClubFormat;
  /** #3956: the appeal ceiling is the group organiser's card payment's (`organiserCardAppealCeilingFor`). */
  organiserCardAppeal?: boolean;
  /** #3956: ...and the group cancel's own refund to that card is not made yet, so the appeal waits (`combinedRefundPending`). */
  organiserCardAppealPending?: boolean;
}) {
  const { viewerAuthorizationRole, actingOnBehalf, canManageBooking } = viewer;
  const { canCancel, isDeleted } = access;
  const { maxRefundableCents, appealCardRefundOwedCents } = payment;
  const { refundAppealDescription } = messages;
  return (
    <>
      {canCancel && (
        <CancelBookingButton
          bookingId={booking.id}
          refundAppealDescription={refundAppealDescription}
          onBehalfOfMember={actingOnBehalf}
          // Issue #1705: the notify dialog shows iff the cancel route will
          // honour the choice — viewerAuthorizationRole is the same
          // booking-management role the route resolves for its 403 gate.
          canChooseMemberEmail={viewerAuthorizationRole === "ADMIN"}
          canOverrideHostingCoverage={viewerAuthorizationRole === "ADMIN"}
          // #2259: with the switch on there is no email choice to honour, so
          // the dialog states that instead of asking. Spread rather than a
          // conditional value, so a member's payload carries no `noEmails` KEY
          // at all — React Flight serialises the key too, and `noEmails:false`
          // would still tell a member the switch exists.
          {...(viewerAuthorizationRole === "ADMIN"
            ? { noEmails: booking.noEmails }
            : {})}
        />
      )}

      {canDeleteDraft ? (
        <DeleteBookingButton
          bookingId={booking.id}
          mode="draft"
          returnHref={backHref}
        />
      ) : null}

      {canSoftDeleteCancelled ? (
        <DeleteBookingButton
          bookingId={booking.id}
          mode="cancelled"
          returnHref={backHref}
        />
      ) : null}

      {/* Refund appeal: owner-or-Full-Admin only, matching its backing route
          (/api/bookings/[id]/refund-request, owner-or-hasAdminAccess). The
          #1289 read-only guard now admits Booking Officers / read-only admins to
          this page, and this control previously carried no viewer gate, so it
          would have shown them a button that 403s. canManageBooking restores the
          intended owner + Full-Admin audience. */}
      {canManageBooking &&
        !isDeleted &&
        booking.status === "CANCELLED" &&
        booking.payment &&
        booking.payment.status !== "REFUNDED" &&
        organiserCardAppealPending && (
          // A wait, not "nothing left": the button stays hidden (the member's
          // appeal route refuses meanwhile) and the line says why.
          <p className="text-sm text-muted-foreground">{ORGANISER_CARD_APPEAL_PENDING_MEMBER_NOTE}</p>
        )}
      {canManageBooking &&
        !isDeleted &&
        booking.status === "CANCELLED" &&
        booking.payment &&
        booking.payment.status !== "REFUNDED" &&
        maxRefundableCents > 0 && (
          <RefundAppealButton
            bookingId={booking.id}
            maxRefundableCents={maxRefundableCents}
            description={refundAppealDescription}
            organiserCardRefund={organiserCardAppeal}
            cardRefundOwedCents={appealCardRefundOwedCents}
          />
        )}
      {canManageBooking &&
        !isDeleted &&
        booking.status === "CANCELLED" &&
        booking.payment &&
        booking.payment.status !== "REFUNDED" &&
        maxRefundableCents <= 0 &&
        appealCardRefundOwedCents > 0 &&
        // Only where the appeal button would otherwise offer an appeal: never
        // beside one already pending (the button's own `hasPending`).
        !booking.refundRequests.some((request) => request.status === "PENDING") && (
          // #4124: the button is hidden because a card refund not yet made is
          // everything left to refund - say so rather than hide it silently.
          <p className="text-sm text-muted-foreground">
            {appealCardRefundOwedMemberNote(money.cents(appealCardRefundOwedCents), true)}
          </p>
        )}
    </>
  );
}
