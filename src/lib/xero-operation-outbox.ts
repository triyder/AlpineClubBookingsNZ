import { PaymentSource, Prisma } from "@prisma/client";
import logger from "@/lib/logger";
import {
  createXeroMembershipCancellationCreditNote,
  syncXeroMembershipCancellationContact,
} from "@/lib/membership-cancellation-xero";
import { prisma } from "@/lib/prisma";
import { claimXeroSyncOperationToRunning } from "@/lib/xero-operation-claim";
import { getSeasonYear } from "@/lib/utils";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  findCanonicalPaymentRefundCreditNote,
  startXeroSyncOperation,
  sumCoveredRefundCreditNoteCents,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";
import {
  createXeroInvoiceForBooking,
  updateXeroBookingInvoiceForBooking,
} from "@/lib/xero-booking-invoices";
import {
  allocateCreditNoteToInvoice,
  createUnappliedXeroCreditNote,
  createUnappliedXeroCreditNoteForModification,
  createXeroCreditNote,
} from "@/lib/xero-credit-notes";
import { createXeroEntranceFeeInvoice } from "@/lib/xero-entrance-fee-invoices";
import {
  buildEntranceFeeInvoiceIdempotencyKey,
  ENTRANCE_FEE_EXEMPT_MESSAGE,
  getEntranceFeeContext,
  type EntranceFeeContext,
} from "@/lib/xero-mappings";
import { createXeroCreditNoteForModification } from "@/lib/xero-modification-credit-notes";
import { allocateAppliedCreditForBooking } from "@/lib/xero-applied-credit-allocation";
import { createXeroSupplementaryInvoice } from "@/lib/xero-supplementary-invoices";
import { isXeroConnected } from "@/lib/xero-token-store";
import { createXeroInvoiceForGroupSettlement } from "@/lib/xero-group-settlement-invoices";
import { createXeroMembershipSubscriptionInvoice } from "@/lib/xero-subscription-invoices";
import {
  getQueuedOutboxExpectedOperation,
  readQueuedOutboxPayload,
  readQueueType,
  XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE,
  XERO_OUTBOX_BOOKING_INVOICE_TYPE,
  XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE,
  XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE,
  XERO_OUTBOX_ENTRANCE_FEE_TYPE,
  XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_TYPE,
  XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CONTACT_TYPE,
  XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_QUEUE_TYPES,
  XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
  XERO_OUTBOX_SUBSCRIPTION_INVOICE_TYPE,
  type QueuedOutboxExpectedOperation,
  type QueuedOutboxPayload,
} from "@/lib/xero-operation-outbox-payload";

async function claimQueuedOutboxOperation(
  operationId: string,
  expectedOperation: QueuedOutboxExpectedOperation
) {
  // Delegates to the shared claim-to-RUNNING single-flight (#1272). The guard
  // below is the outbound-outbox predicate; combined with the helper's
  // `status: "PENDING"` precondition the resulting WHERE is identical to the
  // pre-consolidation inline claim.
  return claimXeroSyncOperationToRunning(operationId, {
    direction: "OUTBOUND",
    entityType: expectedOperation.entityType,
    operationType: expectedOperation.operationType,
    localModel: {
      in: [...expectedOperation.localModels],
    },
  });
}

function buildPrecomputedEntranceFeeContext(
  payload: QueuedOutboxPayload
): EntranceFeeContext | null {
  if (
    payload.queueType !== XERO_OUTBOX_ENTRANCE_FEE_TYPE ||
    !payload.category ||
    payload.feeAmountCents === null ||
    payload.feeAmountCents === undefined
  ) {
    return null;
  }

  const entranceFeeContext: EntranceFeeContext = {
    category: payload.category,
    feeMapping: {
      itemCode: payload.itemCode ?? null,
      amountCents: payload.feeAmountCents,
    },
  };
  if (payload.description) {
    entranceFeeContext.description = payload.description;
  }

  return entranceFeeContext;
}

export async function enqueueXeroEntranceFeeInvoiceOperation(
  memberId: string,
  options?: {
    createdByMemberId?: string;
    amountCents?: number | null;
    description?: string | null;
  }
) {
  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "Member",
      localId: memberId,
      xeroObjectType: "INVOICE",
      role: "ENTRANCE_FEE_INVOICE",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero entrance fee invoice already linked for this member.",
    };
  }

  const entranceFee = await getEntranceFeeContext(memberId);

  // Organisations/schools are exempt from entrance fees (owner decision,
  // 2026-07-07) — checked before the amount override so an explicitly
  // entered amount can never bill an organisation.
  if (entranceFee.exempt) {
    return {
      queueOperationId: null,
      message: ENTRANCE_FEE_EXEMPT_MESSAGE,
    };
  }

  const feeAmountCents =
    options?.amountCents ?? entranceFee.feeMapping.amountCents;
  const description = options?.description?.trim() || null;

  if (!feeAmountCents || feeAmountCents <= 0) {
    return {
      queueOperationId: null,
      message: "No entrance fee is configured for this member category.",
    };
  }

  const correlationKey = buildEntranceFeeInvoiceIdempotencyKey(
    memberId,
    entranceFee.category,
    feeAmountCents
  );

  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Member",
      localId: memberId,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero entrance fee invoice is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel: "Member",
    localId: memberId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_ENTRANCE_FEE_TYPE,
      category: entranceFee.category,
      itemCode: entranceFee.feeMapping.itemCode,
      feeAmountCents,
      ...(description ? { description } : {}),
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero entrance fee invoice queued for background processing.",
  };
}

