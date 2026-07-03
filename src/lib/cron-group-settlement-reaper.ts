/**
 * Stale organiser-pays group settlement reaper (#1034).
 *
 * Initiating an organiser-pays settlement commits every child booking to
 * CONFIRMED (capacity-holding) before any money is charged. If the organiser
 * abandons the payment (closed tab, declined card never retried), nothing
 * released those beds: the children sat CONFIRMED-but-unpaid until check-in,
 * blocking capacity and the waitlist (PR #801 residual).
 *
 * This cron releases them: a settlement still unpaid (PENDING or FAILED) past
 * its deadline reverts its CONFIRMED unpaid children to PAYMENT_PENDING (their
 * pre-commit, non-capacity-holding state), voids any open Stripe intent so a
 * stale tab cannot capture, notifies the organiser and joiners, records
 * booking events, and triggers waitlist processing for the freed nights.
 *
 * Deadline: `updatedAt + GROUP_SETTLEMENT_REAP_HOURS` (default 48h), clamped
 * to the organiser booking's check-in so beds free before the stay begins,
 * with a two-hour floor so an arrival-day settlement is never reaped while
 * the organiser is mid-payment. A retry resets `updatedAt` (the initiate flow
 * upserts the settlement row), restarting the clock.
 *
 * Idempotent: children are re-read and reverted under the same advisory lock
 * the settle path takes, so a payment that lands just before the reaper wins
 * (SUCCEEDED settlements are skipped inside the lock), and a rerun finds no
 * CONFIRMED children and does nothing.
 */
import {
  BookingEventType,
  BookingStatus,
  PaymentStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cancelPaymentIntentIfCancellable } from "@/lib/stripe";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { recordBookingEvent } from "@/lib/booking-events";
import { processWaitlistForDates } from "@/lib/waitlist";
import {
  sendGroupSettlementExpiredEmail,
  sendGroupJoinReleasedEmail,
} from "@/lib/email";
import logger from "@/lib/logger";

export const GROUP_SETTLEMENT_REAP_HOURS =
  Number(process.env.GROUP_SETTLEMENT_REAP_HOURS) || 48;

/** Floor so an arrival-day settlement is not reaped while mid-payment. */
const MIN_GRACE_MS = 2 * 60 * 60 * 1000;

export interface GroupSettlementReapResult {
  scanned: number;
  reaped: number;
  releasedChildBookings: number;
}

/** The reap deadline for one settlement (exported for the operator dashboard). */
export function groupSettlementReapDeadline(
  updatedAt: Date,
  checkIn: Date,
  reapHours: number = GROUP_SETTLEMENT_REAP_HOURS
): Date {
  const windowMs = reapHours * 60 * 60 * 1000;
  return new Date(
    Math.max(
      updatedAt.getTime() + MIN_GRACE_MS,
      Math.min(updatedAt.getTime() + windowMs, checkIn.getTime())
    )
  );
}

const REAPABLE_SETTLEMENT_STATUSES = [
  PaymentStatus.PENDING,
  PaymentStatus.FAILED,
] as const;

export async function reapStaleGroupSettlements(
  now: Date = new Date()
): Promise<GroupSettlementReapResult> {
  const candidates = await prisma.groupBookingSettlement.findMany({
    where: { status: { in: [...REAPABLE_SETTLEMENT_STATUSES] } },
    select: {
      id: true,
      status: true,
      amountCents: true,
      updatedAt: true,
      stripePaymentIntentId: true,
      groupBookingId: true,
      groupBooking: {
        select: {
          organiserBookingId: true,
          organiserMember: {
            select: { email: true, firstName: true, lastName: true },
          },
          organiserBooking: { select: { checkIn: true, checkOut: true } },
        },
      },
    },
  });

  const result: GroupSettlementReapResult = {
    scanned: candidates.length,
    reaped: 0,
    releasedChildBookings: 0,
  };

  for (const settlement of candidates) {
    const deadline = groupSettlementReapDeadline(
      settlement.updatedAt,
      settlement.groupBooking.organiserBooking.checkIn
    );
    if (now < deadline) {
      continue;
    }

    try {
      const released = await releaseSettlementChildren(settlement.id, {
        organiserBookingId: settlement.groupBooking.organiserBookingId,
      });
      if (released === null || released.length === 0) {
        // Settled (or already reaped) in the meantime — nothing to release,
        // nothing to notify. A rerun lands here, keeping the cron idempotent.
        continue;
      }

      result.reaped += 1;
      result.releasedChildBookings += released.length;

      await finishReap({
        settlement,
        released,
      });
    } catch (err) {
      logger.error(
        { err, settlementId: settlement.id, groupBookingId: settlement.groupBookingId },
        "Failed to reap stale group settlement"
      );
    }
  }

  return result;
}

