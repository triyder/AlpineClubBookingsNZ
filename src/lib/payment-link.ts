/**
 * Tokenised public payment links (issue #707).
 *
 * A PaymentLink lets a verified, approved booking requester pay for their
 * booking without an account. Only SHA-256 token hashes are stored; the raw
 * token is emailed once. Every resolution path refuses politely without
 * leaking whether a token, booking, or request exists.
 */
import { BookingStatus, PaymentStatus, PaymentTransactionKind, Prisma } from "@prisma/client";
import {
  hashActionToken,
  isActionTokenFormat,
  issueActionToken,
} from "@/lib/action-tokens";
import { buildInternetBankingPaymentReference } from "@/lib/booking-payment-methods";
import {
  resolveBookingNarrative,
  type BookingNarrative,
  type BookingNarrativeState,
  type NarrativeEvent,
} from "@/lib/booking-narrative";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { endOfDateOnlyForTimeZone, formatDateOnly } from "@/lib/date-only";
import { sendBookingRequestApprovedEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { markBookingPaymentSucceeded } from "@/lib/payment-reconciliation";
import { upsertPaymentIntentTransaction } from "@/lib/payment-transactions";
import { queueSupersededPrimaryIntentCancellations } from "@/lib/booking-payment-cleanup";
import { prisma } from "@/lib/prisma";
import {
  createPaymentIntent,
  findOrCreateCustomer,
  getPaymentIntent,
} from "@/lib/stripe";
import { queueXeroInvoiceForPaidBooking } from "@/lib/xero-booking-invoice-queue";

/** A paid booking and a completed stay are both "already paid" for link purposes. */
const PAID_LIKE_STATUSES: readonly BookingStatus[] = [
  BookingStatus.PAID,
  BookingStatus.COMPLETED,
];

function isPaidLikeStatus(status: BookingStatus): boolean {
  return PAID_LIKE_STATUSES.includes(status);
}

/** Booking statuses a payment link can still pay for. */
export const PAYMENT_LINK_PAYABLE_BOOKING_STATUSES = [
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
] as const;

export class PaymentLinkError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PaymentLinkError";
    this.status = status;
  }
}

const INVALID_LINK_MESSAGE = "This payment link is not valid.";
const EXPIRED_LINK_MESSAGE =
  "This payment link has expired. Please contact the club if you still wish to pay for your stay.";
const USED_LINK_MESSAGE = "This payment link has already been used.";
const REVOKED_LINK_MESSAGE =
  "This payment link is no longer active. Please contact the club for help.";
const NOT_PAYABLE_MESSAGE =
  "This booking can no longer be paid online. Please contact the club for help.";

type ResolvedPaymentLink = Prisma.PaymentLinkGetPayload<{
  include: {
    booking: {
      include: {
        member: true;
        guests: true;
        payment: true;
      };
    };
  };
}>;

/**
 * Structural lookup of a payment link by raw token. Throws only for a token
 * that cannot map to a live booking (bad format, unknown token, soft-deleted
 * booking). The link may be revoked/used/expired and the booking may be in any
 * state — callers decide what to do with it. Used by the narrative context
 * path, which renders a clear message for every link/booking state rather than
 * a generic error.
 */
async function loadPaymentLinkRecord(token: string): Promise<ResolvedPaymentLink> {
  const trimmed = token.trim();
  if (!isActionTokenFormat(trimmed)) {
    throw new PaymentLinkError(INVALID_LINK_MESSAGE, 404);
  }

  const link = await prisma.paymentLink.findUnique({
    where: { tokenHash: hashActionToken(trimmed) },
    include: {
      booking: {
        include: {
          member: true,
          guests: true,
          payment: true,
        },
      },
    },
  });

  if (!link || link.booking.deletedAt) {
    throw new PaymentLinkError(INVALID_LINK_MESSAGE, 404);
  }

  return link;
}