export async function enqueueXeroBookingInvoiceOperation(
  bookingId: string,
  options?: { createdByMemberId?: string }
) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      payment: {
        select: {
          id: true,
          xeroInvoiceId: true,
        },
      },
    },
  });

  if (!booking) {
    throw new Error(`Booking not found: ${bookingId}`);
  }

  if (!booking.payment) {
    throw new Error(`No payment record for booking: ${bookingId}`);
  }

  if (booking.payment.xeroInvoiceId) {
    return {
      queueOperationId: null,
      message: "Xero booking invoice already linked for this booking.",
    };
  }

  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "Payment",
      localId: booking.payment.id,
      xeroObjectType: "INVOICE",
      role: "PRIMARY_INVOICE",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero booking invoice already linked for this booking.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "booking",
    bookingId,
    "invoice",
    "v1"
  );

  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: booking.payment.id,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero booking invoice is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: booking.payment.id,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_BOOKING_INVOICE_TYPE,
      bookingId,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero booking invoice queued for background processing.",
  };
}

/**
 * #1620 — enqueue the applied-credit allocation orchestration op for a booking.
 * Skips when the booking carries no unallocated applied credit. The handler runs
 * after the invoice op and reduces the invoice to the effective amount by
 * allocating the member's existing floating credit notes.
 *
 * Payment-method-agnostic (#1641): keyed on the booking's payment + BOOKING_APPLIED
 * ledger, never on payment.source. In #1620 the only call sites are Internet
 * Banking (create-time IB + switch-to-IB); #1641 adds a card caller.
 */
export async function enqueueXeroAppliedCreditAllocationOperation(
  bookingId: string,
  options?: { createdByMemberId?: string }
) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      payment: { select: { id: true } },
    },
  });

  if (!booking?.payment) {
    return {
      queueOperationId: null,
      message: "No payment record for booking; nothing to allocate.",
    };
  }

  // Unallocated applied credit = BOOKING_APPLIED rows not yet stamped with an
  // allocated Xero note (the ledger-truth predicate the handler also uses).
  const appliedAgg = await prisma.memberCredit.aggregate({
    where: {
      appliedToBookingId: bookingId,
      type: "BOOKING_APPLIED",
      xeroCreditNoteId: null,
    },
    _sum: { amountCents: true },
  });
  const appliedCents = Math.max(0, -(appliedAgg._sum.amountCents ?? 0));
  if (appliedCents === 0) {
    return {
      queueOperationId: null,
      message: "No unallocated applied credit; nothing to allocate.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "booking",
    bookingId,
    "applied-credit-allocation",
    "v1"
  );

  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "ALLOCATION",
      operationType: "ALLOCATE",
      localModel: "Payment",
      localId: booking.payment.id,
      status: { in: ["PENDING", "RUNNING"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Applied-credit allocation is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "ALLOCATION",
    operationType: "ALLOCATE",
    localModel: "Payment",
    localId: booking.payment.id,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE,
      bookingId,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Applied-credit allocation queued for background processing.",
  };
}

export async function enqueueXeroGroupSettlementInvoiceOperation(
  settlementId: string,
  options?: { createdByMemberId?: string }
) {
  const settlement = await prisma.groupBookingSettlement.findUnique({
    where: { id: settlementId },
    select: {
      id: true,
      xeroInvoiceId: true,
    },
  });

  if (!settlement) {
    throw new Error(`Group settlement not found: ${settlementId}`);
  }

  if (settlement.xeroInvoiceId) {
    return {
      queueOperationId: null,
      message: "Xero settlement invoice already linked for this group.",
    };
  }

  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "GroupBookingSettlement",
      localId: settlement.id,
      xeroObjectType: "INVOICE",
      role: "GROUP_SETTLEMENT_INVOICE",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero settlement invoice already linked for this group.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "group-settlement",
    settlementId,
    "invoice",
    "v1"
  );

  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "GroupBookingSettlement",
      localId: settlement.id,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero settlement invoice is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel: "GroupBookingSettlement",
    localId: settlement.id,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_TYPE,
      settlementId,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero settlement invoice queued for background processing.",
  };
}

export async function enqueueXeroBookingInvoiceUpdateOperation(
  bookingId: string,
  options?: { createdByMemberId?: string }
) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      checkIn: true,
      checkOut: true,
      payment: {
        select: {
          id: true,
          xeroInvoiceId: true,
        },
      },
    },
  });

  if (!booking) {
    throw new Error(`Booking not found: ${bookingId}`);
  }

  if (!booking.payment) {
    throw new Error(`No payment record for booking: ${bookingId}`);
  }

  if (!booking.payment.xeroInvoiceId) {
    return {
      queueOperationId: null,
      message: "No original Xero invoice exists for this booking.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "booking",
    bookingId,
    "invoice-update",
    booking.payment.xeroInvoiceId,
    booking.checkIn.toISOString().slice(0, 10),
    booking.checkOut.toISOString().slice(0, 10),
    "v1"
  );

  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "UPDATE",
      localModel: "Payment",
      localId: booking.payment.id,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero booking invoice update is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "UPDATE",
    localModel: "Payment",
    localId: booking.payment.id,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE,
      bookingId,
      xeroInvoiceId: booking.payment.xeroInvoiceId,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero booking invoice update queued for background processing.",
  };
}

