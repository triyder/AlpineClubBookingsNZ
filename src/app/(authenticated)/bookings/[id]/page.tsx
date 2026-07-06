import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound, redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { formatCents } from "@/lib/utils";
import { CancelBookingButton } from "@/components/cancel-booking-button";
import { BookingPaymentSection } from "@/components/booking-payment-section";
import { SwitchToInternetBankingButton } from "@/components/switch-to-internet-banking-button";
import { BookingNotesEditor } from "@/components/booking-notes-editor";
import { BookingEditor, type BookingEditorData } from "@/components/booking-editor";
import { AdditionalPaymentCard } from "@/components/additional-payment-card";
import { ConfirmDraftButton } from "@/components/confirm-draft-button";
import { AdminBookingToolsCard } from "@/components/admin/admin-booking-tools-card";
import { ScrollToHash } from "@/components/scroll-to-hash";
import { ArrivalTimeEditor } from "@/components/arrival-time-editor";
import { RequestedRoomEditor } from "@/components/requested-room-editor";
import { WaitlistOfferCard } from "@/components/waitlist-offer-card";
import { DeleteBookingButton } from "@/components/delete-booking-button";
import { getBookingEditPolicy } from "@/lib/booking-edit-policy";
import { getBookingPaymentMode } from "@/lib/booking-payment-flow";
import { RefundAppealButton } from "@/components/refund-appeal-button";
import { humanizeStatus, paymentStatusClass } from "@/lib/status-colors";
import { BookingHelpDialog } from "@/components/booking-help-dialog";
import { loadCancellationPolicy } from "@/lib/cancellation";
import { describeCancellationSchedule } from "@/lib/cancellation-schedule";
import { WAITLIST_OFFER_HOURS } from "@/lib/waitlist";
import {
  getCancellationSettlementBreakdown,
  getPaymentDisplayStatus,
} from "@/lib/payment-status-display";
import {
  buildBookingHistoryItems,
  type BookingHistoryTone,
} from "@/lib/booking-history";
import {
  resolveBookingNarrative,
  type BookingNarrativeState,
  type NarrativeEvent,
} from "@/lib/booking-narrative";
import {
  getRemainingRefundableCents,
  hasCapturedPayment,
} from "@/lib/booking-payment-state";
import { isBookingFullyPaidForGuestNameEdits } from "@/lib/booking-modify";
import { isPaymentOwedBookingStatus } from "@/lib/booking-status";
import { isBookingBedAllocationLocked } from "@/lib/admin-bed-allocation";
import { getBookingProviderMismatches } from "@/lib/booking-provider-mismatches";
import { loadEmailMessageSettings } from "@/lib/email-message-settings";
import { loadPublicBookingMessages } from "@/lib/booking-message-settings";
import { renderBookingMessageTemplate } from "@/lib/booking-message-definitions";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { resolveInternalReturnPath } from "@/lib/internal-return-path";
import { OPENABLE_ORGANISER_STATUSES } from "@/lib/group-booking";
import { hasAdminAccess } from "@/lib/access-roles";
import {
  bookingManagementAuthorizationRole,
  hasAdminAreaAccess,
} from "@/lib/admin-permissions";
import {
  OrganiserGroupBookingCard,
  type OrganiserGroupState,
} from "@/components/group-booking/organiser-group-booking-card";

const historyToneClasses: Record<BookingHistoryTone, string> = {
  default: "border-slate-200 bg-slate-100 text-slate-700",
  success: "border-emerald-200 bg-emerald-100 text-emerald-800",
  warning: "border-amber-200 bg-amber-100 text-amber-800",
  danger: "border-rose-200 bg-rose-100 text-rose-800",
};

// States with a self-contained outcome worth surfacing as a banner. Active
// states (payable / under_review) already have their own dedicated UI below.
const NARRATIVE_BANNER_STATES = new Set<BookingNarrativeState>([
  "paid",
  "bumped",
  "cancelled_pre_payment",
  "cancelled_post_payment",
  "declined",
]);

const narrativeBannerClasses: Record<string, string> = {
  paid: "border-emerald-200 bg-emerald-50 text-emerald-900",
  bumped: "border-sky-200 bg-sky-50 text-sky-900",
  cancelled_pre_payment: "border-amber-200 bg-amber-50 text-amber-900",
  cancelled_post_payment: "border-amber-200 bg-amber-50 text-amber-900",
  declined: "border-rose-200 bg-rose-50 text-rose-900",
};

