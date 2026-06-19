/**
 * Group bookings — ORGANISER_PAYS settlement collection.
 *
 * The organiser of an ORGANISER_PAYS group settles every joiner's child booking
 * as one combined bill. Each child booking was created PAYMENT_PENDING and
 * flagged `organiserSettled`, so the joiner is never billed and cannot pay it.
 *
 * Settlement reuses the existing pay-on-account semantics (issue #709):
 *
 *   1. When the organiser starts a settlement, the children are committed to
 *      CONFIRMED under the same advisory lock as every other creation path. A
 *      CONFIRMED booking holds capacity, so the beds are reserved the moment the
 *      organiser commits to pay — exactly like a school group's emailed invoice.
 *      The capacity claim is all-or-nothing: if any child no longer fits, no
 *      child is committed and no money is taken, and the organiser is told who
 *      could not be placed so they can remove them and retry.
 *   2. A single Stripe PaymentIntent for the combined total is created and
 *      recorded on GroupBookingSettlement.
 *   3. On `payment_intent.succeeded` (webhook, type=group_settlement) the
 *      children flip CONFIRMED -> PAID exactly once. Because the beds were
 *      already held at CONFIRMED there is no second capacity race and no refund
 *      path: the combined charge simply settles bookings whose beds are secured.
 *
 * Conventions match group-booking.ts: integer cents, NZ date-only booking dates,
 * Stripe/Xero calls run outside the database transaction.
 */
