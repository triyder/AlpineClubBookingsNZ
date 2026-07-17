import {
  BookingEventType,
  BookingStatus,
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
  Prisma,
} from "@prisma/client";

import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { recordBookingEvent } from "@/lib/booking-events";
import { bookingHasCapacityOverride } from "@/lib/booking-status";
import logger from "@/lib/logger";
import {
  mintSplitGuestPaymentLinkIfAbsent,
  revokePaymentLinkById,
  revokePaymentLinksForBooking,
  type MintedSplitGuestPaymentLink,
} from "@/lib/payment-link";
import { endOfDateOnlyForTimeZone, formatDateOnly } from "@/lib/date-only";
import { markBookingPaymentSucceeded } from "@/lib/payment-reconciliation";
import { upsertPaymentIntentTransaction } from "@/lib/payment-transactions";
import { deletePromoRedemptionAndAdjustCount } from "@/lib/promo";
import { prisma } from "./prisma";
import { acquireLodgeCapacityLock, checkCapacityForGuestRanges } from "./capacity";
import { getDefaultLodgeId } from "@/lib/lodges";
import { chargePaymentMethod } from "./stripe";
import {
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "./xero-operation-outbox";
import {
  sendAdminBookingRequestHoldExpiredEmail,
  sendAdminPaymentFailureAlert,
  sendAdminSplitSettlementUnpaidAlert,
  sendBookingBumpedEmail,
  sendBookingConfirmedEmail,
  sendBookingGuestsCancelledEmail,
  sendSplitGuestPaymentLinkEmail,
} from "./email";
import { processWaitlistForDates } from "./waitlist";

/** How long to extend the hold for request-origin bookings (no saved card) at hold expiry. */
const REQUEST_HOLD_EXTENSION_MS = 2 * 24 * 60 * 60 * 1000;

const pendingBookingInclude = {
  member: true,
  // Per-night sets (issue #713) for accurate capacity re-check at the hold window.
  guests: { include: { nights: true } },
  payment: true,
  parentBooking: {
    include: {
      payment: true,
    },
  },
  // #1967: a #796 group joiner also carries parentBookingId (the organiser's
  // booking) but always has a GroupBookingJoin row written atomically with its
  // creation — this is the discriminator that keeps joiners out of the
  // split-guest settlement branch.
  groupBookingJoin: { select: { id: true } },
  originBookingRequest: { select: { id: true } },
  promoRedemption: {
    include: {
      guestTargets: { select: { bookingGuestId: true } },
      promoCode: {
        include: { assignments: { select: { memberId: true } } },
      },
    },
  },
} satisfies Prisma.BookingInclude;

type PendingBooking = Prisma.BookingGetPayload<{
  include: typeof pendingBookingInclude;
}>;

type SavedPaymentMethod = {
  stripeCustomerId: string;
  stripePaymentMethodId: string;
};

type HoldResolution =
  | { type: "already_processed" }
  | { type: "bumped"; booking: PendingBooking; flagged: boolean }
  | { type: "confirmed_zero"; booking: PendingBooking }
  | {
      type: "extended_request_hold";
      booking: PendingBooking;
      extendedHoldUntil: Date;
    }
  | { type: "missing_payment_method"; booking: PendingBooking }
  | {
      type: "split_child_payment_link";
      booking: PendingBooking;
      extendedHoldUntil: Date;
      // The freshly minted link (raw token + row id) when THIS run minted one
      // (the caller emails the member, and revokes the link by id if that
      // email fails so the next run re-mints). Null when an active link
      // already existed — the member was emailed on a prior run, so the
      // caller sends no member email; the admin alert fires either way.
      mintedLink: MintedSplitGuestPaymentLink | null;
    }
  | {
      // A genuine split child with no saved card whose PARENT is not settled
      // (e.g. an abandoned card PAYMENT_PENDING parent): the member's own
      // place is unpaid, so no guest payment link is minted or emailed — the
      // guest portion must not become settleable ahead of the member's own
      // place. The hold extension is the alert-cadence claim.
      type: "split_child_parent_unpaid";
      booking: PendingBooking;
      extendedHoldUntil: Date;
    }
  | {
      type: "claimed_for_charge";
      booking: PendingBooking;
      payment: SavedPaymentMethod;
      paymentId: string;
      previousHoldUntil: Date | null;
    };

export interface CronConfirmResult {
  confirmedBookingIds: string[];
  bumpedBookingIds: string[];
  // Retained for response-shape stability. The cron no longer partial-bumps at
  // hold expiry (issue #737): members pay up front, so there is no reduced
  // members-only amount to settle here. Always empty.
  partialBumpedBookingIds: string[];
  failedBookingIds: string[];
}

function savedPaymentMethodForBooking(
  booking: PendingBooking
): SavedPaymentMethod | null {
  if (booking.payment?.stripeCustomerId && booking.payment.stripePaymentMethodId) {
    return {
      stripeCustomerId: booking.payment.stripeCustomerId,
      stripePaymentMethodId: booking.payment.stripePaymentMethodId,
    };
  }

  const parentPayment = booking.parentBooking?.payment;
  if (parentPayment?.stripeCustomerId && parentPayment.stripePaymentMethodId) {
    return {
      stripeCustomerId: parentPayment.stripeCustomerId,
      stripePaymentMethodId: parentPayment.stripePaymentMethodId,
    };
  }

  return null;
}

function promoEmailOptions(booking: PendingBooking) {
  return {
    lodgeId: booking.lodgeId,
    ...(booking.promoRedemption?.promoCode
      ? {
          discountCents: booking.discountCents,
          promoAdjustmentCents: booking.promoAdjustmentCents,
          promoCode: booking.promoRedemption.promoCode.code,
        }
      : {}),
  };
}

async function queueXeroInvoice(bookingId: string, logMessage: string) {
  try {
    const queuedInvoice = await enqueueXeroBookingInvoiceOperation(bookingId);
    if (queuedInvoice.queueOperationId) {
      await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
      logger.info(
        { bookingId, job: "confirmPendingBookings" },
        logMessage
      );
    }
  } catch (xeroErr) {
    logger.error(
      { err: xeroErr, bookingId, job: "confirmPendingBookings" },
      "Failed to queue Xero invoice"
    );
  }
}

async function sendConfirmationEmail(booking: PendingBooking) {
  try {
    await sendBookingConfirmedEmail(
      booking.member.email,
      booking.member.firstName,
      booking.checkIn,
      booking.checkOut,
      booking.guests.length,
      booking.finalPriceCents,
      promoEmailOptions(booking)
    );
  } catch (emailErr) {
    logger.error(
      { err: emailErr, bookingId: booking.id, job: "confirmPendingBookings" },
      "Failed to send confirmation email"
    );
  }
}

async function sendBumpedEmail(booking: PendingBooking, flagged: boolean) {
  try {
    if (flagged) {
      await sendBookingGuestsCancelledEmail(
        booking.member.email,
        booking.member.firstName,
        booking.checkIn,
        booking.checkOut,
        booking.lodgeId
      );
    } else {
      await sendBookingBumpedEmail(
        booking.member.email,
        booking.member.firstName,
        booking.checkIn,
        booking.checkOut,
        booking.guests.length,
        booking.lodgeId
      );
    }
  } catch (emailErr) {
    logger.error(
      { err: emailErr, bookingId: booking.id, job: "confirmPendingBookings" },
      "Failed to send bumped email"
    );
  }
}

function triggerWaitlistProcessing(booking: PendingBooking) {
  processWaitlistForDates({
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    lodgeId: booking.lodgeId,
  }).catch((err) =>
    logger.error(
      { err, bookingId: booking.id },
      "Failed to process waitlist after cron bump"
    )
  );
}

async function resolveHoldWindowUnderLock(
  bookingId: string,
  now: Date
): Promise<HoldResolution> {
  return prisma.$transaction(async (tx) => {
    // Pre-lock read: only the fields the early bail and the lock key need.
    // lodgeId is immutable, so keying the lock from this read is safe; every
    // capacity-relevant field is taken from the post-lock re-read below.
    const preLock = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { lodgeId: true, status: true, nonMemberHoldUntil: true },
    });

    if (
      !preLock ||
      preLock.status !== BookingStatus.PENDING ||
      !preLock.nonMemberHoldUntil ||
      preLock.nonMemberHoldUntil > now
    ) {
      logger.info(
        { bookingId, job: "confirmPendingBookings" },
        "Booking already processed by another handler"
      );
      return { type: "already_processed" };
    }

    const bookingLodgeId = preLock.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, bookingLodgeId);

    // Re-read the full booking under the lock; the capacity check, claims and
    // reconcile below consume ONLY this post-lock snapshot. Re-validate the
    // hold window: a concurrent handler may have resolved it between the
    // pre-lock read and acquiring the lock.
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      include: pendingBookingInclude,
    });

    if (
      !booking ||
      booking.status !== BookingStatus.PENDING ||
      !booking.nonMemberHoldUntil ||
      booking.nonMemberHoldUntil > now
    ) {
      logger.info(
        { bookingId, job: "confirmPendingBookings" },
        "Booking already processed by another handler"
      );
      return { type: "already_processed" };
    }

    const capacityCheck = await checkCapacityForGuestRanges(
      bookingLodgeId,
      booking.checkIn,
      booking.checkOut,
      booking.guests,
      booking.id,
      tx
    );

    if (!capacityCheck.available && bookingHasCapacityOverride(booking)) {
      // Persisted capacity override (#1771): this hold-eligible PENDING booking
      // was deliberately admitted above the ceiling by an admin, so the
      // hold-window re-check must NOT bump it. Fall through to the normal
      // confirm flow below ($0 -> PAID, or the priced claim-for-charge path).
      // This read-site is what lets booking-create retire its PENDING carve-out.
      logger.info(
        { bookingId: booking.id, job: "confirmPendingBookings" },
        "Confirming an over-capacity booking with a persisted capacity override (#1771); skipping the capacity bump"
      );
    }
    if (!capacityCheck.available && !bookingHasCapacityOverride(booking)) {
      const claimed = await tx.booking.updateMany({
        where: { id: booking.id, status: BookingStatus.PENDING },
        data: {
          status: BookingStatus.CANCELLED,
          nonMemberHoldUntil: null,
        },
      });
      if (claimed.count === 0) {
        logger.info(
          { bookingId: booking.id, job: "confirmPendingBookings" },
          "Booking already processed by another handler"
        );
        return { type: "already_processed" };
      }

      await reconcileBedAllocationsForBooking({
        bookingId: booking.id,
        db: tx,
        previousRange: {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        },
      });

      const promoRedemption = await tx.promoRedemption.findUnique({
        where: { bookingId: booking.id },
      });
      if (promoRedemption) {
        await deletePromoRedemptionAndAdjustCount(tx, promoRedemption);
      }

      await revokePaymentLinksForBooking(booking.id, tx);

      return {
        type: "bumped",
        booking,
        flagged: booking.cancelIfGuestsBumped,
      };
    }

    // Zero-dollar booking: skip Stripe, just confirm with a SUCCEEDED Payment.
    if (booking.finalPriceCents === 0) {
      const claimed = await tx.booking.updateMany({
        where: { id: booking.id, status: BookingStatus.PENDING },
        data: {
          status: BookingStatus.PAID,
          nonMemberHoldUntil: null,
        },
      });
      if (claimed.count === 0) {
        logger.info(
          { bookingId: booking.id, job: "confirmPendingBookings" },
          "Booking already processed by another handler"
        );
        return { type: "already_processed" };
      }

      await reconcileBedAllocationsForBooking({
        bookingId: booking.id,
        db: tx,
        previousRange: {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        },
      });

      await tx.payment.upsert({
        where: { bookingId: booking.id },
        create: {
          bookingId: booking.id,
          amountCents: 0,
          status: PaymentStatus.SUCCEEDED,
        },
        update: {
          amountCents: 0,
          status: PaymentStatus.SUCCEEDED,
        },
      });

      return { type: "confirmed_zero", booking };
    }

    const savedPayment = savedPaymentMethodForBooking(booking);
    if (!savedPayment) {
      if (booking.originBookingRequest) {
        // Request-origin bookings (#707) pay via a tokenised PaymentLink, not
        // a saved card. Keep the link path alive when capacity is still
        // available; revoke it in the unavailable branch above.
        const extendedHoldUntil = new Date(
          now.getTime() + REQUEST_HOLD_EXTENSION_MS
        );
        const claimed = await tx.booking.updateMany({
          where: {
            id: booking.id,
            status: BookingStatus.PENDING,
            nonMemberHoldUntil: booking.nonMemberHoldUntil,
          },
          data: { nonMemberHoldUntil: extendedHoldUntil },
        });

        return claimed.count > 0
          ? {
              type: "extended_request_hold",
              booking,
              extendedHoldUntil,
            }
          : { type: "already_processed" };
      }

      // #1967: a split non-member child whose parent paid via Internet Banking
      // (switch-at-pay) has no saved card and is not request-origin, so it
      // cannot be auto-charged. Rather than stranding the guests unsettled (the
      // old missing_payment_method → log-only path), reuse the #707 tokenised
      // PaymentLink so the member can settle their guests' portion. Mirror the
      // request-origin path: extend the hold to stop 15-minute churn, mint the
      // link (idempotently), email the member once per mint, and alert admins
      // on every extension run while unsettled. The child stays PENDING and
      // holds no capacity, exactly as before.
      //
      // Genuine #738 split children only: a #796 group joiner also carries
      // parentBookingId (the organiser's booking) but always has a
      // GroupBookingJoin row written atomically at creation. Joiners keep the
      // pre-existing missing_payment_method behaviour below — their guest
      // wording, payment link (minted at join for EACH_PAYS_OWN) and
      // organiser-settlement flows are a different machine.
      if (booking.parentBookingId && !booking.groupBookingJoin) {
        // #1967 FIX-1: only treat the guest portion as settleable-by-link when
        // the parent (the member's own place) is genuinely settled without a
        // saved card — an Internet Banking payment on a live parent (the
        // switch-at-pay flips the parent to CONFIRMED with an IB-source
        // payment), or a parent already in a settled/settling status. An
        // abandoned-card PAYMENT_PENDING parent also reaches here with no
        // saved card, but then the member's own place is unpaid: emailing
        // "pay for your guests" would assert false facts and let the guest
        // portion settle ahead of the member's own place.
        const parent = booking.parentBooking;
        const parentIsLive =
          parent != null &&
          parent.deletedAt == null &&
          parent.status !== BookingStatus.CANCELLED &&
          parent.status !== BookingStatus.BUMPED;
        const parentSettledWithoutCard =
          parentIsLive &&
          (parent.payment?.source === PaymentSource.INTERNET_BANKING ||
            parent.status === BookingStatus.CONFIRMED ||
            parent.status === BookingStatus.PAID ||
            parent.status === BookingStatus.COMPLETED);

        const extendedHoldUntil = new Date(
          now.getTime() + REQUEST_HOLD_EXTENSION_MS
        );
        const claimed = await tx.booking.updateMany({
          where: {
            id: booking.id,
            status: BookingStatus.PENDING,
            nonMemberHoldUntil: booking.nonMemberHoldUntil,
          },
          data: { nonMemberHoldUntil: extendedHoldUntil },
        });
        if (claimed.count === 0) {
          return { type: "already_processed" };
        }

        if (!parentSettledWithoutCard) {
          return {
            type: "split_child_parent_unpaid",
            booking,
            extendedHoldUntil,
          };
        }

        // Mint only when no active (unexpired) link exists; a pre-existing
        // active link means a prior run already emailed the member.
        const mintedLink = await mintSplitGuestPaymentLinkIfAbsent(tx, {
          id: booking.id,
          checkIn: booking.checkIn,
        });

        return {
          type: "split_child_payment_link",
          booking,
          extendedHoldUntil,
          mintedLink,
        };
      }

      return { type: "missing_payment_method", booking };
    }

    const claimed = await tx.booking.updateMany({
      where: { id: booking.id, status: BookingStatus.PENDING },
      data: {
        // Claim capacity before the external Stripe call. CONFIRMED is a
        // capacity-holding, payment-owed status; it is released back to PENDING
        // if the saved-card charge cannot complete.
        status: BookingStatus.CONFIRMED,
        nonMemberHoldUntil: null,
      },
    });
    if (claimed.count === 0) {
      logger.info(
        { bookingId: booking.id, job: "confirmPendingBookings" },
        "Booking already processed by another handler"
      );
      return { type: "already_processed" };
    }

    // #1967 FIX-6: the auto-charge claim supersedes any outstanding /pay link
    // (e.g. one minted while no card was on file, before a card appeared on
    // the parent). Revoke inside the claim transaction — under the same lodge
    // lock the /pay intent path re-reads the link beneath — so the tokenised
    // link and the saved-card charge can never both be live settlement paths.
    // Mirrors the bump path's revocation above.
    await revokePaymentLinksForBooking(booking.id, tx);

    await reconcileBedAllocationsForBooking({
      bookingId: booking.id,
      db: tx,
      previousRange: {
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
      },
    });

    const payment = await tx.payment.upsert({
      where: { bookingId: booking.id },
      create: {
        bookingId: booking.id,
        amountCents: booking.finalPriceCents,
        status: PaymentStatus.PENDING,
        stripeCustomerId: savedPayment.stripeCustomerId,
        stripePaymentMethodId: savedPayment.stripePaymentMethodId,
      },
      update: {
        amountCents: booking.finalPriceCents,
        status: PaymentStatus.PENDING,
        stripeCustomerId: savedPayment.stripeCustomerId,
        stripePaymentMethodId: savedPayment.stripePaymentMethodId,
      },
    });

    return {
      type: "claimed_for_charge",
      booking,
      payment: savedPayment,
      paymentId: payment.id,
      previousHoldUntil: booking.nonMemberHoldUntil,
    };
  });
}

