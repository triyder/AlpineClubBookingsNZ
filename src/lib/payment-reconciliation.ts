import { prisma } from "@/lib/prisma";
import { BookingStatus, PaymentStatus, PaymentTransactionKind, Prisma } from "@prisma/client";
import {
  refundPaymentTransactions,
  upsertPaymentIntentTransaction,
} from "@/lib/payment-transactions";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { restoreCreditFromBooking } from "@/lib/member-credit";
import { sendAdminPaymentFailureAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";

type ReconciliationBooking = Prisma.BookingGetPayload<{
  include: {
    guests: true;
    member: true;
  };
}>;

export type MarkBookingPaymentSucceededResult = {
  outcome:
    | "paid"
    | "already_paid"
    | "cancelled_refunded"
    | "cancelled_refund_failed";
  bookingId: string;
  bumpedBookingIds: string[];
  refundError?: string;
};

const PAYABLE_SUCCESS_STATUSES = new Set<string>([
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PENDING,
  BookingStatus.DRAFT,
]);

async function alertRefundFailure({
  booking,
  paymentIntentId,
  amountCents,
  error,
}: {
  booking: ReconciliationBooking;
  paymentIntentId: string;
  amountCents: number;
  error: unknown;
}) {
  const errorMessage = error instanceof Error ? error.message : String(error);

  sendAdminPaymentFailureAlert({
    memberName: `${booking.member.firstName} ${booking.member.lastName}`,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    amountCents,
    errorMessage: `Payment succeeded but final capacity claim failed and automatic refund failed: ${errorMessage}`,
    paymentIntentId,
  }).catch((alertErr) =>
    logger.error(
      { err: alertErr, bookingId: booking.id, paymentIntentId },
      "Failed to alert admins about capacity refund failure"
    )
  );
}

export async function markBookingPaymentSucceeded({
  bookingId,
  paymentIntentId,
  amountCents,
  paymentMethodId,
}: {
  bookingId: string;
  paymentIntentId: string;
  amountCents: number;
  paymentMethodId: string | null;
}): Promise<MarkBookingPaymentSucceededResult> {
  const reconciliation = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      include: {
        guests: { include: { nights: true } }, // per-night sets (issue #713)
        member: true,
      },
    });

    if (!booking) {
      throw new Error("Booking not found");
    }

    const payment = await tx.payment.upsert({
      where: { bookingId },
      create: {
        bookingId,
        amountCents,
        status: PaymentStatus.PENDING,
      },
      update: {},
    });

    await upsertPaymentIntentTransaction({
      paymentId: payment.id,
      kind: PaymentTransactionKind.PRIMARY,
      paymentIntentId,
      amountCents,
      status: PaymentStatus.SUCCEEDED,
      paymentMethodId,
      store: tx,
    });

    if (booking.status === BookingStatus.PAID) {
      await reconcileBedAllocationsForBooking({
        bookingId: booking.id,
        db: tx,
        previousRange: {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        },
      });
      return {
        outcome: "already_paid" as const,
        booking,
        paymentId: payment.id,
        bumpedBookingIds: [] as string[],
      };
    }

    if (!PAYABLE_SUCCESS_STATUSES.has(booking.status)) {
      throw new Error(`Booking is not payable from status ${booking.status}`);
    }

    if (amountCents !== booking.finalPriceCents) {
      throw new Error("Payment amount does not match booking total");
    }

    const capacity = await checkCapacityForGuestRanges(
      booking.checkIn,
      booking.checkOut,
      booking.guests,
      booking.id,
      tx
    );

    // Since #737/#738 a PENDING booking holds no capacity, so there is no
    // synchronous bump that could free a real bed. An all-member booking that
    // does not fit against committed bookings is cancelled-and-refunded here,
    // never bumped into a full lodge (issue #738, carried over from R1). The
    // non-member portion of a mixed party is now its own provisional booking.
    if (!capacity.available) {
      await tx.booking.update({
        where: { id: booking.id },
        data: {
          status: BookingStatus.CANCELLED,
          draftExpiresAt: null,
        },
      });
      await reconcileBedAllocationsForBooking({
        bookingId: booking.id,
        db: tx,
        previousRange: {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        },
      });

      await restoreCreditFromBooking(booking.memberId, booking.id, tx);

      return {
        outcome: "capacity_failed" as const,
        booking,
        paymentId: payment.id,
        bumpedBookingIds: [] as string[],
      };
    }

    await tx.booking.update({
      where: { id: booking.id },
      data: {
        status: BookingStatus.PAID,
        draftExpiresAt: null,
      },
    });
    await reconcileBedAllocationsForBooking({
      bookingId: booking.id,
      db: tx,
      previousRange: {
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
      },
    });

    return {
      outcome: "paid" as const,
      booking,
      paymentId: payment.id,
      bumpedBookingIds: [] as string[],
    };
  });

  if (reconciliation.outcome === "capacity_failed") {
    try {
      await refundPaymentTransactions({
        paymentId: reconciliation.paymentId,
        amountCents,
        reason: "requested_by_customer",
        metadata: {
          bookingId,
          paymentIntentId,
          reason: "capacity_claim_failed",
        },
        idempotencyKeyPrefix: `capacity_claim_failed_${bookingId}_${paymentIntentId}`,
      });

      return {
        outcome: "cancelled_refunded",
        bookingId,
        bumpedBookingIds: [],
      };
    } catch (refundError) {
      logger.error(
        { err: refundError, bookingId, paymentIntentId },
        "Failed to auto-refund booking after final capacity claim failed"
      );
      await alertRefundFailure({
        booking: reconciliation.booking,
        paymentIntentId,
        amountCents,
        error: refundError,
      });

      return {
        outcome: "cancelled_refund_failed",
        bookingId,
        bumpedBookingIds: [],
        refundError:
          refundError instanceof Error ? refundError.message : String(refundError),
      };
    }
  }

  return {
    outcome: reconciliation.outcome,
    bookingId,
    bumpedBookingIds: reconciliation.bumpedBookingIds,
  };
}

export async function markBookingSetupIntentSucceeded({
  bookingId,
  setupIntentId,
  paymentMethodId,
}: {
  bookingId: string;
  setupIntentId: string;
  paymentMethodId: string;
}) {
  await prisma.payment.update({
    where: { bookingId },
    data: {
      stripePaymentMethodId: paymentMethodId,
      stripeSetupIntentId: setupIntentId,
    },
  });
}
