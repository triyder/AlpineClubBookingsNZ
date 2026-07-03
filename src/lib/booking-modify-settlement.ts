// Split out of src/lib/booking-modify.ts (issue #1138): settlement handoff
// (refund vs account credit), payment adjustments, and booking lifecycle
// transitions after a modification. Code moved verbatim; import via the
// "@/lib/booking-modify" barrel.

import {
  BookingStatus,
  PaymentSource,
  PaymentStatus,
  type Prisma,
} from "@prisma/client";

import { ApiError } from "@/lib/api-error";
import {
  calculateDualRefundAmounts,
  daysUntilDate,
  loadCancellationPolicy,
  getNonMemberHoldDays,
} from "@/lib/cancellation";
import {
  queueSupersededPrimaryIntentCancellations,
  type SupersededPrimaryPaymentIntent,
} from "@/lib/booking-payment-cleanup";
import {
  getRemainingRefundableCents,
  hasCapturedPayment,
} from "@/lib/booking-payment-state";
import {
  type BookingModificationSettlementMethod,
  type LoadedBookingForModify,
} from "@/lib/booking-modify-validation";
import { type GuestPlan } from "@/lib/booking-modify-plan";

export type BookingModificationSettlementOptions = {
  basisAmountCents: number;
  cardRefundAmountCents: number;
  cardRefundPercentage: number;
  accountCreditAmountCents: number;
  accountCreditPercentage: number;
  daysUntilCheckIn: number;
  requiresSettlementMethod: boolean;
};

export type PaymentAdjustmentResult = {
  refundAmountCents: number;
  accountCreditAmountCents: number;
  additionalAmountCents: number;
  pendingRefundAmountCents: number;
  hasSucceededPayment: boolean;
  hasIssuedXeroInvoice: boolean;
  xeroRefundAmountCents: number;
  xeroAdditionalAmountCents: number;
  settlementMethod: BookingModificationSettlementMethod | null;
  policyRetainedAmountCents: number;
};

const SETTLED_BOOKING_STATUSES = [
  "PAYMENT_PENDING",
  "CONFIRMED",
  "PAID",
  "COMPLETED",
] as const;

function isSettledBookingStatus(status: BookingStatus | string) {
  return (SETTLED_BOOKING_STATUSES as readonly string[]).includes(status);
}

export async function calculateModificationSettlementOptions({
  booking,
  netChargeCents,
}: {
  booking: Pick<LoadedBookingForModify, "checkIn" | "status" | "payment">;
  netChargeCents: number;
}): Promise<BookingModificationSettlementOptions | null> {
  const reductionAmountCents = Math.max(0, -netChargeCents);
  const remainingRefundableCents = getRemainingRefundableCents(booking.payment);
  const basisAmountCents = Math.min(
    reductionAmountCents,
    remainingRefundableCents,
  );
  const hasSettledPayment =
    isSettledBookingStatus(booking.status) && hasCapturedPayment(booking.payment);

  if (basisAmountCents <= 0 || !hasSettledPayment) {
    return null;
  }

  const policy = await loadCancellationPolicy(booking.checkIn);
  const daysUntilCheckIn = daysUntilDate(booking.checkIn);
  const {
    cardRefundAmountCents,
    cardRefundPercentage,
    creditRefundAmountCents,
    creditRefundPercentage,
  } = calculateDualRefundAmounts(basisAmountCents, daysUntilCheckIn, policy);

  return {
    basisAmountCents,
    cardRefundAmountCents,
    cardRefundPercentage,
    accountCreditAmountCents: creditRefundAmountCents,
    accountCreditPercentage: creditRefundPercentage,
    daysUntilCheckIn,
    requiresSettlementMethod:
      cardRefundAmountCents > 0 || creditRefundAmountCents > 0,
  };
}