async function releaseChargeClaim(
  claim: Extract<HoldResolution, { type: "claimed_for_charge" }>
) {
  await prisma.$transaction(async (tx) => {
    const claimLodgeId = claim.booking.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, claimLodgeId);

    const released = await tx.booking.updateMany({
      where: { id: claim.booking.id, status: BookingStatus.CONFIRMED },
      data: {
        status: BookingStatus.PENDING,
        nonMemberHoldUntil: claim.previousHoldUntil,
      },
    });

    if (released.count > 0) {
      await reconcileBedAllocationsForBooking({
        bookingId: claim.booking.id,
        db: tx,
        previousRange: {
          checkIn: claim.booking.checkIn,
          checkOut: claim.booking.checkOut,
        },
      });
    }
  });
}

/**
 * Process provisional bookings that have reached their hold deadline.
 *
 * For each PENDING booking where nonMemberHoldUntil <= now():
 * 1. Re-check bed availability under the booking advisory lock.
 * 2. If beds are unavailable, cancel the provisional booking, revoke payment
 *    links, and send the appropriate no-charge bump/cancellation email.
 * 3. If beds are available and a saved payment method exists, claim capacity,
 *    charge off-session, then move to PAID and queue the booking's Xero invoice.
 * 4. If the booking is request-origin and has no saved card, keep the #707
 *    payment-link path alive by extending the follow-up hold and alerting admins.
 */