export default async function BookingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ returnTo?: string | string[] }>;
}) {
  const { id } = await params;
  const query = searchParams ? await searchParams : {};
  const session = await auth();
  if (!session) redirect("/login");
  const isAdmin = hasAdminAccess(session.user);
  // Issue #1313 (option A2): a Booking Officer (bookings:edit) resolves to ADMIN
  // so the edit policy and the BookingEditor treat them as acting on-behalf of
  // the member — matching the widened /api/bookings/[id]/modify authority. A
  // Full Admin already resolves to ADMIN; member / read-only viewers stay USER.
  const viewerAuthorizationRole = bookingManagementAuthorizationRole(session.user);

  const booking = await prisma.booking.findUnique({
    where: { id },
    include: {
      guests: { include: { nights: { select: { stayDate: true } } } },
      payment: true,
      member: { select: { firstName: true, lastName: true } },
      requestedRoom: {
        select: { id: true, name: true, active: true },
      },
      promoRedemption: {
        include: {
          promoCode: {
            select: {
              code: true,
              type: true,
              description: true,
              internal: true,
              workPartyEvent: { select: { name: true } },
            },
          },
        },
      },
      creditsFromCancellation: {
        select: {
          amountCents: true,
          description: true,
        },
      },
      modifications: {
        orderBy: { createdAt: "desc" },
      },
      refundRequests: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          reason: true,
          requestedAmountCents: true,
          approvedAmountCents: true,
          adminNotes: true,
          createdAt: true,
          reviewedAt: true,
        },
      },
      changeRequests: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          reason: true,
          adminNotes: true,
          requestedChanges: true,
          createdAt: true,
          reviewedAt: true,
        },
      },
      createdBy: {
        select: { firstName: true, lastName: true },
      },
      deletedBy: {
        select: { firstName: true, lastName: true, email: true },
      },
      adminReviewedBy: {
        select: { firstName: true, lastName: true },
      },
      // Split-booking group (#738): the member booking links to its provisional
      // non-member child(ren); the child links back to its member booking.
      parentBooking: {
        select: { id: true, status: true, finalPriceCents: true },
      },
      linkedBookings: {
        select: {
          id: true,
          status: true,
          finalPriceCents: true,
          hasNonMembers: true,
          guests: { select: { id: true } },
        },
      },
      // Group booking the owner organises on this booking (#796+). Drives the
      // organiser management card: join code, share link, open/close and (for
      // ORGANISER_PAYS) the combined settlement.
      groupBookingAsOrganiser: {
        select: {
          joinCode: true,
          status: true,
          paymentMode: true,
          joinDeadline: true,
          maxJoiners: true,
          settlement: {
            select: { status: true, amountCents: true, paidAt: true },
          },
          joins: {
            select: {
              id: true,
              isMember: true,
              contactFirstName: true,
              contactLastName: true,
              joinerMember: { select: { firstName: true, lastName: true } },
              booking: {
                select: {
                  status: true,
                  finalPriceCents: true,
                  guests: { select: { id: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!booking) notFound();
  if (booking.deletedAt && !isAdmin) notFound();
  const isBookingOwner = booking.memberId === session.user.id;
  const isLinkedGuestViewer =
    !isBookingOwner &&
    !isAdmin &&
    booking.guests.some((guest) => guest.memberId === session.user.id);
  const canManageBooking = isBookingOwner || isAdmin;
  // Issue #1289: Booking Officer / Read-only Admin reach the admin bookings
  // list and calendar (gated on bookings-area view), so the member-facing
  // detail route must admit the same viewers read-only for list/detail parity.
  // This is a genuinely read-only path (same shape as isLinkedGuestViewer):
  // every write/cancel/pay/modify/notes/admin-tools control below stays gated
  // on canManageBooking or isAdmin, so this predicate never widens a mutation.
  const canViewAsAdmin = hasAdminAreaAccess(session.user, {
    area: "bookings",
    level: "view",
  });
  if (!canManageBooking && !isLinkedGuestViewer && !canViewAsAdmin) {
    redirect("/bookings");
  }
  // Issue #1313 (option A2): a Booking Officer (the ADMIN_BOOKINGS bundle carries
  // bookings:edit) may operate the admin-tooling cluster AND the member-facing
  // write controls on ANY booking, not just one they own. The admin-tooling
  // controls front routes under /api/admin/bookings/* (copy,
  // confirm-pending-guests, admin requested-room) that already authorize on
  // bookings:edit. The member-facing /api/bookings/[id]/* routes (cancel, modify,
  // notes, arrival-time) are now widened to also accept bookings:edit (this PR),
  // so their buttons include canAdminEditBookings and flow through the same
  // admin-on-behalf path as a Full Admin (see actingOnBehalf below) — the button
  // and its backing API widen together, never a button ahead of its route.
  const canAdminEditBookings = hasAdminAreaAccess(session.user, {
    area: "bookings",
    level: "edit",
  });
  // Full Admins and Booking Officers both see the admin-operational tooling.
  const canSeeAdminTools = isAdmin || canAdminEditBookings;
  // Issue #1313 (option A2): a non-owner Full Admin OR Booking Officer cancels /
  // modifies on behalf of the member. Both flow through the SAME admin-on-behalf
  // semantics (suppress owner second-person framing, policy wording, and the
  // suppress-customer-notification path) rather than a separate officer code
  // path — so this one predicate replaces the earlier isAdmin-only actingAsAdmin.
  const actingOnBehalf = (isAdmin || canAdminEditBookings) && !isBookingOwner;
  // A non-owner admin-type viewer (Full Admin, Booking Officer, or read-only
  // admin) must not be addressed with owner second-person copy ("your place /
  // your stay") — issue #1289. Linked guests keep the member framing.
  const nonOwnerAdminViewer = !isBookingOwner && canViewAsAdmin;

  const bookingAuditLogs = await prisma.auditLog.findMany({
    where: {
      targetId: booking.id,
      action: {
        in: [
          "booking.payment.confirmed",
          "booking.payment.failed",
          "booking.modification.payment.confirmed",
          "booking.modification.payment.failed",
          "booking.cancel",
          "booking.delete.draft",
          "booking.delete.cancelled.soft",
        ],
      },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      action: true,
      details: true,
      createdAt: true,
    },
  });

  // Durable lifecycle events (issue #740) drive the same plain-language
  // narrative shown on the public payment-link page, so guests and admins read
  // identical wording for every booking state.
  const bookingEvents = await prisma.bookingEvent.findMany({
    where: { bookingId: booking.id },
    orderBy: { occurredAt: "asc" },
    select: {
      type: true,
      occurredAt: true,
      amountCents: true,
      reason: true,
      snapshot: true,
    },
  });
  const bookingNarrative = resolveBookingNarrative({
    booking: {
      status: booking.status,
      finalPriceCents: booking.finalPriceCents,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      firstName: booking.member.firstName,
      adminReviewStatus: booking.adminReviewStatus,
      adminReviewNotes: booking.adminReviewNotes,
      adminReviewReason: booking.adminReviewReason,
    },
    events: bookingEvents.map(
      (event): NarrativeEvent => ({
        type: event.type,
        occurredAt: event.occurredAt,
        amountCents: event.amountCents,
        reason: event.reason,
        snapshot: event.snapshot,
      })
    ),
  });

  const nights = Math.ceil(
    (new Date(booking.checkOut).getTime() - new Date(booking.checkIn).getTime()) /
      (1000 * 60 * 60 * 24)
  );

  const isDraft = booking.status === "DRAFT";
  const isWaitlisted = booking.status === "WAITLISTED";
  const isWaitlistOffered = booking.status === "WAITLIST_OFFERED";
  const isDeleted = Boolean(booking.deletedAt);
  // Issue #1313 (option A2): a Booking Officer (bookings:edit) may cancel any
  // booking; the /api/bookings/[id]/cancel route authorizes bookings:edit and the
  // notes editor below is gated on this same predicate.
  const canCancel = (canManageBooking || canAdminEditBookings) && !isDeleted && ["PAYMENT_PENDING", "CONFIRMED", "PAID", "PENDING", "WAITLISTED", "WAITLIST_OFFERED"].includes(booking.status);
  const showArrivalTime = !isDeleted && !["CANCELLED", "COMPLETED"].includes(booking.status);
  const modules = await loadEffectiveModuleFlags();
  const bookingMessages = await loadPublicBookingMessages();
  const showRequestedRoom =
    !isDeleted && (modules.bedAllocation || Boolean(booking.requestedRoomId));
  // Issue #776: the booking owner may request a room until an admin confirms
  // (locks) the bed allocation; admins can always edit while the booking is
  // modifiable. Only check the lock when the editor will actually render and
  // the module is on (the admin route also gates on bedAllocation).
  const bedAllocationLocked =
    showRequestedRoom && modules.bedAllocation
      ? await isBookingBedAllocationLocked({ bookingId: booking.id })
      : false;
  const requestedRoomEditableStatus =
    booking.status !== "CANCELLED" && booking.status !== "COMPLETED";
  const editPolicy = getBookingEditPolicy({
    status: booking.status,
    role: viewerAuthorizationRole,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
  });
  // Issue #1313 (option A2): a Booking Officer (bookings:edit) resolves to ADMIN
  // in viewerAuthorizationRole above, so editPolicy is the admin-on-behalf policy
  // and this predicate admits them exactly as the widened modify route does.
  const canModify = (canManageBooking || canAdminEditBookings) && !isDeleted && editPolicy.canModify;
  const canEditRequestedRoom = isDeleted
    ? false
    : isAdmin
      ? canModify
      : canAdminEditBookings
        ? // Issue #1313: Booking Officers set the requested room through the
          // admin route (/api/admin/bookings/[id]/requested-room, bookings:edit),
          // which mirrors these exact conditions and ignores the member-facing
          // allocation lock.
          modules.bedAllocation && requestedRoomEditableStatus
        : // Members (owners) may request a room before and after payment, until
          // the lodge confirms beds. Not tied to the paid/edit policy.
          isBookingOwner &&
          modules.bedAllocation &&
          requestedRoomEditableStatus &&
          !bedAllocationLocked;
  const canEditNonMemberGuestNames =
    canModify && !isBookingFullyPaidForGuestNameEdits(booking);
  // Once fully paid, the paid-name lock permits ONLY an identity-preserving
  // spelling correction on a free-text non-member guest (#1386). The similarity
  // guard is enforced server-side; this flag only opens the field with a hint.
  const canFixNonMemberGuestNameTypos =
    canModify && isBookingFullyPaidForGuestNameEdits(booking);
  const cancellationSettlement = booking.payment
    ? getCancellationSettlementBreakdown(
        booking.payment.refundedAmountCents,
        booking.creditsFromCancellation
      )
    : null;
  const paymentDisplay = booking.payment
    ? getPaymentDisplayStatus({
        bookingStatus: booking.status,
        paymentStatus: booking.payment.status,
        refundedAmountCents: booking.payment.refundedAmountCents,
        credits: booking.creditsFromCancellation,
      })
    : null;
  const internetBankingPayment =
    booking.payment?.source === "INTERNET_BANKING" ? booking.payment : null;
  // Switch-at-pay: a card PAYMENT_PENDING booking can move to Internet Banking
  // when the module is on (an organiser-settled or already-IB booking cannot).
  const canSwitchToInternetBanking =
    modules.xeroIntegration &&
    modules.internetBankingPayments &&
    !isDeleted &&
    canManageBooking &&
    !internetBankingPayment &&
    booking.status === "PAYMENT_PENDING" &&
    !booking.organiserSettled &&
    booking.finalPriceCents > 0;
  const originalPaymentCaptured = hasCapturedPayment(booking.payment);
  const retainedAfterCancellationCents = booking.payment
    ? Math.max(
        booking.payment.amountCents - booking.payment.refundedAmountCents,
        0
      )
    : 0;
  const latestRefundAppeal = booking.refundRequests[0] ?? null;
  const maxRefundableCents = getRemainingRefundableCents(booking.payment);
  const bookingHistory = buildBookingHistoryItems({
    createdAt: booking.createdAt,
    payment: booking.payment
      ? {
          status: booking.payment.status,
          amountCents: booking.payment.amountCents,
          refundedAmountCents: booking.payment.refundedAmountCents,
          additionalAmountCents: booking.payment.additionalAmountCents,
          additionalPaymentStatus: booking.payment.additionalPaymentStatus,
          createdAt: booking.payment.createdAt,
          updatedAt: booking.payment.updatedAt,
        }
      : null,
    modifications: booking.modifications,
    refundRequests: booking.refundRequests,
    auditLogs: bookingAuditLogs,
  });

  const editorData: BookingEditorData = {
    id: booking.id,
    checkIn: new Date(booking.checkIn).toISOString().split("T")[0],
    checkOut: new Date(booking.checkOut).toISOString().split("T")[0],
    nights,
    status: booking.status,
    guests: booking.guests.map((g) => ({
      id: g.id,
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier,
      isMember: g.isMember,
      memberId: g.memberId,
      stayStart: g.stayStart.toISOString().slice(0, 10),
      stayEnd: g.stayEnd.toISOString().slice(0, 10),
      priceCents: g.priceCents,
      nights: g.nights.map((n) => n.stayDate.toISOString().slice(0, 10)),
    })),
    viewerRole: viewerAuthorizationRole,
    totalPriceCents: booking.totalPriceCents,
    discountCents: booking.discountCents,
    promoAdjustmentCents: booking.promoAdjustmentCents,
    finalPriceCents: booking.finalPriceCents,
    promo: booking.promoRedemption?.promoCode
      ? {
          code: booking.promoRedemption.promoCode.code,
          type: booking.promoRedemption.promoCode.type,
          description: booking.promoRedemption.promoCode.description,
          workPartyEventName:
            booking.promoRedemption.promoCode.workPartyEvent?.name ?? null,
        }
      : null,
    hasNonMembers: booking.hasNonMembers,
    nonMemberHoldUntil: booking.nonMemberHoldUntil?.toISOString() ?? null,
    canEditNonMemberGuestNames,
    canFixNonMemberGuestNameTypos,
    editPolicy: {
      mode: editPolicy.mode,
      today: editPolicy.today.toISOString().slice(0, 10),
      editableFrom: editPolicy.editableFrom?.toISOString().slice(0, 10) ?? null,
      checkInEditable: editPolicy.checkInEditable,
    },
  };
  const backHref = resolveInternalReturnPath(
    query.returnTo,
    isAdmin ? "/admin/bookings" : "/bookings"
  );
  const canDeleteDraft =
    !isDeleted &&
    isDraft &&
    (isAdmin || booking.memberId === session.user.id);
  const canSoftDeleteCancelled =
    !isDeleted &&
    booking.status === "CANCELLED" &&
    isAdmin;
  const showMemberArrivalInstructions =
    !isDeleted &&
    (booking.memberId === session.user.id || isLinkedGuestViewer) &&
    ["CONFIRMED", "PAID"].includes(booking.status);
  const memberArrivalInstructions = showMemberArrivalInstructions
    ? await loadEmailMessageSettings()
    : null;

  // Split-booking group presentation (#738).
  const linkedProvisionalChildren = booking.linkedBookings.filter(
    (linked) => linked.status === "PENDING"
  );
  const provisionalChildGuestCount = linkedProvisionalChildren.reduce(
    (total, linked) => total + linked.guests.length,
    0
  );
  const hasProvisionalChildren = provisionalChildGuestCount > 0;
  const isProvisionalChild = Boolean(booking.parentBooking);
  const isFlaggedProvisional =
    !booking.parentBookingId &&
    booking.status === "PENDING" &&
    booking.cancelIfGuestsBumped &&
    booking.hasNonMembers;

  // Issue #777: a provisional/on-hold PENDING booking shows no pay control,
  // which left testers unsure whether one should exist. The "Save Payment
  // Method" card below already explains the save-card flow, so the on-hold
  // explanation is only needed when that card is not showing.
  // Member self-service "Save Payment Method" card (#1303): gated positively on
  // the booking owner so a non-owner admin never sees it. An admin entering
  // their own card on a member's booking is a footgun with no legitimate use,
  // and the owner-positive gate is robust to read-only admin viewers (#1289).
  const showSavePaymentMethodCard =
    isBookingOwner &&
    !isDeleted &&
    !internetBankingPayment &&
    booking.status === "PENDING" &&
    (!booking.payment || !booking.payment.stripeSetupIntentId);
  // Suppress when a more specific provisional banner already explains the
  // on-hold/no-charge state (the split-booking child and the bumped-guest
  // flagged-provisional notices both render near the top of the page). Also
  // suppress for any non-owner admin-type viewer: the notice is owner-second-
  // person ("your place/your guests/your stay"), so a Full Admin, Booking
  // Officer, or read-only admin viewing someone else's booking never sees it
  // (#1303/#1289). nonOwnerAdminViewer subsumes the earlier actingAsAdmin case.
  const showPaymentOnHoldNotice =
    !isDeleted &&
    !nonOwnerAdminViewer &&
    booking.status === "PENDING" &&
    !showSavePaymentMethodCard &&
    !isProvisionalChild &&
    !isFlaggedProvisional;

  // The Stripe payment card and the payment-required banner render under the
  // same condition so the banner can never point at a missing card. Member
  // self-service "Complete Payment" (#1303): gated positively on the booking
  // owner so a non-owner admin never sees the member pay/banner controls.
  const showCompletePaymentCard =
    isBookingOwner &&
    !isDeleted &&
    !internetBankingPayment &&
    isPaymentOwedBookingStatus(booking.status) &&
    (!booking.payment || booking.payment.status !== "SUCCEEDED");

  // Issue #778: surface auto-applied member credit (display only). Credit nets
  // off the booking price, so amount due = finalPriceCents - creditAppliedCents.
  const creditAppliedCents = booking.payment?.creditAppliedCents ?? 0;
  const showCreditApplied =
    canManageBooking &&
    creditAppliedCents > 0 &&
    isPaymentOwedBookingStatus(booking.status) &&
    booking.payment?.status !== "SUCCEEDED";
  const amountDueAfterCreditCents = Math.max(
    booking.finalPriceCents - creditAppliedCents,
    0
  );
  const bookingMessageData = {
    bookerFirstName: booking.member.firstName,
    bookerFullName: `${booking.member.firstName} ${booking.member.lastName}`,
    checkIn: booking.checkIn.toLocaleDateString("en-NZ", { dateStyle: "long" }),
    checkOut: booking.checkOut.toLocaleDateString("en-NZ", { dateStyle: "long" }),
    guestCount: booking.guests.length,
    amountDue: formatCents(amountDueAfterCreditCents),
    amountPaid: booking.payment ? formatCents(booking.payment.amountCents) : "",
    refundAmount: cancellationSettlement
      ? formatCents(cancellationSettlement.refundToOriginalMethodCents)
      : "",
    creditAmount: cancellationSettlement
      ? formatCents(cancellationSettlement.accountCreditCents)
      : "",
    creditRestored: cancellationSettlement
      ? formatCents(cancellationSettlement.restoredAppliedCreditCents)
      : "",
    retainedAmount: cancellationSettlement
      ? formatCents(retainedAfterCancellationCents)
      : "",
    changeFee: booking.payment ? formatCents(booking.payment.changeFeeCents) : "",
    paymentReference: internetBankingPayment?.reference ?? "",
    xeroInvoiceNumber: internetBankingPayment?.xeroInvoiceNumber ?? "",
    holdUntil: internetBankingPayment?.internetBankingHoldUntil
      ? internetBankingPayment.internetBankingHoldUntil.toLocaleString("en-NZ", {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "",
    holdDays: "",
    minimumDaysBeforeCheckIn: "",
    bookingStatus: booking.status,
  };
  const renderBookingMessage = (key: keyof typeof bookingMessages) =>
    renderBookingMessageTemplate(bookingMessages[key], bookingMessageData);
  const paymentRequiredDescription = renderBookingMessage(
    "booking.detail.paymentRequired.description",
  );
  const internetBankingPendingDescription = renderBookingMessage(
    "booking.detail.internetBanking.pending",
  );
  const switchToInternetBankingDescription = renderBookingMessage(
    "booking.detail.switchToInternetBanking",
  );
  const refundAppealDescription = renderBookingMessage(
    "cancellation.refundAppeal.description",
  );

  // Group booking organiser card (#796+). Only the owner manages their group;
  // the API enforces ownership too. Non-member joins appear once they verify
  // (i.e. once a child booking exists), so the roster is built from joins that
  // have a booking.
  const organiserGroup = booking.groupBookingAsOrganiser;
  const organiserGroupState: OrganiserGroupState | null = organiserGroup
    ? {
        code: organiserGroup.joinCode,
        status: organiserGroup.status,
        paymentMode: organiserGroup.paymentMode,
        joinDeadline: organiserGroup.joinDeadline?.toISOString() ?? null,
        maxJoiners: organiserGroup.maxJoiners,
        settlement: organiserGroup.settlement
          ? {
              status: organiserGroup.settlement.status,
              amountCents: organiserGroup.settlement.amountCents,
              paidAt: organiserGroup.settlement.paidAt?.toISOString() ?? null,
            }
          : null,
        joiners: organiserGroup.joins
          .filter((join) => join.booking)
          .map((join) => ({
            id: join.id,
            name: join.joinerMember
              ? `${join.joinerMember.firstName} ${join.joinerMember.lastName}`.trim()
              : [join.contactFirstName, join.contactLastName]
                  .filter(Boolean)
                  .join(" ") || "Guest",
            guestCount: join.booking?.guests.length ?? 0,
            status: join.booking?.status ?? null,
            priceCents: join.booking?.finalPriceCents ?? null,
            isMember: join.isMember,
          })),
      }
    : null;
  const canOpenGroup =
    isBookingOwner &&
    !isDeleted &&
    !booking.parentBookingId &&
    !organiserGroup &&
    OPENABLE_ORGANISER_STATUSES.includes(booking.status);
  const showGroupSection =
    modules.groupBookings &&
    canManageBooking &&
    isBookingOwner &&
    (Boolean(organiserGroupState) || canOpenGroup);

  const providerMismatches = isAdmin
    ? await getBookingProviderMismatches(booking.id)
    : [];

  // Surface the applicable cancellation refund schedule to the member up front
  // (#1371 F28): the exact per-booking amount already shows inside the cancel
  // flow, but the full tier schedule previously lived only in the admin policy
  // preview, so members first learned the refund consequences at cancel time.
  //
  // Only show the refund schedule when a payment has actually been captured —
  // otherwise the tier percentages imply a refund the member will never get.
  // For an unpaid-but-cancellable booking, say so plainly instead (owner review
  // of PR #1389).
  const showCancellationInfo = canCancel && !isDeleted;
  const cancellationSchedule =
    showCancellationInfo && originalPaymentCaptured
      ? describeCancellationSchedule(await loadCancellationPolicy(booking.checkIn))
      : undefined;
  const cancellationHasNoPayment = showCancellationInfo && !originalPaymentCaptured;

  return (
    <div className="max-w-2xl space-y-6">
      <ScrollToHash />
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Booking Details</h1>
        <div className="flex items-center gap-2">
          <BookingHelpDialog
            cancellationSchedule={cancellationSchedule}
            cancellationHasNoPayment={cancellationHasNoPayment}
          />
          <Link href={backHref}>
            <Button variant="outline">Back to Bookings</Button>
          </Link>
        </div>
      </div>

      {canSeeAdminTools && (
        <AdminBookingToolsCard
          bookingId={booking.id}
          memberId={booking.memberId}
          memberName={`${booking.member.firstName} ${booking.member.lastName}`}
          checkIn={booking.checkIn}
          checkOut={booking.checkOut}
          copyProps={{
            sourceCheckIn: editorData.checkIn,
            sourceCheckOut: editorData.checkOut,
            minCheckIn: editorData.editPolicy.today,
          }}
          isDeleted={isDeleted}
          paymentId={booking.payment?.id ?? null}
          showConfirmPendingGuests={Boolean(
            !isDeleted &&
              booking.status === "PENDING" &&
              booking.hasNonMembers &&
              booking.nonMemberHoldUntil,
          )}
          hasSavedPaymentMethod={Boolean(
            booking.payment?.stripePaymentMethodId &&
              booking.payment?.stripeCustomerId,
          )}
          finalPriceCents={booking.finalPriceCents}
          providerMismatches={providerMismatches}
          features={modules}
        />
      )}

      {showCompletePaymentCard && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-medium">Payment required</p>
          <p>{paymentRequiredDescription}</p>
          <p className="mt-1">
            <a href="#payment" className="font-medium underline">
              Go to payment
            </a>
          </p>
        </div>
      )}

      {isDeleted ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          <p className="font-medium">Deleted cancelled booking</p>
          <p>
            Deleted {booking.deletedAt?.toLocaleString("en-NZ")}
            {booking.deletedBy
              ? ` by ${booking.deletedBy.firstName} ${booking.deletedBy.lastName}`
              : ""}
            .
          </p>
          {booking.deletedReason ? (
            <p className="mt-1">Reason: {booking.deletedReason}</p>
          ) : null}
        </div>
      ) : null}

      {NARRATIVE_BANNER_STATES.has(bookingNarrative.state) ? (
        <div
          className={`space-y-1 rounded-md border px-4 py-3 text-sm ${
            narrativeBannerClasses[bookingNarrative.state] ??
            "border-slate-200 bg-slate-50 text-slate-900"
          }`}
        >
          <p className="font-medium">{bookingNarrative.headline}</p>
          <p>{bookingNarrative.message}</p>
          <p className="opacity-80">{bookingNarrative.nextStep}</p>
        </div>
      ) : null}

      {hasProvisionalChildren ? (
        <div className="space-y-1 rounded-md border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <p className="font-medium">
            {provisionalChildGuestCount} non-member guest
            {provisionalChildGuestCount === 1 ? "" : "s"} held provisionally
          </p>
          {nonOwnerAdminViewer ? (
            <p>
              The member&apos;s own place is confirmed once they pay for this
              booking. Their non-member guests are held in a linked provisional
              booking — <strong>no beds are reserved for them</strong> until
              they are confirmed and paid for closer to the stay.
            </p>
          ) : (
            <p>
              Your own place is confirmed once you pay for this booking. Your
              non-member guests are held in a linked provisional booking —{" "}
              <strong>no beds are reserved for them</strong> until they are
              confirmed and paid for closer to your stay. We&apos;ll be in touch
              before then.
            </p>
          )}
        </div>
      ) : null}

      {isProvisionalChild ? (
        <div className="space-y-1 rounded-md border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <p className="font-medium">Provisional non-member guests</p>
          <p>
            This is the non-member portion of{" "}
            {nonOwnerAdminViewer ? "the" : "your"} party, linked to{" "}
            {nonOwnerAdminViewer ? "the" : "your"}{" "}
            <Link
              href={`/bookings/${booking.parentBooking!.id}`}
              className="font-medium underline"
            >
              member booking
            </Link>
            . <strong>No beds are held</strong> for these guests until they are
            confirmed and paid for — nothing has been charged yet.
          </p>
        </div>
      ) : null}

      {isFlaggedProvisional ? (
        <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-medium">Provisional booking — no beds held yet</p>
          {nonOwnerAdminViewer ? (
            <p>
              The member asked us to only confirm this booking if their guests
              can come, so{" "}
              <strong>no beds are held and nothing has been charged</strong>.
              The whole party — the member and their guests — is confirmed once
              the guests are confirmed and paid for closer to the stay.
            </p>
          ) : (
            <p>
              You asked us to only confirm this booking if your guests can come,
              so <strong>no beds are held and nothing has been charged</strong>.
              We&apos;ll confirm the whole party — you and your guests — once
              your guests are confirmed and paid for closer to your stay.
            </p>
          )}
        </div>
      ) : null}

      <BookingEditor booking={editorData} canModify={canModify} />

      {showGroupSection && (
        <OrganiserGroupBookingCard
          bookingId={booking.id}
          canOpenGroup={canOpenGroup}
          group={organiserGroupState}
        />
      )}

      {booking.createdBy && (
        <div className="rounded-md bg-slate-50 border border-slate-200 px-4 py-3 text-sm text-slate-600">
          Created by <strong>{booking.createdBy.firstName} {booking.createdBy.lastName}</strong> (admin) on behalf of this member
        </div>
      )}

      {booking.requiresAdminReview && (
        <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p>
            <strong>
              {booking.adminReviewStatus === "PENDING"
                ? "Awaiting admin review."
                : booking.adminReviewStatus === "APPROVED"
                  ? "Approved by admin."
                  : booking.adminReviewStatus === "REJECTED"
                    ? "Declined by admin."
                    : "Admin review required."}
            </strong>{" "}
            {booking.adminReviewReason ?? "This booking needs manual review by an admin."}
          </p>
          {booking.adminReviewStatus === "PENDING" && (
            <p>
              Payment cannot be taken until an admin approves. You can amend the
              booking to include an adult guest if you would like to clear this flag.
            </p>
          )}
          {booking.memberReviewJustification && (
            <p>
              <span className="font-medium">Your reason:</span>{" "}
              {booking.memberReviewJustification}
            </p>
          )}
          {booking.adminReviewNotes && booking.adminReviewStatus !== "PENDING" && (
            <p>
              <span className="font-medium">Admin note:</span> {booking.adminReviewNotes}
            </p>
          )}
        </div>
      )}

      {booking.changeRequests.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Change Requests</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {booking.changeRequests.map((request) => {
              const requested = request.requestedChanges as {
                requested?: { summary?: string | null };
              };
              return (
                <div key={request.id} className="rounded-md border p-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium">
                      {requested.requested?.summary ?? "Booking change request"}
                    </p>
                    <Badge variant={request.status === "REQUESTED" ? "outline" : "secondary"}>
                      {humanizeStatus(request.status)}
                    </Badge>
                  </div>
                  <p className="mt-1 text-slate-500">
                    Submitted{" "}
                    {request.createdAt.toLocaleDateString("en-NZ", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </p>
                  {request.reason ? (
                    <p className="mt-2 text-slate-700">{request.reason}</p>
                  ) : null}
                  {request.adminNotes ? (
                    <p className="mt-2 text-slate-600">{request.adminNotes}</p>
                  ) : null}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {showArrivalTime && (
        <Card>
          <CardHeader>
            <CardTitle>Expected Arrival Time</CardTitle>
          </CardHeader>
          <CardContent>
            <ArrivalTimeEditor
              bookingId={booking.id}
              initialTime={booking.expectedArrivalTime}
              canEdit={(canManageBooking || canAdminEditBookings) && editPolicy.mode === "future"}
            />
          </CardContent>
        </Card>
      )}

      {showRequestedRoom && (
        <Card>
          <CardHeader>
            <CardTitle>Room Request</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {canEditRequestedRoom && !canSeeAdminTools ? (
              <p className="text-sm text-slate-600">
                Let us know if you&apos;d prefer a particular room. This is a
                request, not a guaranteed allocation. The lodge confirms beds
                closer to your stay.
              </p>
            ) : null}
            <RequestedRoomEditor
              bookingId={booking.id}
              initialRoom={booking.requestedRoom}
              canEdit={canEditRequestedRoom}
              endpoint={
                canSeeAdminTools
                  ? undefined
                  : `/api/bookings/${booking.id}/requested-room`
              }
              lockedNote={
                bedAllocationLocked && !canSeeAdminTools
                  ? "Your beds have been allocated by the lodge and can no longer be changed here."
                  : undefined
              }
            />
          </CardContent>
        </Card>
      )}

      {memberArrivalInstructions ? (
        <Card>
          <CardHeader>
            <CardTitle>How to Get to the Lodge</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-slate-700">
            <p className="whitespace-pre-wrap">
              {memberArrivalInstructions.lodgeTravelNote}
            </p>
            {memberArrivalInstructions.doorCode ? (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Door code
                </p>
                <p className="mt-1 text-lg font-semibold tracking-wide text-slate-950">
                  {memberArrivalInstructions.doorCode}
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* Draft booking: $0 confirm or payment to complete */}
      {canManageBooking && !isDeleted && isDraft && booking.finalPriceCents === 0 && (
        <ConfirmDraftButton bookingId={booking.id} />
      )}

      {/* Draft booking with non-zero price: show payment section to complete.
          Member-personal payment (Stripe card entry) — owner-only so a non-owner
          admin/officer never sees the member's save-card/confirm controls
          (#1303). The $0 ConfirmDraftButton above has no card entry and stays on
          canManageBooking. */}
      {isBookingOwner && !isDeleted && isDraft && booking.finalPriceCents > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Complete Booking</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-600 mb-4">
              This is a saved draft. Review the details above, then confirm when
              you&apos;re ready to pay and finalise the booking.
            </p>
            <BookingPaymentSection
              bookingId={booking.id}
              amountCents={booking.finalPriceCents}
              paymentMode={getBookingPaymentMode(booking.status)}
              returnUrl={`${process.env.NEXTAUTH_URL || "http://localhost:3000"}/bookings/${booking.id}`}
              showOnMount={false}
              gateDescription="Draft bookings stay editable until you explicitly continue to payment. Payment is still collected immediately once you choose to complete the booking."
              gateCtaLabel="Confirm & Continue to Payment"
            />
          </CardContent>
        </Card>
      )}

      {/* Waitlisted booking: show position */}
      {isWaitlisted && (
        <Card className="border-purple-200 bg-purple-50">
          <CardHeader>
            <CardTitle className="text-purple-900">On the Waitlist</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {booking.waitlistPosition && (
              <p className="text-sm font-medium text-purple-800">
                Position: #{booking.waitlistPosition}
              </p>
            )}
            <p className="text-sm text-purple-700">
              {nonOwnerAdminViewer ? (
                <>
                  We&apos;ll email the member when a spot opens up. They&apos;ll
                  have {WAITLIST_OFFER_HOURS} hours to confirm the booking.
                </>
              ) : (
                <>
                  We&apos;ll email you when a spot opens up. You&apos;ll have{" "}
                  {WAITLIST_OFFER_HOURS} hours to confirm your booking.
                </>
              )}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Waitlist offered: show confirm button with countdown */}
      {canManageBooking && isWaitlistOffered && booking.waitlistOfferExpiresAt && (
        <WaitlistOfferCard
          bookingId={booking.id}
          expiresAt={booking.waitlistOfferExpiresAt.toISOString()}
          finalPriceCents={booking.finalPriceCents}
        />
      )}

      {!isDeleted &&
        canManageBooking &&
        internetBankingPayment &&
        isPaymentOwedBookingStatus(booking.status) &&
        internetBankingPayment.status !== "SUCCEEDED" && (
          <Card className="border-amber-200 bg-amber-50">
            <CardHeader>
              <CardTitle className="text-amber-950">Internet Banking Payment</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-amber-950">
              <p>
                {internetBankingPendingDescription}
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <span className="text-amber-800">Amount due:</span>{" "}
                  <span className="font-medium">
                    {formatCents(internetBankingPayment.amountCents)}
                  </span>
                </div>
                {internetBankingPayment.reference ? (
                  <div>
                    <span className="text-amber-800">Reference:</span>{" "}
                    <span className="font-medium">{internetBankingPayment.reference}</span>
                  </div>
                ) : null}
                {internetBankingPayment.xeroInvoiceNumber ? (
                  <div>
                    <span className="text-amber-800">Xero invoice:</span>{" "}
                    <span className="font-medium">
                      {internetBankingPayment.xeroInvoiceNumber}
                    </span>
                  </div>
                ) : internetBankingPayment.xeroInvoiceId ? (
                  <div>
                    <span className="text-amber-800">Xero invoice:</span>{" "}
                    <span className="font-medium">
                      {internetBankingPayment.xeroInvoiceId.slice(0, 8)}
                    </span>
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>
        )}

      {/* Provisional/on-hold booking: explain why no payment is collected yet
          (issue #777). */}
      {showPaymentOnHoldNotice && (
        <Card className="border-sky-200 bg-sky-50">
          <CardHeader>
            <CardTitle className="text-sky-900">Payment on hold</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-sky-900">
              This is a provisional booking. We&apos;ll confirm your place and
              collect payment once your guests are confirmed, closer to your
              stay.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Show payment form if payment hasn't been completed */}
      {showCompletePaymentCard && (
        <Card id="payment" className="scroll-mt-4">
          <CardHeader>
            <CardTitle>Complete Payment</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-600 mb-4">
              {paymentRequiredDescription}
            </p>
            {showCreditApplied && (
              <div className="mb-4 space-y-1 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                <div className="flex items-center justify-between">
                  <span>Booking total</span>
                  <span>{formatCents(booking.finalPriceCents)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Credit applied</span>
                  <span>-{formatCents(creditAppliedCents)}</span>
                </div>
                <div className="flex items-center justify-between font-medium">
                  <span>Amount due</span>
                  <span>{formatCents(amountDueAfterCreditCents)}</span>
                </div>
              </div>
            )}
            <BookingPaymentSection
              bookingId={booking.id}
              amountCents={
                showCreditApplied
                  ? amountDueAfterCreditCents
                  : booking.finalPriceCents
              }
              paymentMode={getBookingPaymentMode(booking.status)}
              returnUrl={`${process.env.NEXTAUTH_URL || "http://localhost:3000"}/bookings/${booking.id}`}
            />
            {canSwitchToInternetBanking && (
              <SwitchToInternetBankingButton
                bookingId={booking.id}
                description={switchToInternetBankingDescription}
              />
            )}
          </CardContent>
        </Card>
      )}

      {showSavePaymentMethodCard && (
        <Card>
          <CardHeader>
            <CardTitle>Save Payment Method</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-600 mb-4">
              Please save a payment method. Your card will be charged when your booking is confirmed
              closer to check-in.
            </p>
            <BookingPaymentSection
              bookingId={booking.id}
              amountCents={booking.finalPriceCents}
              paymentMode={getBookingPaymentMode(booking.status)}
              returnUrl={`${process.env.NEXTAUTH_URL || "http://localhost:3000"}/bookings/${booking.id}`}
            />
          </CardContent>
        </Card>
      )}

      {/* Additional payment required after a modification that increased the
          price. Member-personal payment (Stripe card entry) — owner-only so a
          non-owner admin/officer never sees the member's pay controls (#1303). */}
      {booking.payment &&
        isBookingOwner &&
        !isDeleted &&
        booking.payment.additionalAmountCents > 0 &&
        booking.payment.additionalPaymentStatus !== "SUCCEEDED" && (
          <AdditionalPaymentCard
            bookingId={booking.id}
            additionalAmountCents={booking.payment.additionalAmountCents}
          />
        )}

      {canCancel && (
        <CancelBookingButton
          bookingId={booking.id}
          refundAppealDescription={refundAppealDescription}
          onBehalfOfMember={actingOnBehalf}
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
        maxRefundableCents > 0 && (
          <RefundAppealButton
            bookingId={booking.id}
            maxRefundableCents={maxRefundableCents}
            description={refundAppealDescription}
          />
        )}

      {booking.status === "CANCELLED" && (
        <Card>
          <CardHeader>
            <CardTitle>Cancellation Outcome</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Badge
                className={
                  paymentDisplay
                    ? paymentStatusClass(paymentDisplay.toneStatus)
                    : "bg-slate-100 text-slate-700"
                }
              >
                {paymentDisplay?.label ?? "Cancelled Before Payment"}
              </Badge>
              <p className="text-sm text-slate-600">
                {paymentDisplay?.detail ??
                  "No original payment was captured for this booking, so nothing needed to be returned."}
              </p>
            </div>

            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <span className="text-slate-500">Original payment:</span>{" "}
                {originalPaymentCaptured && booking.payment
                  ? formatCents(booking.payment.amountCents)
                  : "No original payment captured"}
              </div>

              {originalPaymentCaptured && cancellationSettlement && (
                <>
                  <div>
                    <span className="text-slate-500">
                      Returned to original payment method:
                    </span>{" "}
                    {formatCents(
                      cancellationSettlement.refundToOriginalMethodCents
                    )}
                  </div>

                  <div>
                    <span className="text-slate-500">Held as account credit:</span>{" "}
                    {formatCents(cancellationSettlement.accountCreditCents)}
                  </div>

                  <div>
                    <span className="text-slate-500">
                      Non-refundable amount retained:
                    </span>{" "}
                    {formatCents(retainedAfterCancellationCents)}
                  </div>

                  {cancellationSettlement.restoredAppliedCreditCents > 0 && (
                    <div>
                      <span className="text-slate-500">
                        Previously applied credit restored (per the cancellation
                        policy):
                      </span>{" "}
                      {formatCents(
                        cancellationSettlement.restoredAppliedCreditCents
                      )}
                    </div>
                  )}

                  {booking.payment?.changeFeeCents
                    ? (
                    <div>
                      <span className="text-slate-500">
                        Included non-refundable change fees:
                      </span>{" "}
                      {formatCents(booking.payment.changeFeeCents)}
                    </div>
                      )
                    : null}
                </>
              )}

              {latestRefundAppeal && (
                <div>
                  <span className="text-slate-500">Latest refund appeal:</span>{" "}
                  <Badge
                    variant={
                      latestRefundAppeal.status === "PENDING"
                        ? "outline"
                        : latestRefundAppeal.status === "APPROVED"
                          ? "default"
                          : "destructive"
                    }
                    className="align-middle"
                  >
                    {humanizeStatus(latestRefundAppeal.status)}
                  </Badge>
                  {latestRefundAppeal.requestedAmountCents ? (
                    <span className="ml-2 text-slate-600">
                      Requested {formatCents(latestRefundAppeal.requestedAmountCents)}
                    </span>
                  ) : null}
                  {latestRefundAppeal.approvedAmountCents ? (
                    <span className="ml-2 text-slate-600">
                      Approved {formatCents(latestRefundAppeal.approvedAmountCents)}
                    </span>
                  ) : null}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Notes</CardTitle>
        </CardHeader>
        <CardContent>
          <BookingNotesEditor
            bookingId={booking.id}
            initialNotes={booking.notes ?? ""}
            canEdit={canCancel}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Transaction History</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="divide-y">
            {bookingHistory.map((item) => (
              <div
                key={item.id}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant="outline"
                      className={historyToneClasses[item.tone]}
                    >
                      {item.category}
                    </Badge>
                    <span className="text-sm font-medium text-slate-900">
                      {item.title}
                    </span>
                    <span className="text-xs text-slate-500">
                      {item.occurredAt.toLocaleDateString("en-NZ", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  {item.detail ? (
                    <p className="text-sm text-slate-600">{item.detail}</p>
                  ) : null}
                </div>
                {item.amountDisplay ? (
                  <span
                    className={`text-sm font-medium ${
                      item.tone === "danger"
                        ? "text-rose-700"
                        : item.tone === "success"
                          ? "text-emerald-700"
                          : item.tone === "warning"
                            ? "text-amber-700"
                            : "text-slate-700"
                    }`}
                  >
                    {item.amountDisplay}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Waiting on a booking email? This page always shows the live status of
        your booking — the confirmation, payment, and cancellation details
        above are up to date even if an email hasn&apos;t arrived. Check your
        spam folder, and contact the club if our emails keep going missing.
      </p>
    </div>
  );
}