// test seam
/**
 * Look up and validate a payment link by raw token for the payment path
 * (intent creation). Throws PaymentLinkError with a polite message for every
 * failure mode. Returns the link with its booking when the link is still
 * usable (the booking may already be paid/completed — callers handle that
 * explicitly). A paid or completed booking is treated alike (issue #740).
 */
export async function resolvePaymentLink(token: string): Promise<ResolvedPaymentLink> {
  const link = await loadPaymentLinkRecord(token);

  if (link.revokedAt) {
    throw new PaymentLinkError(REVOKED_LINK_MESSAGE, 410);
  }
  if (link.usedAt && !isPaidLikeStatus(link.booking.status)) {
    throw new PaymentLinkError(USED_LINK_MESSAGE, 410);
  }
  if (link.expiresAt < new Date() && !isPaidLikeStatus(link.booking.status)) {
    throw new PaymentLinkError(EXPIRED_LINK_MESSAGE, 410);
  }

  return link;
}

/** The data the public page needs to actually take a payment. */
export interface PaymentLinkPayable {
  checkIn: string;
  checkOut: string;
  guestCount: number;
  status: BookingStatus;
  amountCents: number;
  /**
   * The bank-transfer reference, present only when the optional Internet
   * Banking module is on. Omitted when the module is off so the public pay
   * page never offers a payment method the club hasn't enabled.
   */
  internetBankingReference?: string;
  /** NZT end-of-check-in-day expiry, ISO. */
  expiresAt: string;
}

export interface PaymentLinkContext {
  state: BookingNarrativeState;
  /** Rich, plain-language wording shared with the admin booking history. */
  narrative: BookingNarrative;
  firstName: string;
  /** Present only when the booking can still be paid via this link. */
  payable: PaymentLinkPayable | null;
  /** True when the page should offer the "email me a fresh link" action. */
  canRequestFreshLink: boolean;
}

/**
 * Build the public payment page context for a raw token. Resolves the booking's
 * narrative from its durable events so guests see the same wording as admins,
 * for every state — payable, expired-but-payable, paid, bumped, cancelled,
 * declined — never a generic error. Marks the link used (idempotently) once the
 * booking is paid/completed so it cannot be replayed.
 */