import {
  BookingEventType,
  BookingStatus,
  GroupBookingPaymentMode,
  PaymentSource,
  PaymentStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  createPaymentIntent,
  findOrCreateCustomer,
  getPaymentIntent,
} from "@/lib/stripe";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { recordBookingEvent } from "@/lib/booking-events";
import {
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { GroupBookingError, normaliseJoinCode } from "@/lib/group-booking";
import {
  sendGroupJoinSettledEmail,
  sendGroupSettlementReceiptEmail,
} from "@/lib/email";
import logger from "@/lib/logger";

/** Statuses an organiser-settled child can hold before it is settled. */
const SETTLEABLE_CHILD_STATUSES = [
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
] as const;

export type GroupSettlementOutcome =
  | "ready"
  | "already_settled"
  | "nothing_to_settle";

export interface GroupSettlementIntentResult {
  outcome: GroupSettlementOutcome;
  /** Combined total for the organiser-settled children, in cents. */
  amountCents: number;
  /** Number of child bookings covered by this settlement. */
  childCount: number;
  /** Present when outcome === "ready": pass to Stripe Elements. */
  clientSecret?: string | null;
  paymentIntentId?: string;
}

interface SettleableChild {
  id: string;
  finalPriceCents: number;
  status: BookingStatus;
}

/** Load the group with the fields settlement needs, asserting organiser ownership. */
async function requireOrganiserPaysGroup(rawCode: string, sessionUserId: string) {
  const code = normaliseJoinCode(rawCode);
  const group = code
    ? await prisma.groupBooking.findUnique({
        where: { joinCode: code },
        select: {
          id: true,
          organiserMemberId: true,
          organiserBookingId: true,
          paymentMode: true,
          organiserMember: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
          settlement: true,
        },
      })
    : null;

  if (!group) {
    throw new GroupBookingError("Group booking not found", 404);
  }
  if (group.organiserMemberId !== sessionUserId) {
    throw new GroupBookingError("This is not your group booking", 403);
  }
  if (group.paymentMode !== GroupBookingPaymentMode.ORGANISER_PAYS) {
    throw new GroupBookingError(
      "This group is each-pays-own; joiners settle their own bookings",
      409
    );
  }
  return group;
}

/** All organiser-settled children of the group still awaiting settlement. */
async function loadSettleableChildren(
  organiserBookingId: string
): Promise<SettleableChild[]> {
  return prisma.booking.findMany({
    where: {
      parentBookingId: organiserBookingId,
      organiserSettled: true,
      deletedAt: null,
      status: { in: [...SETTLEABLE_CHILD_STATUSES] },
    },
    select: { id: true, finalPriceCents: true, status: true },
  });
}

/**
 * Start (or resume) an organiser settlement: commit the children to CONFIRMED
 * (capacity held) and return a Stripe client secret for the combined total.
 *
 * Idempotent: a child already CONFIRMED from a prior attempt is reused, and an
 * outstanding PaymentIntent for the same total is returned rather than charged
 * twice.
 */
export async function createGroupSettlementIntent(
  rawCode: string,
  sessionUserId: string
): Promise<GroupSettlementIntentResult> {
  const group = await requireOrganiserPaysGroup(rawCode, sessionUserId);

  if (group.settlement?.status === PaymentStatus.SUCCEEDED) {
    return {
      outcome: "already_settled",
      amountCents: group.settlement.amountCents,
      childCount: 0,
    };
  }

  const children = await loadSettleableChildren(group.organiserBookingId);
  if (children.length === 0) {
    return { outcome: "nothing_to_settle", amountCents: 0, childCount: 0 };
  }

  const amountCents = children.reduce((sum, c) => sum + c.finalPriceCents, 0);
  if (amountCents <= 0) {
    // Zero-dollar joiners auto-confirm at creation and never reach here; guard
    // anyway so we never open a Stripe intent for nothing.
    return { outcome: "nothing_to_settle", amountCents: 0, childCount: 0 };
  }

  // Reuse an outstanding intent for the same total before creating a new one,
  // mirroring the single-booking create-payment-intent route. A succeeded intent
  // means the webhook is mid-flight or was missed; reconcile and report settled.
  if (
    group.settlement?.stripePaymentIntentId &&
    group.settlement.amountCents === amountCents
  ) {
    const existing = await getPaymentIntent(group.settlement.stripePaymentIntentId);
    if (existing.status === "succeeded") {
      await applyGroupSettlementSucceeded({
        id: existing.id,
        amount: existing.amount,
      });
      return { outcome: "already_settled", amountCents, childCount: children.length };
    }
    if (existing.client_secret && existing.status !== "canceled") {
      // Make sure the children are committed even when we reuse the intent.
      await commitChildrenToConfirmed(children);
      return {
        outcome: "ready",
        amountCents,
        childCount: children.length,
        clientSecret: existing.client_secret,
        paymentIntentId: existing.id,
      };
    }
  }

  // Commit the beds (all-or-nothing) before charging anything.
  await commitChildrenToConfirmed(children);

  const customer = await findOrCreateCustomer({
    email: group.organiserMember.email,
    name: `${group.organiserMember.firstName} ${group.organiserMember.lastName}`,
    memberId: group.organiserMember.id,
  });

  const paymentIntent = await createPaymentIntent({
    amountCents,
    customerId: customer.id,
    metadata: {
      type: "group_settlement",
      groupBookingId: group.id,
      organiserMemberId: group.organiserMemberId,
    },
    idempotencyKey: `groupsettle_${group.id}_${amountCents}`,
  });

  await prisma.groupBookingSettlement.upsert({
    where: { groupBookingId: group.id },
    create: {
      groupBookingId: group.id,
      stripePaymentIntentId: paymentIntent.id,
      stripeCustomerId: customer.id,
      amountCents,
      status: PaymentStatus.PENDING,
    },
    update: {
      stripePaymentIntentId: paymentIntent.id,
      stripeCustomerId: customer.id,
      amountCents,
      status: PaymentStatus.PENDING,
    },
  });

  return {
    outcome: "ready",
    amountCents,
    childCount: children.length,
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
  };
}

/**
 * Commit every still-PAYMENT_PENDING child to CONFIRMED under the global booking
 * advisory lock, claiming capacity for each in turn so later children see the
 * earlier ones' beds. All-or-nothing: if any child no longer fits, the whole
 * transaction rolls back and a 409 lists the nights that are full.
 */
async function commitChildrenToConfirmed(children: SettleableChild[]) {
  const pending = children.filter(
    (c) => c.status === BookingStatus.PAYMENT_PENDING
  );
  if (pending.length === 0) return;

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

    for (const child of pending) {
      // Re-read inside the lock; another path may have already moved it.
      const fresh = await tx.booking.findUnique({
        where: { id: child.id },
        include: { guests: { include: { nights: true } } },
      });
      if (!fresh || fresh.status !== BookingStatus.PAYMENT_PENDING) {
        continue;
      }

      const capacity = await checkCapacityForGuestRanges(
        fresh.checkIn,
        fresh.checkOut,
        fresh.guests,
        fresh.id,
        tx
      );
      if (!capacity.available) {
        const fullNights = capacity.nightDetails
          .filter((n) => n.availableBeds < 0)
          .map((n) => n.date);
        throw new GroupBookingError(
          "The lodge is full for these dates, so the group cannot be settled",
          409,
          { code: "CAPACITY_EXCEEDED", details: { bookingId: fresh.id, fullNights } }
        );
      }

      await tx.booking.update({
        where: { id: fresh.id },
        data: { status: BookingStatus.CONFIRMED, draftExpiresAt: null },
      });
      // CONFIRMED holds capacity, so the next child's check counts these beds.
      await reconcileBedAllocationsForBooking({
        bookingId: fresh.id,
        db: tx,
        previousRange: { checkIn: fresh.checkIn, checkOut: fresh.checkOut },
      });
    }
  });
}