export async function enqueueXeroRefundCreditNoteOperation(
  paymentId: string,
  refundAmountCents: number,
  options?: { createdByMemberId?: string; store?: Prisma.TransactionClient }
) {
  // Optional transaction client (#1357) so callers (e.g. the Internet Banking
  // hold-expiry cron) can enqueue the outbox row inside the same transaction
  // that releases the hold — the invoice-clearing intent then commits
  // atomically with the release instead of riding a post-commit crash window.
  // Every internal read/write goes through the same client so the #1354
  // correlation-key dedupe sees a consistent (uncommitted) state. Defaults to
  // the global `prisma`, keeping existing callers unchanged.
  const db = options?.store ?? prisma;

  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
      source: true,
      refundedAmountCents: true,
      xeroRefundCreditNoteId: true,
    },
  });

  if (!payment) {
    throw new Error(`Payment not found: ${paymentId}`);
  }

  if (refundAmountCents <= 0) {
    return {
      queueOperationId: null,
      message: "No additional Xero refund credit note is required for this payment.",
    };
  }

  const canonicalLink = await findCanonicalPaymentRefundCreditNote(paymentId, db);
  let noteAmountCents = refundAmountCents;
  let watermarkCents = refundAmountCents;

  if (payment.source === PaymentSource.STRIPE) {
    // Stripe payments can be refunded in several steps, and each step needs its
    // own credit note for the still-uncovered delta. `payment.refundedAmountCents`
    // is the cumulative refund ledger and already includes this delta at enqueue
    // time, so capping the note to `refundedAmountCents - coveredCents` yields
    // this delta while replays of an already-covered state cap at zero.
    const coveredCents = await sumCoveredRefundCreditNoteCents(paymentId, db);
    noteAmountCents = Math.max(
      0,
      Math.min(refundAmountCents, payment.refundedAmountCents - coveredCents)
    );
    watermarkCents = coveredCents + noteAmountCents;
    if (noteAmountCents <= 0) {
      return {
        queueOperationId: null,
        message: "Refund credit notes already cover this payment's refunded amount.",
      };
    }
  } else if (canonicalLink) {
    // Non-Stripe callers (internet-banking cron, group-cancel) issue at most one
    // refund per payment and re-enqueue on cron reruns; the single-note skip
    // absorbs those replays by repointing at the existing note.
    if (payment.xeroRefundCreditNoteId !== canonicalLink.xeroObjectId) {
      await db.payment.update({
        where: { id: paymentId },
        data: {
          xeroRefundCreditNoteId: canonicalLink.xeroObjectId,
        },
      });
    }
    await upsertXeroObjectLink(
      {
        localModel: "Payment",
        localId: paymentId,
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: canonicalLink.xeroObjectId,
        xeroObjectNumber: canonicalLink.xeroObjectNumber,
        role: "REFUND_CREDIT_NOTE",
      },
      options?.store ? { store: options.store } : undefined
    );

    return {
      queueOperationId: null,
      message: "Xero refund credit note already linked for this payment.",
    };
  }

  // The cumulative watermark distinguishes equal-amount Stripe deltas so each one
  // gets its own note, while replays of the same state produce the same key and
  // collide into the PENDING/RUNNING dedupe just below.
  const correlationKey = buildXeroIdempotencyKey(
    "payment",
    paymentId,
    "refund-credit-note",
    payment.source === PaymentSource.STRIPE ? watermarkCents : noteAmountCents,
    payment.source === PaymentSource.STRIPE ? "v2" : "v1"
  );

  const existingQueuedOperation = await db.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero refund credit note is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: paymentId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE,
      refundAmountCents: noteAmountCents,
      watermarkCents,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
    store: db,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero refund credit note queued for background processing.",
  };
}

export async function enqueueXeroAccountCreditNoteOperation(
  paymentId: string,
  refundAmountCents: number,
  options?: { createdByMemberId?: string; store?: Prisma.TransactionClient }
) {
  if (refundAmountCents <= 0) {
    return {
      queueOperationId: null,
      message: "No account-credit note is required for this refund.",
    };
  }

  // Optional transaction client so callers (e.g. the late Internet Banking
  // capacity-fail reconcile) can enqueue the outbox row inside the same
  // transaction that creates the offsetting local credit; defaults to the
  // global `prisma` so existing callers are unaffected.
  const db = options?.store ?? prisma;

  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
    },
  });

  if (!payment) {
    throw new Error(`Payment not found: ${paymentId}`);
  }

  const existingLink = await db.xeroObjectLink.findFirst({
    where: {
      localModel: "Payment",
      localId: paymentId,
      xeroObjectType: "CREDIT_NOTE",
      role: "ACCOUNT_CREDIT_NOTE",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero account-credit note already linked for this payment.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "payment",
    paymentId,
    "unapplied-credit-note",
    refundAmountCents,
    "v1"
  );

  const existingQueuedOperation = await db.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero account-credit note is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: paymentId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE,
      refundAmountCents,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
    store: db,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero account-credit note queued for background processing.",
  };
}