function resolveSelectedSettlementAmount({
  settlementOptions,
  settlementMethod,
}: {
  settlementOptions: BookingModificationSettlementOptions | null | undefined;
  settlementMethod: BookingModificationSettlementMethod | undefined;
}) {
  if (!settlementOptions) {
    return {
      settlementMethod: null,
      amountCents: 0,
      policyRetainedAmountCents: 0,
    };
  }

  if (settlementOptions.requiresSettlementMethod && !settlementMethod) {
    throw new ApiError("Choose a refund or account credit before saving", 400);
  }

  if (!settlementOptions.requiresSettlementMethod) {
    return {
      settlementMethod: null,
      amountCents: 0,
      policyRetainedAmountCents: settlementOptions.basisAmountCents,
    };
  }

  const resolvedMethod = settlementMethod ?? "card";
  const amountCents =
    resolvedMethod === "credit"
      ? settlementOptions.accountCreditAmountCents
      : settlementOptions.cardRefundAmountCents;

  return {
    settlementMethod: resolvedMethod,
    amountCents,
    policyRetainedAmountCents: Math.max(
      0,
      settlementOptions.basisAmountCents - amountCents,
    ),
  };
}

export async function applyPaymentAdjustments(
  tx: Prisma.TransactionClient,
  {
    booking,
    priceDiffCents,
    changeFeeCents,
    settlementOptions,
    settlementMethod,
  }: {
    booking: LoadedBookingForModify;
    priceDiffCents: number;
    changeFeeCents: number;
    settlementOptions?: BookingModificationSettlementOptions | null;
    settlementMethod?: BookingModificationSettlementMethod;
  },
): Promise<PaymentAdjustmentResult> {
  const inSettledStatus = isSettledBookingStatus(booking.status);
  const hasSettledPayment =
    inSettledStatus && hasCapturedPayment(booking.payment);
  const hasSucceededPayment =
    hasSettledPayment && booking.payment?.source === PaymentSource.STRIPE;
  const hasIssuedXeroInvoice =
    inSettledStatus && !!booking.payment?.xeroInvoiceId;
  const remainingRefundableCents = getRemainingRefundableCents(booking.payment);

  const netAmountCents = priceDiffCents + changeFeeCents;
  const selectedSettlement = resolveSelectedSettlementAmount({
    settlementOptions,
    settlementMethod,
  });
  // On a reduction against an issued Xero invoice (#1015): when a payment has
  // been captured the credit note is policy-limited (selectedSettlement); when
  // the invoice is issued but unpaid (pay-on-account, no captured payment) no
  // policy tier applies — nothing was paid — so the invoice must be corrected
  // for the full net delta, otherwise a `settlementOptions` of null leaves
  // xeroRefund at 0 and the outstanding invoice keeps the removed guests.
  const xeroRefundAmountCents =
    hasIssuedXeroInvoice && netAmountCents < 0
      ? hasSettledPayment
        ? selectedSettlement.amountCents
        : Math.abs(netAmountCents)
      : 0;
  const xeroAdditionalAmountCents =
    hasIssuedXeroInvoice && netAmountCents > 0 ? netAmountCents : 0;

  let refundAmountCents = 0;
  let accountCreditAmountCents = 0;
  let additionalAmountCents = 0;
  let pendingRefundAmountCents = 0;

  if (hasSettledPayment && booking.payment) {
    if (settlementOptions && netAmountCents < 0) {
      if (selectedSettlement.settlementMethod === "credit") {
        accountCreditAmountCents = selectedSettlement.amountCents;
      } else {
        refundAmountCents = selectedSettlement.amountCents;
      }
      pendingRefundAmountCents = hasSucceededPayment ? refundAmountCents : 0;
    } else if (netAmountCents < 0) {
      refundAmountCents = Math.min(
        Math.abs(netAmountCents),
        remainingRefundableCents,
      );
      pendingRefundAmountCents = hasSucceededPayment ? refundAmountCents : 0;
    } else if (netAmountCents > 0) {
      additionalAmountCents = hasSucceededPayment
        ? netAmountCents
        : xeroAdditionalAmountCents;
    }

    if (changeFeeCents > 0) {
      await tx.payment.update({
        where: { id: booking.payment.id },
        data: { changeFeeCents: { increment: changeFeeCents } },
      });
    }
  } else if (xeroAdditionalAmountCents > 0) {
    additionalAmountCents = xeroAdditionalAmountCents;
  }

  return {
    refundAmountCents,
    accountCreditAmountCents,
    additionalAmountCents,
    pendingRefundAmountCents,
    hasSucceededPayment,
    hasIssuedXeroInvoice,
    xeroRefundAmountCents,
    xeroAdditionalAmountCents,
    settlementMethod: selectedSettlement.settlementMethod,
    policyRetainedAmountCents: selectedSettlement.policyRetainedAmountCents,
  };
}