type ReleasedChild = {
  id: string;
  checkIn: Date;
  checkOut: Date;
  memberEmail: string;
  memberFirstName: string;
};

/**
 * Revert the settlement's CONFIRMED unpaid children to PAYMENT_PENDING under
 * the same advisory lock the settle path takes. Returns null when the
 * settlement succeeded in the meantime (payment race — the payment wins).
 */
async function releaseSettlementChildren(
  settlementId: string,
  { organiserBookingId }: { organiserBookingId: string }
): Promise<ReleasedChild[] | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

    const current = await tx.groupBookingSettlement.findUnique({
      where: { id: settlementId },
      select: { status: true },
    });
    if (
      !current ||
      !(REAPABLE_SETTLEMENT_STATUSES as readonly PaymentStatus[]).includes(
        current.status
      )
    ) {
      return null;
    }

    const children = await tx.booking.findMany({
      where: {
        parentBookingId: organiserBookingId,
        organiserSettled: true,
        deletedAt: null,
        status: BookingStatus.CONFIRMED,
      },
      select: {
        id: true,
        checkIn: true,
        checkOut: true,
        member: { select: { email: true, firstName: true } },
      },
    });

    for (const child of children) {
      await tx.booking.update({
        where: { id: child.id },
        data: { status: BookingStatus.PAYMENT_PENDING },
      });
      // PAYMENT_PENDING does not hold capacity: drop the bed allocations.
      await reconcileBedAllocationsForBooking({
        bookingId: child.id,
        db: tx,
        previousRange: { checkIn: child.checkIn, checkOut: child.checkOut },
      });
    }

    await tx.groupBookingSettlement.update({
      where: { id: settlementId },
      data: { status: PaymentStatus.FAILED },
    });

    return children.map((child) => ({
      id: child.id,
      checkIn: child.checkIn,
      checkOut: child.checkOut,
      memberEmail: child.member.email,
      memberFirstName: child.member.firstName,
    }));
  });
}

/** Post-commit side effects: void the intent, record events, notify, waitlist. */
async function finishReap({
  settlement,
  released,
}: {
  settlement: {
    id: string;
    amountCents: number;
    stripePaymentIntentId: string | null;
    groupBookingId: string;
    groupBooking: {
      organiserMember: { email: string; firstName: string; lastName: string };
      organiserBooking: { checkIn: Date; checkOut: Date };
    };
  };
  released: ReleasedChild[];
}) {
  // Void the abandoned intent so a retained client_secret cannot capture. A
  // failed cancel is logged only: if the stale intent later captures, the
  // webhook safety net refunds it and alerts admins (#1021).
  if (settlement.stripePaymentIntentId) {
    try {
      await cancelPaymentIntentIfCancellable(settlement.stripePaymentIntentId);
    } catch (err) {
      logger.error(
        {
          err,
          settlementId: settlement.id,
          paymentIntentId: settlement.stripePaymentIntentId,
        },
        "Failed to cancel reaped group settlement intent; the webhook safety net covers a late capture"
      );
    }
  }

  for (const child of released) {
    await recordBookingEvent({
      bookingId: child.id,
      type: BookingEventType.BUMPED,
      reason:
        "The group organiser's combined payment was not completed in time; the held spot was released.",
    });
    processWaitlistForDates({
      checkIn: child.checkIn,
      checkOut: child.checkOut,
    }).catch((err) =>
      logger.error(
        { err, bookingId: child.id },
        "Failed to process waitlist after group settlement reap"
      )
    );
  }

  const organiser = settlement.groupBooking.organiserMember;
  const organiserBooking = settlement.groupBooking.organiserBooking;
  const organiserName = `${organiser.firstName} ${organiser.lastName}`.trim();

  try {
    await sendGroupSettlementExpiredEmail({
      email: organiser.email,
      firstName: organiser.firstName,
      checkIn: organiserBooking.checkIn,
      checkOut: organiserBooking.checkOut,
      joinerCount: released.length,
      totalCents: settlement.amountCents,
    });
  } catch (err) {
    logger.error(
      { err, groupBookingId: settlement.groupBookingId },
      "Failed to send settlement-expired email to organiser"
    );
  }

  for (const child of released) {
    try {
      await sendGroupJoinReleasedEmail({
        email: child.memberEmail,
        firstName: child.memberFirstName,
        organiserName,
        checkIn: child.checkIn,
        checkOut: child.checkOut,
      });
    } catch (err) {
      logger.error(
        { err, bookingId: child.id },
        "Failed to send settlement-expired email to joiner"
      );
    }
  }

  logger.info(
    {
      groupBookingId: settlement.groupBookingId,
      settlementId: settlement.id,
      releasedCount: released.length,
    },
    "Reaped stale group settlement"
  );
}