export async function enqueueXeroSupplementaryInvoiceOperation(
  params: {
    bookingId: string;
    priceDiffCents: number;
    changeFeeCents: number;
    bookingModificationId?: string;
  },
  options?: {
    createdByMemberId?: string;
    paymentIntentId?: string | null;
    waitForConfirmedAdditionalPayment?: boolean;
    recordPayment?: boolean;
  }
) {
  const {
    bookingId,
    priceDiffCents,
    changeFeeCents,
    bookingModificationId,
  } = params;

  // Net-based guard (#1356): the components are signed, and a supplementary
  // invoice exists only to bill a positive net. A mixed-sign edit whose net is
  // not positive settles via the credit-note paths; queueing it here would
  // gross-bill the fee while dropping the larger reduction.
  if (priceDiffCents + changeFeeCents <= 0) {
    return {
      queueOperationId: null,
      message: "No supplementary invoice is required for this modification.",
    };
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      payment: {
        select: {
          xeroInvoiceId: true,
        },
      },
    },
  });

  if (!booking) {
    throw new Error(`Booking not found: ${bookingId}`);
  }

  if (!booking.payment?.xeroInvoiceId) {
    return {
      queueOperationId: null,
      message: "No original Xero invoice exists for this booking.",
    };
  }

  const localModel = bookingModificationId ? "BookingModification" : "Booking";
  const localId = bookingModificationId ?? bookingId;

  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel,
      localId,
      xeroObjectType: "INVOICE",
      role: "SUPPLEMENTARY_INVOICE",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero supplementary invoice already linked for this modification.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    bookingModificationId ? "booking-mod" : "booking",
    localId,
    "supplementary-invoice",
    priceDiffCents,
    changeFeeCents,
    "v1"
  );

  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel,
      localId,
      status: {
        in: ["PENDING", "RUNNING", "WAITING_PAYMENT"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero supplementary invoice is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel,
    localId,
    status: options?.waitForConfirmedAdditionalPayment ? "WAITING_PAYMENT" : "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
      bookingId,
      priceDiffCents,
      changeFeeCents,
      bookingModificationId: bookingModificationId ?? null,
      recordPayment: options?.recordPayment ?? true,
      paymentIntentId: options?.paymentIntentId ?? null,
      waitForConfirmedAdditionalPayment:
        options?.waitForConfirmedAdditionalPayment ?? false,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: options?.waitForConfirmedAdditionalPayment
      ? "Xero supplementary invoice is waiting for confirmed additional payment."
      : "Xero supplementary invoice queued for background processing.",
  };
}

/**
 * Whether any supplementary-invoice outbox operation tied to this
 * PaymentIntent has left WAITING_PAYMENT (was released, is running, already
 * SUCCEEDED, or FAILED-but-replayable) — i.e. a Xero invoice for the
 * additional amount exists or may still be created (#1350). Used by the
 * cancelled-booking late-capture webhook path to decide whether a corrective
 * refund credit note is needed; a still-WAITING_PAYMENT (or CANCELLED)
 * operation produces no invoice, so crediting it would over-credit the books.
 */
export async function hasReleasedXeroSupplementaryInvoiceOperationsForPaymentIntent(
  paymentIntentId: string
): Promise<boolean> {
  const releasedCount = await prisma.xeroSyncOperation.count({
    where: {
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      status: { notIn: ["WAITING_PAYMENT", "CANCELLED"] },
      requestPayload: {
        path: ["paymentIntentId"],
        equals: paymentIntentId,
      },
    },
  });
  return releasedCount > 0;
}