export type LifecycleTransitionResult = {
  hasNonMembers: boolean;
  newNonMemberHoldUntil: Date | null;
  newStatus: BookingStatus;
  zeroDollarAutoPaid: boolean;
  supersededPrimaryPaymentIntents: SupersededPrimaryPaymentIntent[];
};

export async function applyLifecycleTransitions(
  tx: Prisma.TransactionClient,
  {
    booking,
    bookingId,
    newCheckIn,
    newFinalPriceCents,
    guestsForPricing,
    skipBookingLifecycleRules,
    reviewUpdate,
  }: {
    booking: LoadedBookingForModify;
    bookingId: string;
    newCheckIn: Date;
    newFinalPriceCents: number;
    guestsForPricing: Array<{ isMember: boolean }>;
    skipBookingLifecycleRules: boolean;
    reviewUpdate?: GuestPlan["reviewUpdate"];
  },
): Promise<LifecycleTransitionResult> {
  const hasNonMembers = !guestsForPricing.every((g) => g.isMember);
  let newNonMemberHoldUntil = booking.nonMemberHoldUntil;
  let newStatus = booking.status;
  let zeroDollarAutoPaid = false;
  let supersededPrimaryPaymentIntents: SupersededPrimaryPaymentIntent[] = [];

  // Parking moves a booking to AWAITING_REVIEW only from the pre-payment
  // statuses that state was built for: approval releases AWAITING_REVIEW to
  // PAYMENT_PENDING, which must never happen to captured money (#1100). A
  // paid/confirmed booking that trips a review rule is flagged (the caller
  // writes requiresAdminReview + adminReviewStatus PENDING, which drives the
  // admin queue) but keeps its status.
  const canParkForReview =
    newStatus === "PENDING" || newStatus === "PAYMENT_PENDING";
  if (reviewUpdate?.parkForReview && canParkForReview) {
    newStatus = "AWAITING_REVIEW";
  } else if (reviewUpdate?.releaseFromReview && newStatus === "AWAITING_REVIEW") {
    newStatus = "PAYMENT_PENDING";
  }

  if (!skipBookingLifecycleRules && hasNonMembers) {
    const holdDays = await getNonMemberHoldDays(newCheckIn);
    const daysUntilNewCheckIn = Math.ceil(
      (newCheckIn.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24),
    );

    if (daysUntilNewCheckIn <= holdDays) {
      newNonMemberHoldUntil = null;
      if (booking.status === "PENDING") {
        newStatus = "PAYMENT_PENDING";
      }
    } else {
      newNonMemberHoldUntil = new Date(
        newCheckIn.getTime() - holdDays * 24 * 60 * 60 * 1000,
      );
    }
  } else if (!skipBookingLifecycleRules) {
    newNonMemberHoldUntil = null;
  }

  if (
    !skipBookingLifecycleRules &&
    newFinalPriceCents === 0 &&
    newStatus === BookingStatus.PAYMENT_PENDING
  ) {
    newStatus = BookingStatus.PAID;
    zeroDollarAutoPaid = true;
    const zeroDollarPayment = await tx.payment.upsert({
      where: { bookingId },
      create: {
        bookingId,
        amountCents: 0,
        status: PaymentStatus.SUCCEEDED,
      },
      update: {
        amountCents: 0,
        status: PaymentStatus.SUCCEEDED,
        stripePaymentIntentId: null,
        stripePaymentMethodId: null,
        additionalPaymentIntentId: null,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
      },
    });
    supersededPrimaryPaymentIntents =
      await queueSupersededPrimaryIntentCancellations(tx, {
        bookingId,
        paymentId: zeroDollarPayment.id,
        newFinalPriceCents,
      });
  } else if (booking.payment) {
    // Nonzero price changes strand any pending primary intent at the old
    // amount (#1161): the payment page would hand back its stale
    // client_secret and Stripe would capture the old total. Supersede the
    // mismatched intents now; the pay-time paths mint a fresh one.
    supersededPrimaryPaymentIntents =
      await queueSupersededPrimaryIntentCancellations(tx, {
        bookingId,
        paymentId: booking.payment.id,
        newFinalPriceCents,
      });
  }

  return {
    hasNonMembers,
    newNonMemberHoldUntil,
    newStatus,
    zeroDollarAutoPaid,
    supersededPrimaryPaymentIntents,
  };
}
