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
import { acquireLodgeCapacityLock, checkCapacityForGuestRanges } from "@/lib/capacity";
import { bookingHasCapacityOverride } from "@/lib/booking-status";
import { getDefaultLodgeId } from "@/lib/lodges";
import { endOfDateOnlyForTimeZone, formatDateOnly } from "@/lib/date-only";
import {
  sendBookingRequestApprovedEmail,
  sendSplitGuestPaymentLinkEmail,
} from "@/lib/email";
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
const PAYMENT_LINK_PAYABLE_BOOKING_STATUSES = [
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
        groupBookingJoin: { select: { id: true } };
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
          // #1967: lets link flows tell a genuine split child (#738) apart
          // from a #796 group joiner (which always has a join row).
          groupBookingJoin: { select: { id: true } },
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
interface PaymentLinkPayable {
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
 *
 * Returns `emailed: false` when the requester's address is actively
 * suppressed (prior SES bounce/complaint) — nothing was delivered, so the UI
 * must not promise an email that will never arrive (F25, #1885).
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
    // Serialise with every other mint path (#1967): the settlement cron and
    // the on-demand split-guest flow both mint under the per-lodge advisory
    // lock, so taking it here too makes revoke-then-create atomic across all
    // three writers — at most one live token can exist for the booking.
    const bookingLodgeId = booking.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, bookingLodgeId);
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

  // #1967 (FIX): a split non-member child's expired link must be re-issued
  // with the split-guest wording, not the request-origin "booking request
  // approved" template — the member never made a booking request. Group
  // joiners (#796, also parent-linked but always carrying a join row) keep
  // their pre-existing behaviour.
  const isSplitGuestLink =
    booking.parentBookingId != null &&
    !booking.groupBookingJoin &&
    !link.bookingRequestId;

  const emailParams = {
    email: booking.member.email,
    firstName: booking.member.firstName,
    lodgeId: booking.lodgeId ?? null,
    token: freshToken,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    guestCount: booking.guests.length,
    priceCents: booking.finalPriceCents,
    bookingReference: booking.id,
    expiresAt,
  };
  const emailOutcome = isSplitGuestLink
    ? await sendSplitGuestPaymentLinkEmail(emailParams)
    : await sendBookingRequestApprovedEmail(emailParams);

  if (emailOutcome.status === "suppressed") {
    // sendEmail delivered nothing (recipient is SES-suppressed after a prior
    // bounce/complaint). Report truthfully so the page can tell the requester
    // to contact the club instead of watching an inbox that stays empty.
    logger.warn(
      {
        bookingId: booking.id,
        emailSuppressionId: emailOutcome.emailSuppressionId,
        reason: emailOutcome.reason,
      },
      "Fresh payment link issued but the email was suppressed; recipient undeliverable"
    );
    return { emailed: false };
  }

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
    // Pre-lock read: only the lock key. lodgeId is immutable, so keying the
    // lock from this read is safe; the status re-validation and capacity check
    // consume ONLY the post-lock re-read below.
    const lockTarget = await tx.booking.findUnique({
      where: { id: booking.id },
      select: { lodgeId: true },
    });
    const bookingLodgeId = lockTarget?.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, bookingLodgeId);

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

    // Re-read the link under the same lock (#1967 FIX-6): the auto-charge cron
    // revokes a booking's links inside its claim transaction (also under this
    // lodge lock) before charging the saved card, so a /pay request that
    // resolved the link just before that claim must not go on to mint an
    // intent — the saved-card charge now owns settlement.
    const freshLink = await tx.paymentLink.findUnique({
      where: { id: link.id },
      select: { revokedAt: true },
    });
    if (!freshLink || freshLink.revokedAt) {
      throw new PaymentLinkError(REVOKED_LINK_MESSAGE, 410);
    }

    const capacity = await checkCapacityForGuestRanges(
      bookingLodgeId,
      freshBooking.checkIn,
      freshBooking.checkOut,
      freshBooking.guests,
      booking.id,
      tx
    );

    if (!capacity.available && bookingHasCapacityOverride(freshBooking)) {
      // Persisted capacity override (#1771): the booking was deliberately
      // admitted above the ceiling by an admin, so a payment link must not 409
      // it — fall through and let the payment proceed.
      logger.info(
        { bookingId: booking.id },
        "Paying an over-capacity booking with a persisted capacity override (#1771); skipping the payment-link capacity block"
      );
    }
    if (!capacity.available && !bookingHasCapacityOverride(freshBooking)) {
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

/** A freshly minted split-guest link: the raw token (emailable exactly once)
 * plus the row id so a caller whose email fails can revoke THIS link — and
 * only this link — without touching a newer one minted concurrently. */
export type MintedSplitGuestPaymentLink = {
  token: string;
  paymentLinkId: string;
};

/**
 * The on-demand "re-send" affordance treats an active link minted within this
 * window as just-sent and refuses to replace it, so a double-click (or two
 * racing POSTs) cannot fan out two emails. Older active links ARE replaced —
 * revoke-and-remint is the only way to re-send, because raw tokens are never
 * stored at rest.
 */
const SPLIT_LINK_RESEND_COOLDOWN_MS = 60 * 1000;

/**
 * Revoke every unused, unrevoked link for the booking and mint a fresh one.
 * MUST be called inside a transaction holding the booking's per-lodge advisory
 * lock — the revoke-then-create pair is what preserves the at-most-one-live-
 * token invariant across the cron, the on-demand button, and /pay reissue.
 */
async function mintFreshSplitGuestPaymentLink(
  tx: Prisma.TransactionClient,
  bookingId: string,
  expiresAt: Date,
  now: Date
): Promise<MintedSplitGuestPaymentLink> {
  await tx.paymentLink.updateMany({
    where: { bookingId, revokedAt: null, usedAt: null },
    data: { revokedAt: now },
  });
  const { token, tokenHash } = issueActionToken();
  const created = await tx.paymentLink.create({
    data: { bookingId, tokenHash, expiresAt },
  });
  return { token, paymentLinkId: created.id };
}

/**
 * Mint a tokenised PaymentLink for a split non-member child booking (#1967) IF
 * it has no active (un-revoked, un-used, un-expired) link yet, returning the
 * raw token + row id so the caller can email it and, if that email fails,
 * revoke it. Returns null when an active link already exists — that
 * absence/presence is the idempotency sentinel that stops the settlement cron
 * re-emailing the member on every extension run (only the raw token minted
 * here can be emailed; a pre-existing link's token is unrecoverable by
 * design). An EXPIRED link is deliberately NOT active (#707's expired_payable
 * convention): it is revoked and replaced, so a booking whose dates were
 * pushed out after its link lapsed gets a fresh, working link. Returns null
 * without minting when the check-in day has already ended — a link that would
 * be born expired must never be emailed.
 *
 * DB-only and safe to call inside a capacity-lock transaction; the email MUST
 * be sent by the caller OUTSIDE the transaction. The link expires at the end of
 * the check-in day in NZT, matching the #707/#740 request-origin convention.
 */
export async function mintSplitGuestPaymentLinkIfAbsent(
  tx: Prisma.TransactionClient,
  booking: { id: string; checkIn: Date }
): Promise<MintedSplitGuestPaymentLink | null> {
  const now = new Date();
  const expiresAt = endOfDateOnlyForTimeZone(formatDateOnly(booking.checkIn));
  if (expiresAt.getTime() <= now.getTime()) {
    return null;
  }

  const existing = await tx.paymentLink.findFirst({
    where: {
      bookingId: booking.id,
      revokedAt: null,
      usedAt: null,
      expiresAt: { gt: now },
    },
    select: { id: true },
  });
  if (existing) return null;

  return mintFreshSplitGuestPaymentLink(tx, booking.id, expiresAt, now);
}

/**
 * Revoke one specific payment link (by row id) if it is still unused and
 * unrevoked. Used by the mint-and-email flows when the post-commit email
 * fails or is suppressed: the raw token is unrecoverable, so the stale
 * sentinel must be cleared for the next run to re-mint and re-send. Scoped to
 * the id — never the whole booking — so a newer link minted concurrently by
 * another flow survives.
 */
export async function revokePaymentLinkById(
  paymentLinkId: string,
  db: Pick<typeof prisma, "paymentLink"> = prisma
) {
  const revoked = await db.paymentLink.updateMany({
    where: { id: paymentLinkId, revokedAt: null, usedAt: null },
    data: { revokedAt: new Date() },
  });
  return revoked.count;
}

export type IssueSplitGuestPaymentLinkResult =
  | { outcome: "sent" }
  | { outcome: "just_sent" }
  | { outcome: "suppressed" }
  | { outcome: "not_payable" };

/**
 * On-demand sibling of the settlement-cron path (#1967): mint and email a
 * split non-member child's guest-portion payment link. Backs the
 * booking-detail affordance a member uses when paying their own place by
 * Internet Banking (no card on file for the later guest charge).
 *
 * This is a true send/RE-SEND: because a stored link's raw token is
 * unrecoverable, an existing active link is revoked and replaced with a fresh
 * one (revocation + mint atomically under the per-lodge advisory lock, so two
 * live tokens can never coexist). The only exception is an active link minted
 * within the last minute, which is treated as just-sent — that sentinel plus
 * the lock is the double-click guard. If the email is suppressed or the send
 * throws, the just-minted link is revoked again so no unreachable token stays
 * active. Refuses (`not_payable`) for anything that is not a genuine PENDING
 * split child (#738) — #796 group joiners are excluded by their join row — and
 * whenever a saved card exists on the child or its parent, because the
 * settlement cron will auto-charge that card and a parallel link would open a
 * second live settlement path.
 */
export async function issueSplitGuestPaymentLink(
  childBookingId: string
): Promise<IssueSplitGuestPaymentLinkResult> {
  const booking = await prisma.booking.findUnique({
    where: { id: childBookingId },
    include: {
      member: true,
      guests: { select: { id: true } },
      payment: true,
      parentBooking: { include: { payment: true } },
      groupBookingJoin: { select: { id: true } },
    },
  });

  if (
    !booking ||
    booking.deletedAt ||
    booking.status !== BookingStatus.PENDING ||
    !booking.parentBookingId ||
    // #796 group joiners share parentBookingId but always carry a join row;
    // they settle via their own join-time link or organiser settlement, never
    // via the split-guest flow.
    booking.groupBookingJoin ||
    !booking.hasNonMembers ||
    booking.finalPriceCents <= 0
  ) {
    return { outcome: "not_payable" };
  }

  // #1967 FIX-5: a saved card (its own, or inherited from the parent payment)
  // means the settlement cron will auto-charge this child — issuing a manual
  // pay link alongside would create a second live settlement path.
  const hasSavedCard = Boolean(
    (booking.payment?.stripeCustomerId &&
      booking.payment.stripePaymentMethodId) ||
      (booking.parentBooking?.payment?.stripeCustomerId &&
        booking.parentBooking.payment.stripePaymentMethodId)
  );
  if (hasSavedCard) {
    return { outcome: "not_payable" };
  }

  const minted = await prisma.$transaction(
    async (
      tx
    ): Promise<
      | { kind: "not_payable" }
      | { kind: "just_sent" }
      | ({ kind: "minted" } & MintedSplitGuestPaymentLink)
    > => {
      const bookingLodgeId = booking.lodgeId ?? (await getDefaultLodgeId(tx));
      await acquireLodgeCapacityLock(tx, bookingLodgeId);
      // Re-read status under the lock; a concurrent settle/cancel is only
      // visible here. Never mint a link for a booking that has left PENDING.
      const locked = await tx.booking.findUnique({
        where: { id: booking.id },
        select: { status: true },
      });
      if (!locked || locked.status !== BookingStatus.PENDING) {
        return { kind: "not_payable" };
      }

      const now = new Date();
      const expiresAt = endOfDateOnlyForTimeZone(
        formatDateOnly(booking.checkIn)
      );
      if (expiresAt.getTime() <= now.getTime()) {
        // The check-in day has ended; a fresh link would be born expired.
        return { kind: "not_payable" };
      }

      const active = await tx.paymentLink.findFirst({
        where: {
          bookingId: booking.id,
          revokedAt: null,
          usedAt: null,
          expiresAt: { gt: now },
        },
        select: { id: true, createdAt: true },
      });
      if (
        active &&
        now.getTime() - active.createdAt.getTime() <
          SPLIT_LINK_RESEND_COOLDOWN_MS
      ) {
        // Just minted (double-click, or a race with the settlement cron):
        // an email carrying this link is already on its way.
        return { kind: "just_sent" };
      }

      // Revoke-and-remint: the active link's raw token is unrecoverable at
      // rest, so re-sending means replacing it. Atomic under the lodge lock.
      return {
        kind: "minted",
        ...(await mintFreshSplitGuestPaymentLink(
          tx,
          booking.id,
          expiresAt,
          now
        )),
      };
    }
  );

  if (minted.kind === "not_payable") return { outcome: "not_payable" };
  if (minted.kind === "just_sent") return { outcome: "just_sent" };

  let emailOutcome;
  try {
    emailOutcome = await sendSplitGuestPaymentLinkEmail({
      email: booking.member.email,
      firstName: booking.member.firstName,
      token: minted.token,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      guestCount: booking.guests.length,
      priceCents: booking.finalPriceCents,
      bookingReference: booking.id,
      expiresAt: endOfDateOnlyForTimeZone(formatDateOnly(booking.checkIn)),
      lodgeId: booking.lodgeId ?? null,
    });
  } catch (err) {
    // The raw token dies with this request; clear the sentinel so a retry
    // (button or cron) re-mints instead of pointing at an unreachable link.
    await revokePaymentLinkById(minted.paymentLinkId).catch((revokeErr) =>
      logger.error(
        { err: revokeErr, bookingId: booking.id, paymentLinkId: minted.paymentLinkId },
        "Failed to revoke split guest payment link after email send error"
      )
    );
    throw err;
  }

  if (emailOutcome.status !== "sent") {
    // Suppressed (or placeholder) recipient: nothing was delivered, so the
    // link must not stay active suppressing every future send (F25, #1885).
    await revokePaymentLinkById(minted.paymentLinkId).catch((revokeErr) =>
      logger.error(
        { err: revokeErr, bookingId: booking.id, paymentLinkId: minted.paymentLinkId },
        "Failed to revoke split guest payment link after suppressed email"
      )
    );
    logger.warn(
      { bookingId: booking.id, emailStatus: emailOutcome.status },
      "Split guest payment link email not delivered; link revoked so a later attempt re-mints"
    );
    return { outcome: "suppressed" };
  }

  return { outcome: "sent" };
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