export interface GroupSettlementAppliedResult {
  outcome: "settled" | "already_settled" | "not_found" | "amount_mismatch";
  settledBookingIds: string[];
}

/**
 * Webhook handler for a succeeded group-settlement PaymentIntent. Flips every
 * committed (CONFIRMED) organiser-settled child to PAID exactly once, records a
 * Payment per child referencing the combined intent, and marks the settlement
 * SUCCEEDED. Idempotent across webhook redelivery.
 */
export async function applyGroupSettlementSucceeded(paymentIntent: {
  id: string;
  amount: number;
}): Promise<GroupSettlementAppliedResult> {
  const settlement = await prisma.groupBookingSettlement.findUnique({
    where: { stripePaymentIntentId: paymentIntent.id },
    include: {
      groupBooking: {
        select: {
          organiserBookingId: true,
          organiserMember: { select: { email: true, firstName: true, lastName: true } },
          organiserBooking: { select: { checkIn: true, checkOut: true } },
        },
      },
    },
  });

  if (!settlement) {
    logger.warn(
      { paymentIntentId: paymentIntent.id },
      "Group settlement PaymentIntent succeeded but no settlement record found"
    );
    return { outcome: "not_found", settledBookingIds: [] };
  }

  if (settlement.status === PaymentStatus.SUCCEEDED) {
    return { outcome: "already_settled", settledBookingIds: [] };
  }

  // Never auto-apply a payment whose amount does not match what we recorded;
  // leave the settlement PENDING for an operator to review.
  if (paymentIntent.amount !== settlement.amountCents) {
    logger.error(
      {
        paymentIntentId: paymentIntent.id,
        expectedCents: settlement.amountCents,
        receivedCents: paymentIntent.amount,
        groupBookingId: settlement.groupBookingId,
      },
      "Group settlement amount mismatch - refusing to auto-apply payment"
    );
    return { outcome: "amount_mismatch", settledBookingIds: [] };
  }

  const settled = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

    // Re-confirm the settlement is still unpaid inside the lock (idempotency).
    const current = await tx.groupBookingSettlement.findUnique({
      where: { id: settlement.id },
      select: { status: true },
    });
    if (current?.status === PaymentStatus.SUCCEEDED) {
      return [] as string[];
    }

    const children = await tx.booking.findMany({
      where: {
        parentBookingId: settlement.groupBooking.organiserBookingId,
        organiserSettled: true,
        deletedAt: null,
        status: BookingStatus.CONFIRMED,
      },
      select: { id: true, finalPriceCents: true, checkIn: true, checkOut: true },
    });

    const settledIds: string[] = [];
    for (const child of children) {
      await tx.payment.upsert({
        where: { bookingId: child.id },
        create: {
          bookingId: child.id,
          amountCents: child.finalPriceCents,
          source: PaymentSource.STRIPE,
          status: PaymentStatus.SUCCEEDED,
          reference: paymentIntent.id,
          stripeCustomerId: settlement.stripeCustomerId,
        },
        update: {
          status: PaymentStatus.SUCCEEDED,
          reference: paymentIntent.id,
          stripeCustomerId: settlement.stripeCustomerId,
        },
      });
      await tx.booking.update({
        where: { id: child.id },
        data: { status: BookingStatus.PAID, draftExpiresAt: null },
      });
      await reconcileBedAllocationsForBooking({
        bookingId: child.id,
        db: tx,
        previousRange: { checkIn: child.checkIn, checkOut: child.checkOut },
      });
      settledIds.push(child.id);
    }

    await tx.groupBookingSettlement.update({
      where: { id: settlement.id },
      data: { status: PaymentStatus.SUCCEEDED, paidAt: new Date() },
    });

    return settledIds;
  });

  // Side effects after commit: a durable "paid" booking event and a Xero invoice
  // per child. Failures here are logged but never undo the settlement.
  for (const bookingId of settled) {
    await recordBookingEvent({
      bookingId,
      type: BookingEventType.MEMBER_PAID,
      actorMemberId: null,
      reason: "Settled by the group organiser as part of the combined group bill",
    });
    try {
      const queued = await enqueueXeroBookingInvoiceOperation(bookingId);
      if (queued.queueOperationId) {
        await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
      }
    } catch (xeroErr) {
      logger.error(
        { err: xeroErr, bookingId },
        "Failed to queue Xero invoice for settled group child booking"
      );
    }
  }

  // Notify the organiser (receipt) and each joiner (spot confirmed). Email
  // failures are logged but never undo the settlement.
  if (settled.length > 0) {
    const organiser = settlement.groupBooking.organiserMember;
    const organiserBooking = settlement.groupBooking.organiserBooking;
    const organiserName = `${organiser.firstName} ${organiser.lastName}`.trim();
    try {
      await sendGroupSettlementReceiptEmail({
        email: organiser.email,
        firstName: organiser.firstName,
        checkIn: organiserBooking.checkIn,
        checkOut: organiserBooking.checkOut,
        joinerCount: settled.length,
        totalCents: settlement.amountCents,
      });
    } catch (emailErr) {
      logger.error(
        { err: emailErr, groupBookingId: settlement.groupBookingId },
        "Failed to send group settlement receipt to organiser"
      );
    }

    const settledBookings = await prisma.booking.findMany({
      where: { id: { in: settled } },
      select: {
        checkIn: true,
        checkOut: true,
        member: { select: { email: true, firstName: true } },
        _count: { select: { guests: true } },
      },
    });
    for (const booking of settledBookings) {
      try {
        await sendGroupJoinSettledEmail({
          email: booking.member.email,
          firstName: booking.member.firstName,
          organiserName,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          guestCount: booking._count.guests,
        });
      } catch (emailErr) {
        logger.error(
          { err: emailErr, groupBookingId: settlement.groupBookingId },
          "Failed to send settled-spot confirmation to group joiner"
        );
      }
    }
  }

  logger.info(
    {
      paymentIntentId: paymentIntent.id,
      groupBookingId: settlement.groupBookingId,
      settledCount: settled.length,
    },
    "Group settlement paid"
  );

  return { outcome: "settled", settledBookingIds: settled };
}

/**
 * Webhook handler for a failed or canceled group-settlement PaymentIntent. The
 * children stay CONFIRMED (beds held) so the organiser can retry; we only record
 * the failed state on the settlement so the UI can prompt another attempt.
 */
export async function markGroupSettlementIntentFailed(
  paymentIntentId: string,
  status: PaymentStatus = PaymentStatus.FAILED
): Promise<void> {
  const settlement = await prisma.groupBookingSettlement.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    select: { id: true, status: true },
  });
  if (!settlement || settlement.status === PaymentStatus.SUCCEEDED) {
    return;
  }
  await prisma.groupBookingSettlement.update({
    where: { id: settlement.id },
    data: { status },
  });
}