export async function releaseXeroSupplementaryInvoiceOperationsForPaymentIntent(
  paymentIntentId: string
) {
  const waitingOperations = await prisma.xeroSyncOperation.findMany({
    where: {
      status: "WAITING_PAYMENT",
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      requestPayload: {
        path: ["paymentIntentId"],
        equals: paymentIntentId,
      },
    },
    select: { id: true },
  });

  if (waitingOperations.length === 0) {
    return {
      released: 0,
      queueOperationIds: [] as string[],
    };
  }

  const queueOperationIds = waitingOperations.map((operation) => operation.id);
  const updateResult = await prisma.xeroSyncOperation.updateMany({
    where: {
      id: {
        in: queueOperationIds,
      },
      status: "WAITING_PAYMENT",
    },
    data: {
      status: "PENDING",
      startedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });

  return {
    released: updateResult.count,
    queueOperationIds,
  };
}

/**
 * Point a modification's WAITING_PAYMENT supplementary-invoice operations at
 * a recovered additional PaymentIntent (#1096). The operation was enqueued
 * while intent creation was failing, so its payload carries a null
 * paymentIntentId that the payment-succeeded release could never match.
 */
export async function attachPaymentIntentToWaitingSupplementaryInvoiceOperations({
  bookingModificationId,
  paymentIntentId,
}: {
  bookingModificationId: string;
  paymentIntentId: string;
}): Promise<{ attached: number }> {
  const waitingOperations = await prisma.xeroSyncOperation.findMany({
    where: {
      status: "WAITING_PAYMENT",
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      requestPayload: {
        path: ["bookingModificationId"],
        equals: bookingModificationId,
      },
    },
    select: { id: true, requestPayload: true },
  });

  let attached = 0;
  for (const operation of waitingOperations) {
    const payload =
      operation.requestPayload &&
      typeof operation.requestPayload === "object" &&
      !Array.isArray(operation.requestPayload)
        ? (operation.requestPayload as Record<string, unknown>)
        : null;
    if (!payload || payload.paymentIntentId) {
      continue;
    }
    await prisma.xeroSyncOperation.update({
      where: { id: operation.id },
      data: {
        requestPayload: {
          ...payload,
          paymentIntentId,
        } as Prisma.InputJsonValue,
      },
    });
    attached += 1;
  }

  return { attached };
}

const STALE_WAITING_PAYMENT_AGE_DAYS = 14;

export async function reapStaleWaitingPaymentXeroOutboxOperations(options?: {
  /** Override the staleness threshold in days. Defaults to 14. */
  ageInDays?: number;
}): Promise<{ reaped: number; queueOperationIds: string[] }> {
  const ageInDays =
    options?.ageInDays ?? STALE_WAITING_PAYMENT_AGE_DAYS;
  const ageThreshold = new Date(
    Date.now() - ageInDays * 24 * 60 * 60 * 1000,
  );

  const waitingOperations = await prisma.xeroSyncOperation.findMany({
    where: {
      status: "WAITING_PAYMENT",
      direction: "OUTBOUND",
    },
    select: {
      id: true,
      createdAt: true,
      requestPayload: true,
    },
  });

  if (waitingOperations.length === 0) {
    return { reaped: 0, queueOperationIds: [] };
  }

  const reapableIds: string[] = [];
  for (const operation of waitingOperations) {
    if (operation.createdAt <= ageThreshold) {
      reapableIds.push(operation.id);
      continue;
    }

    const payload = operation.requestPayload as
      | { paymentIntentId?: string | null }
      | null;
    const paymentIntentId = payload?.paymentIntentId ?? null;
    if (!paymentIntentId) continue;

    const failedTransaction = await prisma.paymentTransaction.findFirst({
      where: {
        source: "STRIPE",
        stripePaymentIntentId: paymentIntentId,
        status: "FAILED",
      },
      select: { id: true },
    });
    if (failedTransaction) {
      reapableIds.push(operation.id);
    }
  }

  if (reapableIds.length === 0) {
    return { reaped: 0, queueOperationIds: [] };
  }

  const updateResult = await prisma.xeroSyncOperation.updateMany({
    where: {
      id: { in: reapableIds },
      status: "WAITING_PAYMENT",
    },
    data: {
      status: "CANCELLED",
      completedAt: new Date(),
      lastErrorCode: "STALE_WAITING_PAYMENT",
      lastErrorMessage:
        "Reaped: linked Stripe payment failed or did not confirm in time.",
    },
  });

  if (updateResult.count > 0) {
    logger.info(
      { reaped: updateResult.count, ageInDays },
      "Reaped stale WAITING_PAYMENT Xero outbox operations",
    );
  }

  return {
    reaped: updateResult.count,
    queueOperationIds: reapableIds,
  };
}

export async function recordSkippedXeroBookingInvoiceUpdateOperation(params: {
  bookingId: string;
  bookingModificationId: string;
  reason: string;
  createdByMemberId?: string;
}) {
  const booking = await prisma.booking.findUnique({
    where: { id: params.bookingId },
    select: {
      payment: {
        select: {
          id: true,
          xeroInvoiceId: true,
          xeroInvoiceNumber: true,
        },
      },
    },
  });

  const correlationKey = buildXeroIdempotencyKey(
    "booking-mod",
    params.bookingModificationId,
    "primary-invoice-update",
    "skipped",
    "v1"
  );
  const existingOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "UPDATE",
      localModel: "BookingModification",
      localId: params.bookingModificationId,
    },
    orderBy: {
      createdAt: "desc",
    },
    select: { id: true },
  });

  if (existingOperation) {
    return {
      queueOperationId: existingOperation.id,
      message: "Skipped Xero primary invoice update already recorded for this modification.",
    };
  }

  const operation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "UPDATE",
    localModel: "BookingModification",
    localId: params.bookingModificationId,
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE,
      bookingId: params.bookingId,
      xeroInvoiceId: booking?.payment?.xeroInvoiceId ?? null,
      skippedByPolicy: true,
      reason: params.reason,
    },
    createdByMemberId: params.createdByMemberId ?? null,
  });

  await completeXeroSyncOperation(operation.id, {
    responsePayload: {
      skipped: true,
      reason: params.reason,
      bookingId: params.bookingId,
      bookingModificationId: params.bookingModificationId,
      paymentId: booking?.payment?.id ?? null,
    },
    xeroObjectType: booking?.payment?.xeroInvoiceId ? "INVOICE" : null,
    xeroObjectId: booking?.payment?.xeroInvoiceId ?? null,
    xeroObjectNumber: booking?.payment?.xeroInvoiceNumber ?? null,
  });

  return {
    queueOperationId: operation.id,
    message: "Skipped Xero primary invoice update recorded for this modification.",
  };
}

export async function enqueueXeroModificationCreditNoteOperation(
  params: {
    bookingId: string;
    refundAmountCents: number;
    bookingModificationId?: string;
  },
  options?: { createdByMemberId?: string }
) {
  const {
    bookingId,
    refundAmountCents,
    bookingModificationId,
  } = params;

  if (refundAmountCents <= 0) {
    return {
      queueOperationId: null,
      message: "No modification credit note is required for this change.",
    };
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      payment: {
        select: {
          xeroInvoiceId: true,
        },
      },
    },
  });

  if (!booking) {
    throw new Error(`Booking not found: ${bookingId}`);
  }

  if (!booking.payment?.xeroInvoiceId) {
    return {
      queueOperationId: null,
      message: "No original Xero invoice exists for this booking.",
    };
  }

  const localModel = bookingModificationId ? "BookingModification" : "Booking";
  const localId = bookingModificationId ?? bookingId;

  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel,
      localId,
      xeroObjectType: "CREDIT_NOTE",
      role: "MODIFICATION_CREDIT_NOTE",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero modification credit note already linked for this change.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    bookingModificationId ? "booking-mod" : "booking",
    localId,
    "mod-credit-note",
    refundAmountCents,
    "v1"
  );

  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel,
      localId,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero modification credit note is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel,
    localId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
      bookingId,
      refundAmountCents,
      bookingModificationId: bookingModificationId ?? null,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero modification credit note queued for background processing.",
  };
}

