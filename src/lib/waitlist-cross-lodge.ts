import type { AgeTier, Prisma, WaitlistCrossLodgeOrder } from "@prisma/client";
import { BookingEventType, BookingStatus } from "@prisma/client";
import {
  calculateBookingHoldDecision,
  toGroupDiscountConfig,
  toGuestPricingInputs,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import { priceBookingGuestsWithMembershipTypePolicy } from "@/lib/membership-type-policy";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import {
  acquireLodgeCapacityLock,
  checkCapacityForGuestRanges,
} from "@/lib/capacity";
import { isMemberEligibleToBookLodge } from "@/lib/lodge-access";
import { ACTIVE_BOOKING_STATUSES } from "@/lib/booking-status";
import {
  createConfirmedBooking,
  type BookingGuestInput,
} from "@/lib/booking-create";
import { getNonMemberHoldDays } from "@/lib/cancellation";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { logAudit } from "@/lib/audit";
import { recordBookingEvent } from "@/lib/booking-events";
import logger from "@/lib/logger";

// Cross-lodge waitlist support (ADR-004). The processor consults these
// helpers when a member has opted into alternate lodges: the queue-order
// policy decides who is considered first, and the quote decides whether an
// alternate lodge can actually host the entry and at what price. The quoted
// price is persisted on the offer and re-checked at confirm time, so both
// sides must price the same way.

type CrossLodgeDb = Pick<Prisma.TransactionClient, "bookingDefaults">;

/**
 * Club-wide queue-order policy (ADR-004 owner decision 1). Missing settings
 * row falls back to the schema default so pre-seed databases behave like
 * OWN_LODGE_FIRST.
 */
export async function getWaitlistCrossLodgeOrder(
  db: CrossLodgeDb,
): Promise<WaitlistCrossLodgeOrder> {
  const defaults = await db.bookingDefaults.findUnique({
    where: { id: "default" },
    select: { waitlistCrossLodgeOrder: true },
  });
  return defaults?.waitlistCrossLodgeOrder ?? "OWN_LODGE_FIRST";
}

export interface WaitlistQuoteGuest {
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string | null;
  stayStart?: Date | null;
  stayEnd?: Date | null;
  nights?: ReadonlyArray<{ stayDate: Date }> | null;
}

export interface WaitlistQuoteEntry {
  memberId: string;
  checkIn: Date;
  checkOut: Date;
  guests: WaitlistQuoteGuest[];
  // Truthy when the entry carries a promo redemption. Promo-bearing entries
  // are never offered cross-lodge: revalidating a promo at another lodge
  // collides with usage-limit counting of the entry's own redemption, and
  // silently dropping the promo would quote the member a higher price than
  // they signed up for. Their same-lodge flow is unchanged.
  hasPromoRedemption: boolean;
}

export type CrossLodgeQuote =
  | { offerable: true; finalPriceCents: number }
  | { offerable: false; reason: "promo" | "unpriceable" };

type QuoteDb = Pick<Prisma.TransactionClient, "season" | "groupDiscountSetting">;

/**
 * Price a waitlist entry's guests and dates at another lodge (ADR-004): the
 * figure quoted in a cross-lodge offer. Returns not-offerable instead of
 * throwing when the lodge's seasons cannot price the dates or a membership
 * booking policy blocks the stay — the processor just skips the candidate.
 */
export async function quoteWaitlistEntryAtLodge(
  tx: QuoteDb,
  entry: WaitlistQuoteEntry,
  lodgeId: string,
): Promise<CrossLodgeQuote> {
  if (entry.hasPromoRedemption) {
    return { offerable: false, reason: "promo" };
  }

  const seasons = await tx.season.findMany({
    where: {
      active: true,
      startDate: { lte: entry.checkOut },
      endDate: { gte: entry.checkIn },
      ...lodgeNullTolerantScope(lodgeId),
    },
    include: { rates: true },
  });
  if (seasons.length === 0) {
    return { offerable: false, reason: "unpriceable" };
  }

  const groupDiscountSetting = await tx.groupDiscountSetting.findUnique({
    where: { id: "default" },
  });

  try {
    const price = await priceBookingGuestsWithMembershipTypePolicy(tx, {
      ownerMemberId: entry.memberId,
      checkIn: entry.checkIn,
      checkOut: entry.checkOut,
      guests: toGuestPricingInputs(
        entry.guests.map((guest) => ({
          ageTier: guest.ageTier,
          isMember: guest.isMember,
          memberId: guest.memberId ?? null,
          stayStart: guest.stayStart ?? null,
          stayEnd: guest.stayEnd ?? null,
          nights: guest.nights?.length ? guest.nights : null,
        })),
      ),
      seasons: toSeasonRateData(seasons),
      groupDiscount: toGroupDiscountConfig(groupDiscountSetting),
    });
    return { offerable: true, finalPriceCents: price.totalPriceCents };
  } catch {
    // No season rate for some night, or a membership-type booking policy
    // rejects the stay at quote time. Either way this lodge cannot make a
    // clean offer.
    return { offerable: false, reason: "unpriceable" };
  }
}

export interface CrossLodgeConfirmResult {
  success: boolean;
  error?: string;
  newStatus?: BookingStatus;
  // The fresh booking created at the offered lodge on success.
  newBookingId?: string;
  // Set when the confirm was rejected because the lodge's price moved
  // between offer and confirm; the stored offer is updated to this figure
  // so the member can re-confirm at the price they can actually see.
  updatedPriceCents?: number;
  // Machine-readable rejection code the API route forwards to the client
  // (e.g. "DUPLICATE_STAY"). The price-drift rejection is signalled by
  // `updatedPriceCents` instead and needs no code here.
  code?: string;
}

// A member's existing "real stay" for the duplicate-stay guard: everything
// that is not cancelled/bumped and not a waitlist placeholder. This includes
// PAYMENT_PENDING (a real pending stay awaiting payment) and COMPLETED (for
// completeness, though it cannot overlap a future offer's dates); it excludes
// WAITLISTED / WAITLIST_OFFERED, which are not stays.
const DUPLICATE_STAY_BOOKING_STATUSES = [
  ...ACTIVE_BOOKING_STATUSES,
  BookingStatus.COMPLETED,
] as const;

type CrossLodgeOfferEntry = Prisma.BookingGetPayload<{
  include: {
    guests: { include: { nights: true } };
    promoRedemption: { select: { id: true } };
  };
}>;

async function revertOfferToWaitlisted(
  tx: Prisma.TransactionClient,
  entry: { id: string; checkIn: Date; checkOut: Date },
): Promise<void> {
  await tx.booking.update({
    where: { id: entry.id },
    data: {
      status: BookingStatus.WAITLISTED,
      waitlistOfferedAt: null,
      waitlistOfferExpiresAt: null,
      waitlistOfferedLodgeId: null,
      waitlistOfferedPriceCents: null,
    },
  });
  await reconcileBedAllocationsForBooking({
    bookingId: entry.id,
    db: tx,
    previousRange: { checkIn: entry.checkIn, checkOut: entry.checkOut },
  });
}

/**
 * Accept a cross-lodge waitlist offer (ADR-004): create-and-cancel, never
 * mutate. The waitlist entry keeps its lodge; a fresh booking is created at
 * the offered lodge through the standard creation path (which re-checks
 * capacity under that lodge's lock and re-prices from its seasons), then
 * the entry is cancelled with audit links between the two.
 *
 * The price quoted on the offer is re-checked first; if the lodge's rates
 * moved since the offer, the confirm is rejected, the stored quote is
 * refreshed, and the member re-confirms at the visible figure (owner
 * decision 2 — never silently charge a different price).
 */
export async function confirmCrossLodgeWaitlistOffer(
  bookingId: string,
  memberId: string,
): Promise<CrossLodgeConfirmResult> {
  // Phase 1 — validate the offer and re-check the quote under the offered
  // lodge's capacity lock.
  type Validated = {
    ok: true;
    entry: CrossLodgeOfferEntry;
    offeredLodgeId: string;
    quotedPriceCents: number;
  };
  let validated: Validated | { ok: false; result: CrossLodgeConfirmResult };
  try {
    validated = await prisma.$transaction(async (tx) => {
      const entry = await tx.booking.findUnique({
        where: { id: bookingId },
        include: {
          guests: { include: { nights: true } },
          promoRedemption: { select: { id: true } },
        },
      });
      if (!entry) {
        return { ok: false as const, result: { success: false, error: "Booking not found" } };
      }
      if (entry.memberId !== memberId) {
        return { ok: false as const, result: { success: false, error: "Forbidden" } };
      }
      if (entry.status !== BookingStatus.WAITLIST_OFFERED) {
        return {
          ok: false as const,
          result: { success: false, error: "Booking is not in WAITLIST_OFFERED status" },
        };
      }
      if (entry.waitlistOfferExpiresAt && entry.waitlistOfferExpiresAt < new Date()) {
        return { ok: false as const, result: { success: false, error: "Waitlist offer has expired" } };
      }
      const offeredLodgeId = entry.waitlistOfferedLodgeId;
      if (!offeredLodgeId || entry.waitlistOfferedPriceCents === null) {
        return {
          ok: false as const,
          result: { success: false, error: "This offer is not a cross-lodge offer" },
        };
      }

      await acquireLodgeCapacityLock(tx, offeredLodgeId);

      const offeredLodge = await tx.lodge.findUnique({
        where: { id: offeredLodgeId },
        select: { active: true },
      });
      const stillEligible =
        offeredLodge?.active &&
        (await isMemberEligibleToBookLodge(tx, memberId, offeredLodgeId));
      if (!stillEligible) {
        await revertOfferToWaitlisted(tx, entry);
        return {
          ok: false as const,
          result: {
            success: false,
            error:
              "That lodge is no longer available to you. You've been returned to the waitlist.",
          },
        };
      }

      // Duplicate-stay guard. If Phase 3 (cancel the waitlist entry) failed on
      // an earlier confirm, the entry is stranded in WAITLIST_OFFERED with a
      // booking already created at the offered lodge; a re-confirm (or an
      // expiry re-offer + confirm) would create a SECOND booking and a second
      // payment request for the same stay. Reject when the member already holds
      // an active booking overlapping the offer's dates at the offered lodge.
      // The offered lodge's capacity lock (taken above) spans only THIS
      // Phase-1 transaction, so the guard reliably catches any COMMITTED
      // earlier confirm (the stranded-offer re-confirm and expiry-re-offer
      // paths). Two fully-concurrent in-flight confirms of the same offer can
      // still both pass Phase 1 before either creates its booking in Phase 2 —
      // a known residual; Phase 2's capacity re-check under the lock still
      // bounds overbooking. The entry itself is excluded by id, and waitlist
      // placeholders never count.
      const duplicateStay = await tx.booking.findFirst({
        where: {
          memberId,
          lodgeId: offeredLodgeId,
          id: { not: entry.id },
          deletedAt: null,
          status: { in: [...DUPLICATE_STAY_BOOKING_STATUSES] },
          // Date-only overlap, matching the processor's overlap predicate.
          checkIn: { lt: entry.checkOut },
          checkOut: { gt: entry.checkIn },
        },
        select: { id: true },
      });
      if (duplicateStay) {
        return {
          ok: false as const,
          result: {
            success: false,
            error:
              "You already have a booking at this lodge for these dates. Cancel it before accepting this offer.",
            code: "DUPLICATE_STAY",
          },
        };
      }

      const { available } = await checkCapacityForGuestRanges(
        offeredLodgeId,
        entry.checkIn,
        entry.checkOut,
        entry.guests,
        undefined,
        tx,
      );
      if (!available) {
        await revertOfferToWaitlisted(tx, entry);
        return {
          ok: false as const,
          result: {
            success: false,
            error: "Capacity is no longer available. You've been returned to the waitlist.",
          },
        };
      }

      const quote = await quoteWaitlistEntryAtLodge(
        tx,
        {
          memberId: entry.memberId,
          checkIn: entry.checkIn,
          checkOut: entry.checkOut,
          guests: entry.guests,
          hasPromoRedemption: Boolean(entry.promoRedemption),
        },
        offeredLodgeId,
      );
      if (!quote.offerable) {
        await revertOfferToWaitlisted(tx, entry);
        return {
          ok: false as const,
          result: {
            success: false,
            error:
              "This lodge can no longer price your stay. You've been returned to the waitlist.",
          },
        };
      }
      if (quote.finalPriceCents !== entry.waitlistOfferedPriceCents) {
        // Rates moved between offer and confirm: refresh the stored quote
        // and ask the member to confirm the figure they can now see.
        await tx.booking.update({
          where: { id: entry.id },
          data: { waitlistOfferedPriceCents: quote.finalPriceCents },
        });
        return {
          ok: false as const,
          result: {
            success: false,
            error:
              "The price at this lodge has changed since your offer. Please review the updated price and confirm again.",
            updatedPriceCents: quote.finalPriceCents,
          },
        };
      }

      return {
        ok: true as const,
        entry,
        offeredLodgeId,
        quotedPriceCents: entry.waitlistOfferedPriceCents,
      };
    });
  } catch (err) {
    logger.error({ err, bookingId }, "Failed to validate cross-lodge waitlist confirm");
    return { success: false, error: "An error occurred while confirming your booking" };
  }
  if (!validated.ok) {
    return validated.result;
  }
  const { entry, offeredLodgeId, quotedPriceCents } = validated;

  // Phase 2 — create the fresh booking at the offered lodge through the
  // standard creation path. It re-acquires that lodge's capacity lock and
  // re-checks capacity itself, so the tiny window since phase 1 is safe.
  const guests: BookingGuestInput[] = entry.guests.map((guest) => ({
    firstName: guest.firstName,
    lastName: guest.lastName,
    ageTier: guest.ageTier,
    isMember: guest.isMember,
    memberId: guest.memberId ?? undefined,
    stayStart: guest.stayStart,
    stayEnd: guest.stayEnd,
    nights: guest.nights.length > 0 ? guest.nights : null,
  }));
  const hasNonMembers = guests.some((guest) => !guest.isMember);
  const holdDays = hasNonMembers ? await getNonMemberHoldDays(entry.checkIn, offeredLodgeId) : 7;
  const { shouldBePending, status } = calculateBookingHoldDecision({
    hasNonMembers,
    checkIn: entry.checkIn,
    holdDays,
  });

  let outcome;
  try {
    outcome = await createConfirmedBooking({
      effectiveMemberId: memberId,
      isOnBehalf: false,
      sessionUserId: memberId,
      checkIn: entry.checkIn,
      checkOut: entry.checkOut,
      guests,
      notes: entry.notes ?? undefined,
      expectedArrivalTime: entry.expectedArrivalTime ?? undefined,
      cancelIfGuestsBumped: entry.cancelIfGuestsBumped,
      memberReviewJustification: entry.memberReviewJustification ?? undefined,
      lodgeId: offeredLodgeId,
      status,
      shouldBePending,
      holdDays,
    });
  } catch (err) {
    logger.error(
      { err, bookingId, offeredLodgeId },
      "Failed to create replacement booking for cross-lodge waitlist confirm",
    );
    return { success: false, error: "An error occurred while confirming your booking" };
  }

  if (outcome.type === "capacityExceeded") {
    try {
      await prisma.$transaction(async (tx) => {
        await acquireLodgeCapacityLock(tx, offeredLodgeId);
        await revertOfferToWaitlisted(tx, entry);
      });
    } catch (err) {
      logger.error({ err, bookingId }, "Failed to revert cross-lodge offer after capacity loss");
    }
    return {
      success: false,
      error: "Capacity is no longer available. You've been returned to the waitlist.",
    };
  }

  const newBooking = outcome.booking;

  if (newBooking.finalPriceCents !== quotedPriceCents) {
    // The standard path must price exactly like the quote; a mismatch means
    // rates changed in the moments since phase 1. Never charge it silently:
    // cancel the fresh booking, refresh the stored quote, and ask again.
    try {
      await prisma.$transaction(async (tx) => {
        await tx.booking.update({
          where: { id: newBooking.id },
          data: { status: BookingStatus.CANCELLED },
        });
        await reconcileBedAllocationsForBooking({
          bookingId: newBooking.id,
          db: tx,
          previousRange: { checkIn: newBooking.checkIn, checkOut: newBooking.checkOut },
        });
        await tx.booking.update({
          where: { id: entry.id },
          data: { waitlistOfferedPriceCents: newBooking.finalPriceCents },
        });
      });
    } catch (err) {
      logger.error(
        { err, bookingId, newBookingId: newBooking.id },
        "Failed to unwind price-drifted cross-lodge confirm",
      );
      return { success: false, error: "An error occurred while confirming your booking" };
    }
    return {
      success: false,
      error:
        "The price at this lodge has changed since your offer. Please review the updated price and confirm again.",
      updatedPriceCents: newBooking.finalPriceCents,
    };
  }

  // Phase 3 — cancel the waitlist entry and link the two bookings. The
  // member already has the new booking; a failure here must not fail the
  // confirm, it just leaves cleanup for an admin (loudly logged).
  try {
    await prisma.$transaction(async (tx) => {
      await tx.booking.update({
        where: { id: entry.id },
        data: {
          status: BookingStatus.CANCELLED,
          waitlistPosition: null,
          waitlistOfferedAt: null,
          waitlistOfferExpiresAt: null,
          waitlistOfferedLodgeId: null,
          waitlistOfferedPriceCents: null,
          notes: [
            entry.notes,
            `Cross-lodge waitlist offer accepted; replaced by booking ${newBooking.id}.`,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      });
      await reconcileBedAllocationsForBooking({
        bookingId: entry.id,
        db: tx,
        previousRange: { checkIn: entry.checkIn, checkOut: entry.checkOut },
      });
    });

    await recordBookingEvent({
      bookingId: entry.id,
      type: BookingEventType.CANCELLED,
      actorMemberId: memberId,
    });
  } catch (err) {
    logger.error(
      { err, waitlistBookingId: entry.id, newBookingId: newBooking.id },
      "Cross-lodge confirm created the new booking but failed to cancel the waitlist entry — needs admin cleanup",
    );
  }

  logAudit({
    action: "waitlist.cross_lodge_offer_confirmed",
    memberId,
    targetId: newBooking.id,
    subjectMemberId: memberId,
    entityType: "Booking",
    entityId: newBooking.id,
    category: "booking",
    outcome: "success",
    summary: "Cross-lodge waitlist offer confirmed",
    details: `Waitlist entry ${entry.id} replaced by booking ${newBooking.id} at the offered lodge`,
    metadata: {
      waitlistBookingId: entry.id,
      newBookingId: newBooking.id,
      offeredLodgeId,
      priceCents: quotedPriceCents,
      newStatus: newBooking.status,
    },
  });

  return {
    success: true,
    newStatus: newBooking.status,
    newBookingId: newBooking.id,
  };
}
