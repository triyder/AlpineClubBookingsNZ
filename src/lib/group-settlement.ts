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
  cancelPaymentIntentIfCancellable,
  createPaymentIntent,
  findOrCreateCustomer,
  getPaymentIntent,
} from "@/lib/stripe";
import { acquireLodgeCapacityLock, checkCapacityForGuestRanges } from "@/lib/capacity";
import { getDefaultLodgeId } from "@/lib/lodges";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { recordBookingEvent } from "@/lib/booking-events";
import {
  enqueueXeroBookingInvoiceOperation,
  enqueueXeroGroupSettlementInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  checkInternetBankingLeadTime,
  loadInternetBankingPaymentSettings,
} from "@/lib/internet-banking-settings";
import {
  buildGroupSettlementPaymentReference,
  type BookingPaymentMethod,
} from "@/lib/booking-payment-methods";
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

type GroupSettlementOutcome =
  | "ready"
  | "invoice_sent"
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
  /**
   * Present when outcome === "invoice_sent": the bank-transfer reference shown
   * to the organiser for the combined Internet Banking invoice.
   */
  reference?: string;
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
          organiserBooking: {
            select: { checkIn: true },
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
  sessionUserId: string,
  paymentMethod: BookingPaymentMethod = "stripe"
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

  // Internet Banking: raise one combined Xero invoice to the organiser instead
  // of charging a card. Reconciliation flips the children to PAID on payment.
  if (paymentMethod === "internet_banking") {
    return createGroupSettlementInvoice(
      group.id,
      group.organiserBooking.checkIn,
      children,
      amountCents,
      group.settlement?.stripePaymentIntentId ?? null,
    );
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
    // Discriminate the key by the intent being superseded, not amount alone.
    // Stripe idempotency keys live 24h, so a bare `groupsettle_<group>_<amount>`
    // can replay a *canceled* prior intent: settle at X (intent A) -> child
    // changes, total Y (intent B, A canceled) -> child reverts to X -> re-settle
    // mints `..._X` again within 24h -> Stripe replays dead intent A. Each intent
    // is superseded at most once, so `(amount, supersededIntentId)` is unique per
    // epoch; two concurrent mints of the *same* attempt read the same
    // `group.settlement` and share the key (Stripe dedupes). The `"initial"`
    // sentinel is safe because real Stripe intent ids are always `pi_…`.
    idempotencyKey: `groupsettle_${group.id}_${amountCents}_${group.settlement?.stripePaymentIntentId ?? "initial"}`,
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

  // The new intent supersedes any prior card attempt (e.g. the total changed).
  // Void the old intent so a retained client_secret in a stale tab can no
  // longer capture money that settles nothing.
  await cancelSupersededSettlementIntent(
    group.settlement?.stripePaymentIntentId ?? null,
    paymentIntent.id,
    group.id,
  );

  return {
    outcome: "ready",
    amountCents,
    childCount: children.length,
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
  };
}

/**
 * Internet Banking settlement: hold the joiners' beds (all-or-nothing, like the
 * Stripe path) then enqueue one combined Xero invoice raised to the organiser.
 * No card is charged; the children stay CONFIRMED until Xero reports the invoice
 * paid, at which point `applyGroupSettlementSucceededFromInvoice` flips them PAID.
 *
 * The module is re-gated here so a server-side IB settlement is impossible when
 * the Internet Banking module is off, even if the UI gate were bypassed.
 */
async function createGroupSettlementInvoice(
  groupBookingId: string,
  checkIn: Date,
  children: SettleableChild[],
  amountCents: number,
  staleStripePaymentIntentId: string | null
): Promise<GroupSettlementIntentResult> {
  const modules = await loadEffectiveModuleFlags();
  if (!modules.xeroIntegration || !modules.internetBankingPayments) {
    throw new GroupBookingError(
      "Internet Banking payments are not available.",
      400
    );
  }
  const internetBankingSettings = await loadInternetBankingPaymentSettings();
  const leadTime = checkInternetBankingLeadTime({
    checkIn,
    settings: internetBankingSettings,
  });
  if (!leadTime.allowed) {
    throw new GroupBookingError(
      leadTime.unavailableReason ??
        "Internet Banking is not available for this check-in date.",
      400,
      {
        code: "INTERNET_BANKING_CUTOFF",
        details: {
          minimumDaysBeforeCheckIn: leadTime.minimumDaysBeforeCheckIn,
          checkIn: leadTime.checkIn,
        },
      },
    );
  }

  // Hold the beds (all-or-nothing) before raising any invoice.
  await commitChildrenToConfirmed(children);

  const settlement = await prisma.groupBookingSettlement.upsert({
    where: { groupBookingId },
    create: {
      groupBookingId,
      source: PaymentSource.INTERNET_BANKING,
      amountCents,
      status: PaymentStatus.PENDING,
    },
    update: {
      source: PaymentSource.INTERNET_BANKING,
      // Drop any stale Stripe intent from a prior card attempt so reconciliation
      // and the webhook never reuse it for an Internet Banking settlement.
      stripePaymentIntentId: null,
      amountCents,
      status: PaymentStatus.PENDING,
    },
  });

  // Void the dropped card intent in Stripe so a retained client_secret in a
  // stale tab can no longer capture money alongside the combined invoice.
  await cancelSupersededSettlementIntent(
    staleStripePaymentIntentId,
    null,
    groupBookingId,
  );

  // Enqueue the combined invoice. A failure here is logged, not thrown: the beds
  // are held and the settlement is recorded, and the outbox can be re-driven.
  try {
    const queued = await enqueueXeroGroupSettlementInvoiceOperation(settlement.id);
    if (queued.queueOperationId) {
      await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
    }
  } catch (xeroErr) {
    logger.error(
      { err: xeroErr, groupBookingId, settlementId: settlement.id },
      "Failed to queue combined Xero invoice for group settlement"
    );
  }

  return {
    outcome: "invoice_sent",
    amountCents,
    childCount: children.length,
    reference: buildGroupSettlementPaymentReference(groupBookingId),
  };
}

/**
 * Best-effort void of a group-settlement PaymentIntent the settlement no longer
 * references (method switch or card re-attempt). Runs after the settlement row
 * is updated and outside any database transaction. A failed cancel is logged
 * and never breaks the settlement flow: if the stale intent later captures, the
 * webhook safety net refunds it and alerts admins.
 */
async function cancelSupersededSettlementIntent(
  staleIntentId: string | null,
  currentIntentId: string | null,
  groupBookingId: string
) {
  if (!staleIntentId || staleIntentId === currentIntentId) {
    return;
  }
  try {
    await cancelPaymentIntentIfCancellable(staleIntentId);
  } catch (err) {
    logger.error(
      { err, groupBookingId, paymentIntentId: staleIntentId },
      "Failed to cancel superseded group settlement intent; the webhook safety net will refund it if it captures"
    );
  }
}

/**
 * Commit every still-PAYMENT_PENDING child to CONFIRMED under the CHILDREN'S
 * per-lodge advisory lock(s), claiming capacity for each in turn so later
 * children see the earlier ones' beds. All-or-nothing: if any child no longer
 * fits, the whole transaction rolls back and a 409 lists the nights that are
 * full.
 */
async function commitChildrenToConfirmed(children: SettleableChild[]) {
  const pending = children.filter(
    (c) => c.status === BookingStatus.PAYMENT_PENDING
  );
  if (pending.length === 0) return;

  await prisma.$transaction(async (tx) => {
    // Flipping PAYMENT_PENDING -> CONFIRMED is a net-new capacity claim, so it
    // must serialize under the lodge whose beds are being claimed: the child's
    // lodge, NOT the group's default lodge. Booking creators at that lodge hold
    // hash(childLodge); locking hash(default) for a non-default-lodge group
    // would leave them unserialized (overbooking race). Read the pending
    // children's lodge ids first (lodgeId is NOT NULL, so no fallback is
    // needed), then lock every distinct lodge in sorted id order before
    // claiming any capacity — deadlock-safe, matching the draft-cleanup cron.
    // Group joins cannot cross lodges, so this is normally a single lodge; the
    // multi-lock loop is defensive.
    const pendingLodgeRows = await tx.booking.findMany({
      where: { id: { in: pending.map((c) => c.id) } },
      select: { lodgeId: true },
    });
    const lodgeIds = Array.from(
      new Set(pendingLodgeRows.map((row) => row.lodgeId))
    ).sort();
    for (const lodgeId of lodgeIds) {
      await acquireLodgeCapacityLock(tx, lodgeId);
    }

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
        fresh.lodgeId,
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

/** The settlement shape the shared settle/notify routine needs. */
interface LoadedSettlementForApply {
  id: string;
  amountCents: number;
  stripeCustomerId: string | null;
  groupBookingId: string;
  groupBooking: {
    organiserBookingId: string;
    organiserMember: { email: string; firstName: string; lastName: string };
    organiserBooking: { checkIn: Date; checkOut: Date };
  };
}

/** The relation includes both apply paths load on their settlement row. */
const APPLY_SETTLEMENT_INCLUDE = {
  groupBooking: {
    select: {
      organiserBookingId: true,
      organiserMember: { select: { email: true, firstName: true, lastName: true } },
      organiserBooking: { select: { checkIn: true, checkOut: true } },
    },
  },
} as const;

/**
 * Flip every committed (CONFIRMED) organiser-settled child to PAID exactly once,
 * record a Payment per child, mark the settlement SUCCEEDED, and notify everyone.
 * Idempotent under the booking advisory lock. Shared by the Stripe webhook and
 * the Internet Banking Xero-invoice reconciliation paths.
 *
 * @param options.enqueueChildInvoices  Stripe settlements raise a Xero invoice
 *   per child; Internet Banking settlements are already covered by the single
 *   combined invoice, so they pass `false` to avoid duplicate invoices.
 */
async function settleConfirmedChildrenAndNotify(
  settlement: LoadedSettlementForApply,
  options: {
    source: PaymentSource;
    reference: string;
    stripeCustomerId?: string | null;
    enqueueChildInvoices: boolean;
  }
): Promise<GroupSettlementAppliedResult> {
  const settled = await prisma.$transaction(async (tx) => {
    // This path only flips CONFIRMED -> PAID; both statuses already hold
    // capacity, so NO net-new capacity claim occurs here and the lock key is
    // immaterial to capacity correctness. The default-lodge key is therefore
    // acceptable (and kept for continuity) — do NOT copy this into a path that
    // CLAIMS capacity (e.g. commitChildrenToConfirmed above), which must lock
    // the specific lodge whose beds it reserves.
    const defaultLodgeId = await getDefaultLodgeId(tx);
    await acquireLodgeCapacityLock(tx, defaultLodgeId);

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

    // Re-verify the settlement total against the children as they exist NOW,
    // under the lock (#1033). A joiner can modify their CONFIRMED child
    // booking while the combined intent/invoice sits open, so a payment that
    // matches the *recorded* settlement amount can still mismatch what the
    // children currently cost. Never auto-apply such a payment — hand it to
    // the operator-review path instead.
    const currentTotalCents = children.reduce(
      (sum, child) => sum + child.finalPriceCents,
      0
    );
    if (currentTotalCents !== settlement.amountCents) {
      logger.error(
        {
          groupBookingId: settlement.groupBookingId,
          settlementId: settlement.id,
          recordedCents: settlement.amountCents,
          currentChildrenCents: currentTotalCents,
          childCount: children.length,
        },
        "Group settlement total no longer matches its children - refusing to auto-apply payment"
      );
      return null;
    }

    const settledIds: string[] = [];
    for (const child of children) {
      await tx.payment.upsert({
        where: { bookingId: child.id },
        create: {
          bookingId: child.id,
          amountCents: child.finalPriceCents,
          source: options.source,
          status: PaymentStatus.SUCCEEDED,
          reference: options.reference,
          stripeCustomerId: options.stripeCustomerId ?? null,
        },
        update: {
          status: PaymentStatus.SUCCEEDED,
          source: options.source,
          reference: options.reference,
          stripeCustomerId: options.stripeCustomerId ?? null,
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

  if (settled === null) {
    return { outcome: "amount_mismatch", settledBookingIds: [] };
  }

  // Side effects after commit: a durable "paid" booking event and (Stripe only)
  // a Xero invoice per child. Failures here are logged but never undo the
  // settlement.
  for (const bookingId of settled) {
    await recordBookingEvent({
      bookingId,
      type: BookingEventType.MEMBER_PAID,
      actorMemberId: null,
      reason: "Settled by the group organiser as part of the combined group bill",
    });
    if (options.enqueueChildInvoices) {
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
      groupBookingId: settlement.groupBookingId,
      settledCount: settled.length,
      source: options.source,
    },
    "Group settlement paid"
  );

  return { outcome: "settled", settledBookingIds: settled };
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
    include: APPLY_SETTLEMENT_INCLUDE,
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

  return settleConfirmedChildrenAndNotify(settlement, {
    source: PaymentSource.STRIPE,
    reference: paymentIntent.id,
    stripeCustomerId: settlement.stripeCustomerId,
    enqueueChildInvoices: true,
  });
}

/**
 * Reconciliation handler for a paid combined Internet Banking settlement invoice.
 * Matched by `GroupBookingSettlement.xeroInvoiceId` when Xero reports the invoice
 * PAID; flips every CONFIRMED organiser-settled child to PAID and marks the
 * settlement SUCCEEDED. Idempotent across re-reconciliation.
 */
export async function applyGroupSettlementSucceededFromInvoice(
  xeroInvoiceId: string
): Promise<GroupSettlementAppliedResult> {
  const settlement = await prisma.groupBookingSettlement.findFirst({
    where: { xeroInvoiceId },
    include: APPLY_SETTLEMENT_INCLUDE,
  });

  if (!settlement) {
    logger.warn(
      { xeroInvoiceId },
      "Group settlement invoice paid but no settlement record found"
    );
    return { outcome: "not_found", settledBookingIds: [] };
  }

  if (settlement.status === PaymentStatus.SUCCEEDED) {
    return { outcome: "already_settled", settledBookingIds: [] };
  }

  return settleConfirmedChildrenAndNotify(settlement, {
    source: PaymentSource.INTERNET_BANKING,
    reference: settlement.xeroInvoiceNumber ?? xeroInvoiceId,
    stripeCustomerId: null,
    enqueueChildInvoices: false,
  });
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
  // Guard an out-of-order payment_failed/canceled webhook racing payment_intent.succeeded:
  // atomically move only a settlement that is NOT already in a positive terminal state.
  // markGroupSettlementIntentFailed only records a non-success outcome (its callers are the
  // payment_failed and payment_intent.canceled webhooks, both stored as FAILED), so it can never
  // legitimately need to leave SUCCEEDED/REFUNDED/PARTIALLY_REFUNDED. updateMany fuses the
  // "still non-terminal?" check with the write; a no-match (incl. unknown intent) is a no-op.
  await prisma.groupBookingSettlement.updateMany({
    where: {
      stripePaymentIntentId: paymentIntentId,
      status: {
        notIn: [
          PaymentStatus.SUCCEEDED,
          PaymentStatus.REFUNDED,
          PaymentStatus.PARTIALLY_REFUNDED,
        ],
      },
    },
    data: { status },
  });
}