export async function enqueueXeroModificationAccountCreditNoteOperation(
  params: {
    bookingId: string;
    refundAmountCents: number;
    bookingModificationId: string;
  },
  options?: { createdByMemberId?: string }
) {
  const {
    bookingId,
    refundAmountCents,
    bookingModificationId,
  } = params;

  if (refundAmountCents <= 0) {
    return {
      queueOperationId: null,
      message: "No modification account-credit note is required for this change.",
    };
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      payment: {
        select: {
          id: true,
        },
      },
    },
  });

  if (!booking) {
    throw new Error(`Booking not found: ${bookingId}`);
  }

  if (!booking.payment?.id) {
    return {
      queueOperationId: null,
      message: "No original payment exists for this booking.",
    };
  }

  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "BookingModification",
      localId: bookingModificationId,
      xeroObjectType: "CREDIT_NOTE",
      role: "MODIFICATION_ACCOUNT_CREDIT_NOTE",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero modification account-credit note already linked for this change.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "booking-mod",
    bookingModificationId,
    "mod-account-credit-note",
    refundAmountCents,
    "v1"
  );

  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "BookingModification",
      localId: bookingModificationId,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero modification account-credit note is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel: "BookingModification",
    localId: bookingModificationId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE,
      bookingId,
      paymentId: booking.payment.id,
      refundAmountCents,
      bookingModificationId,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero modification account-credit note queued for background processing.",
  };
}

export async function enqueueXeroCreditNoteAllocationOperation(
  params: {
    localModel: "Payment" | "Booking" | "BookingModification";
    localId: string;
    creditNoteId: string;
    invoiceId: string;
    amountCents: number;
    role?: string;
  },
  options?: { createdByMemberId?: string }
) {
  const {
    localModel,
    localId,
    creditNoteId,
    invoiceId,
    amountCents,
    role,
  } = params;

  if (amountCents <= 0) {
    return {
      queueOperationId: null,
      message: "No Xero credit-note allocation is required for this repair.",
    };
  }

  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel,
      localId,
      xeroObjectType: "ALLOCATION",
      role: role ?? "CREDIT_NOTE_ALLOCATION",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero credit-note allocation already linked for this record.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "credit-note",
    creditNoteId,
    "invoice",
    invoiceId,
    "allocation",
    amountCents,
    role ?? "CREDIT_NOTE_ALLOCATION",
    "v1"
  );

  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "ALLOCATION",
      operationType: "ALLOCATE",
      localModel,
      localId,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero credit-note allocation is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "ALLOCATION",
    operationType: "ALLOCATE",
    localModel,
    localId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE,
      creditNoteId,
      invoiceId,
      amountCents,
      role: role ?? null,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero credit-note allocation queued for background processing.",
  };
}

// test seam
export async function enqueueXeroMembershipCancellationCreditNoteOperation(
  params: {
    subscriptionId: string;
    requestId: string;
    participantId: string;
  },
  options?: { createdByMemberId?: string }
) {
  const subscription = await prisma.memberSubscription.findUnique({
    where: { id: params.subscriptionId },
    select: {
      id: true,
      status: true,
      xeroInvoiceId: true,
    },
  });

  if (!subscription) {
    return {
      queueOperationId: null,
      message: "Membership subscription was not found for cancellation Xero crediting.",
    };
  }

  if (
    subscription.status !== "UNPAID" &&
    subscription.status !== "OVERDUE"
  ) {
    return {
      queueOperationId: null,
      message: "No Xero membership cancellation credit note is required for this subscription status.",
    };
  }

  if (!subscription.xeroInvoiceId) {
    return {
      queueOperationId: null,
      message: "No Xero subscription invoice is linked for cancellation crediting.",
    };
  }

  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "MemberSubscription",
      localId: params.subscriptionId,
      xeroObjectType: "CREDIT_NOTE",
      role: "MEMBERSHIP_CANCELLATION_CREDIT_NOTE",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero membership cancellation credit note already linked.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "member-subscription",
    params.subscriptionId,
    "membership-cancellation-credit",
    params.participantId,
    "v1"
  );
  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "MemberSubscription",
      localId: params.subscriptionId,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero membership cancellation credit note is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel: "MemberSubscription",
    localId: params.subscriptionId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE,
      subscriptionId: params.subscriptionId,
      requestId: params.requestId,
      participantId: params.participantId,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero membership cancellation credit note queued for background processing.",
  };
}