export async function getPaymentLinkContext(token: string): Promise<PaymentLinkContext> {
  const link = await loadPaymentLinkRecord(token);
  const booking = link.booking;
  const now = new Date();

  const events = await prisma.bookingEvent.findMany({
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

  const narrative = resolveBookingNarrative({
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
    events: events.map(
      (event): NarrativeEvent => ({
        type: event.type,
        occurredAt: event.occurredAt,
        amountCents: event.amountCents,
        reason: event.reason,
        snapshot: event.snapshot,
      })
    ),
    link: {
      expiresAt: link.expiresAt,
      usedAt: link.usedAt,
      revokedAt: link.revokedAt,
    },
    now,
  });

  // A paid/completed booking burns the link so it cannot be replayed.
  if (isPaidLikeStatus(booking.status) && !link.usedAt) {
    await prisma.paymentLink
      .update({ where: { id: link.id }, data: { usedAt: now } })
      .catch((err) =>
        logger.error({ err, paymentLinkId: link.id }, "Failed to mark payment link used")
      );
  }

  // Internet Banking is an optional module; only surface the bank-transfer
  // reference on the public pay page when the club has it enabled.
  const ibModules =
    narrative.state === "payable" ? await loadEffectiveModuleFlags() : null;
  const internetBankingEnabled = Boolean(
    ibModules?.xeroIntegration && ibModules?.internetBankingPayments
  );

  const payable: PaymentLinkPayable | null =
    narrative.state === "payable"
      ? {
          checkIn: booking.checkIn.toISOString(),
          checkOut: booking.checkOut.toISOString(),
          guestCount: booking.guests.length,
          status: booking.status,
          amountCents: booking.finalPriceCents,
          ...(internetBankingEnabled
            ? {
                internetBankingReference: buildInternetBankingPaymentReference(
                  booking.id
                ),
              }
            : {}),
          expiresAt: link.expiresAt.toISOString(),
        }
      : null;

  return {
    state: narrative.state,
    narrative,
    firstName: booking.member.firstName,
    payable,
    canRequestFreshLink: narrative.state === "expired_payable",
  };
}

/**
 * Re-issue a payment link for an expired-but-payable booking and email the
 * requester a fresh one (the self-service "fresh link" action offered on the
 * expired-link page). Revokes any prior unused links for the booking. The new
 * link expires at the end of the check-in day in NZT.
 */
export async function reissuePaymentLinkForToken(
  token: string
): Promise<{ emailed: boolean }> {
  const link = await loadPaymentLinkRecord(token);
  const booking = link.booking;

  if (
    !(PAYMENT_LINK_PAYABLE_BOOKING_STATUSES as readonly BookingStatus[]).includes(
      booking.status
    )
  ) {
    throw new PaymentLinkError(NOT_PAYABLE_MESSAGE, 410);
  }

  const expiresAt = endOfDateOnlyForTimeZone(formatDateOnly(booking.checkIn));
  if (expiresAt.getTime() < Date.now()) {
    throw new PaymentLinkError(
      "These dates have already passed, so a new payment link can't be issued.",
      410
    );
  }

  const { token: freshToken, tokenHash } = issueActionToken();

  await prisma.$transaction(async (tx) => {
    await tx.paymentLink.updateMany({
      where: { bookingId: booking.id, revokedAt: null, usedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.paymentLink.create({
      data: {
        bookingId: booking.id,
        bookingRequestId: link.bookingRequestId,
        tokenHash,
        expiresAt,
      },
    });
  });

  await sendBookingRequestApprovedEmail({
    email: booking.member.email,
    firstName: booking.member.firstName,
    token: freshToken,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    guestCount: booking.guests.length,
    priceCents: booking.finalPriceCents,
    bookingReference: booking.id,
    expiresAt,
  });

  return { emailed: true };
}

export type PaymentLinkIntentResult =
  | { type: "alreadyPaid"; paymentIntentId: string }
  | { type: "clientSecret"; clientSecret: string; paymentIntentId: string };

/**
 * Token-authenticated Stripe payment intent creation. Runs the SAME
 * status and capacity revalidation as the session-gated
 * /api/payments/create-payment-intent path before any Stripe call:
 *   1. booking must still be payable (status check)
 *   2. existing PaymentIntents are reused/reconciled, not duplicated
 *   3. capacity is revalidated under the booking advisory lock
 * Final capacity claiming happens in markBookingPaymentSucceeded exactly
 * as it does for session payments and webhooks.
 */
export async function createPaymentIntentForPaymentLink(
  token: string
): Promise<PaymentLinkIntentResult> {
  const link = await resolvePaymentLink(token);
  const booking = link.booking;

  if (isPaidLikeStatus(booking.status)) {
    throw new PaymentLinkError(USED_LINK_MESSAGE, 410);
  }

  if (
    !(PAYMENT_LINK_PAYABLE_BOOKING_STATUSES as readonly BookingStatus[]).includes(
      booking.status
    )
  ) {
    throw new PaymentLinkError(NOT_PAYABLE_MESSAGE, 410);
  }

  // Reuse or reconcile an existing PaymentIntent before creating a new one
  // (same behaviour as the session payment-intent route).
  if (booking.payment?.stripePaymentIntentId) {
    const existingIntent = await getPaymentIntent(booking.payment.stripePaymentIntentId);

    if (existingIntent.status === "succeeded") {
      if (booking.payment.status !== PaymentStatus.SUCCEEDED) {
        const reconciliation = await markBookingPaymentSucceeded({
          bookingId: booking.id,
          paymentIntentId: existingIntent.id,
          amountCents: existingIntent.amount,
          paymentMethodId:
            typeof existingIntent.payment_method === "string"
              ? existingIntent.payment_method
              : existingIntent.payment_method?.id ?? null,
        });

        if (
          reconciliation.outcome === "cancelled_refunded" ||
          reconciliation.outcome === "cancelled_refund_failed"
        ) {
          throw new PaymentLinkError(
            "Payment succeeded, but lodge capacity is no longer available for this booking. The club will be in touch.",
            409
          );
        }
      }

      await queueXeroInvoiceForPaidBooking({ bookingId: booking.id });

      return { type: "alreadyPaid", paymentIntentId: existingIntent.id };
    }

    if (
      existingIntent.status !== "canceled" &&
      existingIntent.amount !== booking.finalPriceCents
    ) {
      // The booking was modified after this intent was minted (#1161): a
      // stale client_secret would capture the old total. Queue the stale
      // intent's cancellation and fall through to mint a fresh one.
      if (booking.payment) {
        await queueSupersededPrimaryIntentCancellations(prisma, {
          bookingId: booking.id,
          paymentId: booking.payment.id,
          newFinalPriceCents: booking.finalPriceCents,
        });
      }
    } else if (existingIntent.client_secret && existingIntent.status !== "canceled") {
      return {
        type: "clientSecret",
        clientSecret: existingIntent.client_secret,
        paymentIntentId: existingIntent.id,
      };
    }
  }

  // Capacity/status revalidation under the shared booking advisory lock,
  // mirroring the session path's preflight before charging.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

    const freshBooking = await tx.booking.findUnique({
      where: { id: booking.id },
      // Load per-night sets (issue #713) so a non-contiguous booking is
      // capacity-checked on the nights it actually occupies.
      include: { guests: { include: { nights: true } } },
    });

    if (
      !freshBooking ||
      !(PAYMENT_LINK_PAYABLE_BOOKING_STATUSES as readonly BookingStatus[]).includes(
        freshBooking.status
      )
    ) {
      throw new PaymentLinkError(NOT_PAYABLE_MESSAGE, 410);
    }

    const capacity = await checkCapacityForGuestRanges(
      freshBooking.checkIn,
      freshBooking.checkOut,
      freshBooking.guests,
      booking.id,
      tx
    );

    if (!capacity.available) {
      throw new PaymentLinkError(
        "Not enough beds remain available for these dates. Please contact the club.",
        409
      );
    }
  });

  // Stripe calls stay outside the database transaction.
  const customer = await findOrCreateCustomer({
    email: booking.member.email,
    name: `${booking.member.firstName} ${booking.member.lastName}`,
    memberId: booking.member.id,
  });

  const paymentIntent = await createPaymentIntent({
    amountCents: booking.finalPriceCents,
    customerId: customer.id,
    metadata: {
      bookingId: booking.id,
      memberId: booking.memberId,
      paymentLinkId: link.id,
    },
    idempotencyKey: `pl_pi_${booking.id}_${booking.payment?.stripePaymentIntentId ?? "initial"}`,
  });

  const payment = await prisma.payment.upsert({
    where: { bookingId: booking.id },
    create: {
      bookingId: booking.id,
      amountCents: booking.finalPriceCents,
      stripeCustomerId: customer.id,
      status: PaymentStatus.PENDING,
    },
    update: {
      stripeCustomerId: customer.id,
    },
  });

  await upsertPaymentIntentTransaction({
    paymentId: payment.id,
    kind: PaymentTransactionKind.PRIMARY,
    paymentIntentId: paymentIntent.id,
    amountCents: booking.finalPriceCents,
    status: PaymentStatus.PROCESSING,
    reason: "payment_link_booking_payment",
    stripeCustomerId: customer.id,
  });

  if (!paymentIntent.client_secret) {
    throw new PaymentLinkError("Unable to start the payment. Please try again.", 500);
  }

  return {
    type: "clientSecret",
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
  };
}

/** Revoke all active payment links for a booking (e.g. when it is bumped). */
export async function revokePaymentLinksForBooking(
  bookingId: string,
  db: Pick<typeof prisma, "paymentLink"> = prisma
) {
  const revoked = await db.paymentLink.updateMany({
    where: { bookingId, revokedAt: null, usedAt: null },
    data: { revokedAt: new Date() },
  });
  return revoked.count;
}