export async function confirmPendingBookings(): Promise<CronConfirmResult> {
  const now = new Date();

  // Find all PENDING bookings past their hold deadline, including split
  // non-member child bookings (#738). Process oldest first so older provisional
  // non-member windows resolve before newer competing holds.
  const pendingBookings = await prisma.booking.findMany({
    where: {
      status: BookingStatus.PENDING,
      nonMemberHoldUntil: { lte: now },
    },
    include: pendingBookingInclude,
    orderBy: { createdAt: "asc" },
  });

  const result: CronConfirmResult = {
    confirmedBookingIds: [],
    bumpedBookingIds: [],
    partialBumpedBookingIds: [],
    failedBookingIds: [],
  };

  for (const candidate of pendingBookings) {
    let chargeAttempted = false;
    let paymentSucceeded = false;
    let claimForCharge: Extract<
      HoldResolution,
      { type: "claimed_for_charge" }
    > | null = null;
    let paymentIntentId = candidate.payment?.stripePaymentIntentId || "N/A";

    try {
      const resolution = await resolveHoldWindowUnderLock(candidate.id, now);

      if (resolution.type === "already_processed") {
        continue;
      }

      if (resolution.type === "bumped") {
        result.bumpedBookingIds.push(resolution.booking.id);
        // Durable fact (issue #740): these dates filled up before the
        // provisional guests were confirmed; the booking was released, no
        // payment taken. This is what lets the narrative tell a bumped booking
        // apart from a member-initiated cancellation — both end up CANCELLED.
        await recordBookingEvent({
          bookingId: resolution.booking.id,
          type: BookingEventType.BUMPED,
          reason: resolution.flagged
            ? "Released because the whole party could not be confirmed (only-if-guests-come)."
            : "These dates filled up before the provisional guests were confirmed.",
          snapshot: { flagged: resolution.flagged },
        });
        await sendBumpedEmail(resolution.booking, resolution.flagged);
        triggerWaitlistProcessing(resolution.booking);
        continue;
      }

      if (resolution.type === "confirmed_zero") {
        result.confirmedBookingIds.push(resolution.booking.id);
        await recordBookingEvent({
          bookingId: resolution.booking.id,
          type: BookingEventType.NON_MEMBER_CONFIRMED,
          amountCents: 0,
        });
        await queueXeroInvoice(
          resolution.booking.id,
          "Xero invoice queued for $0 booking"
        );
        await sendConfirmationEmail(resolution.booking);
        continue;
      }

      if (resolution.type === "extended_request_hold") {
        try {
          await sendAdminBookingRequestHoldExpiredEmail({
            requesterName: `${resolution.booking.member.firstName} ${resolution.booking.member.lastName}`,
            checkIn: resolution.booking.checkIn,
            checkOut: resolution.booking.checkOut,
            guestCount: resolution.booking.guests.length,
            totalCents: resolution.booking.finalPriceCents,
            holdUntil: resolution.extendedHoldUntil,
          });
        } catch (emailErr) {
          logger.error(
            {
              err: emailErr,
              bookingId: resolution.booking.id,
              job: "confirmPendingBookings",
            },
            "Failed to send admin hold-expired alert"
          );
        }
        continue;
      }

      if (resolution.type === "split_child_payment_link") {
        // Member email: only the run that minted a fresh link sends one (a
        // null mintedLink means an active link exists and the member was
        // emailed on a prior run — idempotent across cron re-runs). If the
        // send throws or is suppressed, the raw token dies with this run, so
        // revoke the just-minted link (by id, so a concurrent on-demand
        // re-mint's newer link survives) — the next extension run then
        // re-mints and re-sends instead of stalling forever behind a stale
        // active-link sentinel.
        if (resolution.mintedLink) {
          const { token, paymentLinkId } = resolution.mintedLink;
          const expiresAt = endOfDateOnlyForTimeZone(
            formatDateOnly(resolution.booking.checkIn)
          );
          let delivered = false;
          try {
            const emailOutcome = await sendSplitGuestPaymentLinkEmail({
              email: resolution.booking.member.email,
              firstName: resolution.booking.member.firstName,
              token,
              checkIn: resolution.booking.checkIn,
              checkOut: resolution.booking.checkOut,
              guestCount: resolution.booking.guests.length,
              priceCents: resolution.booking.finalPriceCents,
              bookingReference: resolution.booking.id,
              expiresAt,
              lodgeId: resolution.booking.lodgeId ?? null,
            });
            delivered = emailOutcome.status === "sent";
            if (!delivered) {
              logger.warn(
                {
                  bookingId: resolution.booking.id,
                  emailStatus: emailOutcome.status,
                  job: "confirmPendingBookings",
                },
                "Split-booking guest payment link email not delivered (suppressed recipient); revoking the link so the next settlement run re-mints"
              );
            }
          } catch (emailErr) {
            logger.error(
              {
                err: emailErr,
                bookingId: resolution.booking.id,
                job: "confirmPendingBookings",
              },
              "Failed to send split-booking guest payment link email; revoking the link so the next settlement run re-mints"
            );
          }
          if (!delivered) {
            await revokePaymentLinkById(paymentLinkId).catch((revokeErr) =>
              logger.error(
                {
                  err: revokeErr,
                  bookingId: resolution.booking.id,
                  paymentLinkId,
                  job: "confirmPendingBookings",
                },
                "Failed to revoke undelivered split guest payment link; a stale active link may block re-minting until it expires"
              )
            );
          }
        }

        // Admin alert: every extension run while the guest portion remains
        // unsettled (matching the request-origin extended_request_hold
        // cadence two branches up), not just the minting run.
        try {
          await sendAdminSplitSettlementUnpaidAlert({
            memberName: `${resolution.booking.member.firstName} ${resolution.booking.member.lastName}`,
            checkIn: resolution.booking.checkIn,
            checkOut: resolution.booking.checkOut,
            guestCount: resolution.booking.guests.length,
            totalCents: resolution.booking.finalPriceCents,
            holdUntil: resolution.extendedHoldUntil,
            parentUnpaid: false,
          });
        } catch (alertErr) {
          logger.error(
            {
              err: alertErr,
              bookingId: resolution.booking.id,
              job: "confirmPendingBookings",
            },
            "Failed to send admin split-settlement unpaid alert"
          );
        }
        continue;
      }

      if (resolution.type === "split_child_parent_unpaid") {
        // The member's own (parent) booking is unpaid, so no guest payment
        // link was minted or emailed. Keep the legacy missing-payment-method
        // observability (error log + failed id) and alert admins once per
        // hold extension — the extension claim is the dedupe across the
        // 15-minute cron cadence.
        logger.error(
          { bookingId: resolution.booking.id, job: "confirmPendingBookings" },
          "Split child booking has no saved payment method and its parent booking is unsettled - cannot auto-confirm or issue a guest payment link"
        );
        result.failedBookingIds.push(resolution.booking.id);
        try {
          await sendAdminSplitSettlementUnpaidAlert({
            memberName: `${resolution.booking.member.firstName} ${resolution.booking.member.lastName}`,
            checkIn: resolution.booking.checkIn,
            checkOut: resolution.booking.checkOut,
            guestCount: resolution.booking.guests.length,
            totalCents: resolution.booking.finalPriceCents,
            holdUntil: resolution.extendedHoldUntil,
            parentUnpaid: true,
          });
        } catch (alertErr) {
          logger.error(
            {
              err: alertErr,
              bookingId: resolution.booking.id,
              job: "confirmPendingBookings",
            },
            "Failed to send admin split-settlement unpaid alert"
          );
        }
        continue;
      }

      if (resolution.type === "missing_payment_method") {
        logger.error(
          { bookingId: resolution.booking.id, job: "confirmPendingBookings" },
          "Booking has no saved payment method - cannot auto-confirm"
        );
        result.failedBookingIds.push(resolution.booking.id);
        continue;
      }

      claimForCharge = resolution;
      chargeAttempted = true;

      const paymentIntent = await chargePaymentMethod({
        amountCents: resolution.booking.finalPriceCents,
        customerId: resolution.payment.stripeCustomerId,
        paymentMethodId: resolution.payment.stripePaymentMethodId,
        metadata: {
          bookingId: resolution.booking.id,
          memberId: resolution.booking.memberId,
        },
        idempotencyKey: `pending_charge_${resolution.booking.id}`,
      });
      paymentIntentId = paymentIntent.id;

      const paymentMethodId =
        typeof paymentIntent.payment_method === "string"
          ? paymentIntent.payment_method
          : paymentIntent.payment_method?.id ?? null;

      if (paymentIntent.status === "succeeded") {
        paymentSucceeded = true;

        await upsertPaymentIntentTransaction({
          paymentId: resolution.paymentId,
          kind: PaymentTransactionKind.PRIMARY,
          paymentIntentId: paymentIntent.id,
          amountCents: paymentIntent.amount,
          status: PaymentStatus.SUCCEEDED,
          paymentMethodId,
          reason: "pending_hold_auto_charge",
        });

        const reconciliation = await markBookingPaymentSucceeded({
          bookingId: resolution.booking.id,
          paymentIntentId: paymentIntent.id,
          amountCents: paymentIntent.amount,
          paymentMethodId,
        });

        if (
          reconciliation.outcome === "cancelled_refunded" ||
          reconciliation.outcome === "cancelled_refund_failed"
        ) {
          logger.warn(
            {
              bookingId: resolution.booking.id,
              paymentIntentId: paymentIntent.id,
              outcome: reconciliation.outcome,
              job: "confirmPendingBookings",
            },
            "Pending booking payment succeeded but final capacity claim failed"
          );
          result.failedBookingIds.push(resolution.booking.id);
          continue;
        }

        result.confirmedBookingIds.push(resolution.booking.id);
        await queueXeroInvoice(resolution.booking.id, "Xero invoice queued");
        await sendConfirmationEmail(resolution.booking);
      } else {
        await prisma.$transaction(async (tx) => {
          await upsertPaymentIntentTransaction({
            paymentId: resolution.paymentId,
            kind: PaymentTransactionKind.PRIMARY,
            paymentIntentId: paymentIntent.id,
            amountCents: paymentIntent.amount,
            status: PaymentStatus.PROCESSING,
            paymentMethodId,
            reason: "pending_hold_auto_charge",
            store: tx,
          });

          await tx.booking.updateMany({
            where: {
              id: resolution.booking.id,
              status: BookingStatus.CONFIRMED,
            },
            data: {
              status: BookingStatus.PENDING,
              nonMemberHoldUntil: resolution.previousHoldUntil,
            },
          });
          await reconcileBedAllocationsForBooking({
            bookingId: resolution.booking.id,
            db: tx,
            previousRange: {
              checkIn: resolution.booking.checkIn,
              checkOut: resolution.booking.checkOut,
            },
          });
        });

        logger.info(
          {
            bookingId: resolution.booking.id,
            paymentStatus: paymentIntent.status,
            job: "confirmPendingBookings",
          },
          "Booking payment processing"
        );
      }
    } catch (err) {
      logger.error(
        {
          err,
          bookingId: candidate.id,
          job: "confirmPendingBookings",
        },
        "Error processing pending booking"
      );

      // Only roll back the capacity claim when Stripe never confirmed a
      // successful charge. If Stripe succeeded, leave the booking in its
      // claimed state for webhook/admin recovery.
      if (claimForCharge && !paymentSucceeded) {
        await releaseChargeClaim(claimForCharge).catch((revertErr) =>
          logger.error(
            {
              err: revertErr,
              bookingId: claimForCharge?.booking.id,
              job: "confirmPendingBookings",
            },
            "Failed to release pending booking charge claim"
          )
        );
      } else if (paymentSucceeded) {
        logger.error(
          { bookingId: candidate.id, job: "confirmPendingBookings" },
          "Stripe charge succeeded but local booking reconciliation failed; leaving booking claimed for webhook recovery"
        );
      }

      result.failedBookingIds.push(candidate.id);

      // Only emit a payment-failure alert when the Stripe charge attempt itself failed.
      if (chargeAttempted && !paymentSucceeded) {
        sendAdminPaymentFailureAlert({
          memberName: `${candidate.member.firstName} ${candidate.member.lastName}`,
          checkIn: candidate.checkIn,
          checkOut: candidate.checkOut,
          amountCents: candidate.finalPriceCents,
          errorMessage: err instanceof Error ? err.message : String(err),
          paymentIntentId,
        }).catch((alertErr) =>
          logger.error(
            { err: alertErr, bookingId: candidate.id },
            "Failed to send admin payment failure alert"
          )
        );
      }
    }
  }

  return result;
}