// test seam
export async function enqueueXeroMembershipCancellationContactOperation(
  params: {
    memberId: string;
    requestId: string;
    participantId: string;
  },
  options?: { createdByMemberId?: string }
) {
  const member = await prisma.member.findUnique({
    where: { id: params.memberId },
    select: { id: true, xeroContactId: true },
  });

  if (!member?.xeroContactId) {
    return {
      queueOperationId: null,
      message: "No Xero contact is linked for membership cancellation contact cleanup.",
    };
  }

  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "MembershipCancellationRequestParticipant",
      localId: params.participantId,
      xeroObjectType: "CONTACT",
      role: "MEMBERSHIP_CANCELLATION_CONTACT",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero membership cancellation contact cleanup already linked.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "membership-cancellation",
    params.participantId,
    "contact",
    params.memberId,
    "v1"
  );
  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "CONTACT",
      operationType: "UPDATE",
      localModel: "MembershipCancellationRequestParticipant",
      localId: params.participantId,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero membership cancellation contact cleanup is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "CONTACT",
    operationType: "UPDATE",
    localModel: "MembershipCancellationRequestParticipant",
    localId: params.participantId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CONTACT_TYPE,
      memberId: params.memberId,
      requestId: params.requestId,
      participantId: params.participantId,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero membership cancellation contact cleanup queued for background processing.",
  };
}

export async function queueApprovedMembershipCancellationXeroOperations(params: {
  memberId: string;
  requestId: string;
  participantId: string;
  createdByMemberId?: string;
}) {
  const seasonYear = getSeasonYear(new Date());
  const subscription = await prisma.memberSubscription.findUnique({
    where: {
      memberId_seasonYear: {
        memberId: params.memberId,
        seasonYear,
      },
    },
    select: { id: true },
  });
  const queuedResults: Array<{ queueOperationId: string | null; message: string }> = [];

  // Enqueue the credit note BEFORE the contact cleanup. The outbox processes
  // operations oldest-first (orderBy createdAt asc), so this ensures the credit
  // note is pushed to Xero before the contact is archived. Archiving first
  // would block the credit note, because Xero rejects credit notes raised
  // against an archived contact. The contact operation also re-checks this at
  // run time and defers if the credit note has not settled yet.
  if (subscription) {
    queuedResults.push(
      await enqueueXeroMembershipCancellationCreditNoteOperation(
        {
          subscriptionId: subscription.id,
          requestId: params.requestId,
          participantId: params.participantId,
        },
        { createdByMemberId: params.createdByMemberId }
      )
    );
  } else {
    queuedResults.push({
      queueOperationId: null,
      message: "No current-season membership subscription record exists for cancellation crediting.",
    });
  }

  queuedResults.push(
    await enqueueXeroMembershipCancellationContactOperation(
      {
        memberId: params.memberId,
        requestId: params.requestId,
        participantId: params.participantId,
      },
      { createdByMemberId: params.createdByMemberId }
    )
  );

  if (queuedResults.some((result) => result.queueOperationId)) {
    void kickQueuedXeroOutboxOperationsIfConnected({ limit: queuedResults.length }).catch(
      (error) => {
        logger.error(
          { err: error, memberId: params.memberId, requestId: params.requestId },
          "Failed to kick queued Xero membership cancellation operations"
        );
      }
    );
  }

  return {
    seasonYear,
    results: queuedResults,
  };
}

export interface ProcessQueuedXeroOutboxOperationsResult {
  found: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export async function kickQueuedXeroOutboxOperationsIfConnected(options?: {
  limit?: number;
}) {
  if (!(await isXeroConnected())) {
    return null;
  }

  return processQueuedXeroOutboxOperations(options);
}

export async function processQueuedXeroOutboxOperations(options?: {
  limit?: number;
}): Promise<ProcessQueuedXeroOutboxOperationsResult> {
  const limit = Math.min(Math.max(options?.limit ?? 10, 1), 50);
  const queuedOperations = await prisma.xeroSyncOperation.findMany({
    // Scan the indexed, denormalized `queueType` column (#1271, item 3 of
    // #1208) instead of a 12-branch `requestPayload->>'queueType'` OR predicate.
    // Behavior-identical for this scan: the column is written at enqueue in
    // `startXeroSyncOperation` from the same sanitized payload and never updated
    // afterward, and the only non-enqueue path into PENDING (the
    // WAITING_PAYMENT -> PENDING supplementary release) only flips status. So
    // for every PENDING row the column mirrors the enqueue-time
    // `payload.queueType` exactly (#1271's migration also backfilled existing
    // rows), and this selects the identical set the OR predicate did — now via
    // the `(queueType, status, createdAt)` index. Dispatch below still reads
    // `queueType` from the payload, so routing is unchanged.
    where: {
      status: "PENDING",
      direction: "OUTBOUND",
      queueType: {
        in: [...XERO_OUTBOX_QUEUE_TYPES],
      },
    },
    orderBy: {
      createdAt: "asc",
    },
    take: limit,
  });

  const result: ProcessQueuedXeroOutboxOperationsResult = {
    found: queuedOperations.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  for (const queuedOperation of queuedOperations) {
    const payload = readQueuedOutboxPayload(queuedOperation.requestPayload);
    const queueType = readQueueType(queuedOperation.requestPayload);
    const expectedOperation = getQueuedOutboxExpectedOperation(queueType);
    const claimed = await claimQueuedOutboxOperation(queuedOperation.id, expectedOperation);
    if (!claimed) {
      result.skipped += 1;
      continue;
    }

    result.processed += 1;

    const entranceFeeContext = payload
      ? buildPrecomputedEntranceFeeContext(payload)
      : null;

    try {
      if (
        payload?.queueType === XERO_OUTBOX_ENTRANCE_FEE_TYPE &&
        queuedOperation.localId &&
        entranceFeeContext
      ) {
        await createXeroEntranceFeeInvoice(queuedOperation.localId, {
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
          precomputedEntranceFee: entranceFeeContext,
        });
      } else if (payload?.queueType === XERO_OUTBOX_BOOKING_INVOICE_TYPE) {
        await createXeroInvoiceForBooking(payload.bookingId, {
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
        });
      } else if (payload?.queueType === XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE) {
        await updateXeroBookingInvoiceForBooking(payload.bookingId, {
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
        });
      } else if (
        payload?.queueType === XERO_OUTBOX_GROUP_SETTLEMENT_INVOICE_TYPE
      ) {
        await createXeroInvoiceForGroupSettlement(payload.settlementId, {
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
        });
      } else if (
        payload?.queueType === XERO_OUTBOX_SUBSCRIPTION_INVOICE_TYPE
      ) {
        await createXeroMembershipSubscriptionInvoice({
          chargeId: payload.chargeId,
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
        });
      } else if (
        payload?.queueType === XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE &&
        queuedOperation.localId
      ) {
        await createXeroCreditNote(
          queuedOperation.localId,
          payload.refundAmountCents,
          {
            createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
            syncOperationId: queuedOperation.id,
            watermarkCents: payload.watermarkCents,
          }
        );
      } else if (
        payload?.queueType === XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE &&
        queuedOperation.localId
      ) {
        await createUnappliedXeroCreditNote(
          queuedOperation.localId,
          payload.refundAmountCents,
          {
            createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
            syncOperationId: queuedOperation.id,
          }
        );
      } else if (
        payload?.queueType === XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE
      ) {
        await createUnappliedXeroCreditNoteForModification({
          paymentId: payload.paymentId,
          refundAmountCents: payload.refundAmountCents,
          bookingModificationId: payload.bookingModificationId,
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
        });
      } else if (payload?.queueType === XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE) {
        await createXeroSupplementaryInvoice({
          bookingId: payload.bookingId,
          priceDiffCents: payload.priceDiffCents,
          changeFeeCents: payload.changeFeeCents,
          bookingModificationId: payload.bookingModificationId,
          recordPayment: payload.recordPayment ?? true,
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
        });
      } else if (payload?.queueType === XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE) {
        await createXeroCreditNoteForModification({
          bookingId: payload.bookingId,
          refundAmountCents: payload.refundAmountCents,
          bookingModificationId: payload.bookingModificationId,
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
        });
      } else if (
        payload?.queueType === XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE
      ) {
        await createXeroMembershipCancellationCreditNote({
          subscriptionId: payload.subscriptionId,
          requestId: payload.requestId,
          participantId: payload.participantId,
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
        });
      } else if (
        payload?.queueType === XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CONTACT_TYPE
      ) {
        await syncXeroMembershipCancellationContact({
          memberId: payload.memberId,
          requestId: payload.requestId,
          participantId: payload.participantId,
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
        });
      } else if (
        payload?.queueType === XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE &&
        queuedOperation.localModel &&
        queuedOperation.localId
      ) {
        await allocateCreditNoteToInvoice(
          payload.creditNoteId,
          payload.invoiceId,
          payload.amountCents,
          {
            localModel: queuedOperation.localModel,
            localId: queuedOperation.localId,
            role: payload.role,
            createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
            syncOperationId: queuedOperation.id,
          }
        );
      } else if (
        payload?.queueType === XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE
      ) {
        await allocateAppliedCreditForBooking(payload.bookingId, {
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
        });
      } else {
        throw new Error("Queued Xero outbox payload is incomplete.");
      }

      result.succeeded += 1;
    } catch (error) {
      if (payload?.queueType === XERO_OUTBOX_SUBSCRIPTION_INVOICE_TYPE) {
        const currentCharge = await prisma.membershipSubscriptionCharge.findUnique({
          where: { id: payload.chargeId },
          select: { xeroInvoiceId: true },
        }).catch(() => null);
        await prisma.membershipSubscriptionCharge.update({
          where: { id: payload.chargeId },
          data: {
            status: currentCharge?.xeroInvoiceId ? "EMAIL_FAILED" : "QUEUED",
            lastErrorCode: currentCharge?.xeroInvoiceId ? "EMAIL_FAILED" : "XERO_FAILED",
            lastErrorMessage: error instanceof Error ? error.message : String(error),
          },
        }).catch((chargeError) => {
          logger.error({ err: chargeError, chargeId: payload.chargeId }, "Failed to expose subscription charge outbox error");
        });
      }
      // F4 (#1354): fail the operation for EVERY queue type, not just the two
      // membership-cancellation types and payload-shape errors. An operation
      // erroring BEFORE its handler overwrote requestPayload (token refresh,
      // contact resolution, account mapping) previously stayed RUNNING with
      // the queued payload; after an operator stale-reset the retry stack
      // could not parse that shape — a permanent manual dead-end. FAILED rows
      // are replayable, and the retry parser now understands the queued
      // payload shape, so failing fast here closes the dead-end for all
      // types.
      try {
        await failXeroSyncOperation(
          queuedOperation.id,
          error instanceof Error ? error : new Error(String(error))
        );
      } catch (failErr) {
        logger.error(
          { err: failErr, queueOperationId: queuedOperation.id },
          "Failed to mark queued Xero outbox operation FAILED after an error"
        );
      }
      logger.error(
        {
          err: error,
          queueOperationId: queuedOperation.id,
          localId: queuedOperation.localId,
          queueType: payload?.queueType ?? null,
        },
        "Failed queued Xero outbox operation"
      );
      result.failed += 1;
    }
  }

  return result;
}
