/**
 * Public non-member booking request flow (issue #707).
 *
 * Lifecycle: NEW -> (email verification) -> VERIFIED -> (officer pricing)
 * -> PRICED -> (officer decision) -> APPROVED/DECLINED -> CONVERTED.
 *
 * Approval converts the request into a non-login Member (canLogin: false)
 * plus a PENDING Booking owned by it, mirroring the membership application
 * pattern in src/lib/nomination.ts. Booking.memberId stays required.
 *
 * Conventions:
 *   - money stays integer cents
 *   - booking dates stay NZ date-only values
 *   - only SHA-256 token hashes are stored (issueActionToken)
 *   - external calls (email) run after the transaction commits
 */
import { randomBytes } from "crypto";
import { hash } from "bcryptjs";
import {
  AgeTier,
  BookingEventType,
  BookingRequestStatus,
  BookingStatus,
  PaymentStatus,
  Prisma,
  Role,
  type BookingRequest,
} from "@prisma/client";
import { z } from "zod";
import { hashActionToken, issueActionToken } from "@/lib/action-tokens";
import { logAudit } from "@/lib/audit";
import { cancelBooking } from "@/lib/booking-cancel";
import { recordBookingEvent } from "@/lib/booking-events";
import { assertNoBookingMemberNightConflicts } from "@/lib/booking-member-night-conflicts";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { getNonMemberHoldDays } from "@/lib/cancellation";
import { endOfDateOnlyForTimeZone, formatDateOnly } from "@/lib/date-only";
import {
  sendAdminBookingRequestPendingEmail,
  sendBookingRequestApprovedEmail,
  sendBookingRequestDeclinedEmail,
  sendBookingRequestVerificationEmail,
} from "@/lib/email";
import logger from "@/lib/logger";
import { assertMembershipTypeBookingAllowed } from "@/lib/membership-type-policy";
import {
  priceBookingGuests,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import { prisma } from "@/lib/prisma";
import { ageTierEnum } from "@/lib/age-tier-schema";
import { nameField } from "@/lib/zod-helpers";
import { getSeasonYear } from "@/lib/utils";

export const BOOKING_REQUEST_VERIFICATION_TTL_MS = 48 * 60 * 60 * 1000;
/** Privacy Act 2020 retention: purge declined and never-verified requests. */
const BOOKING_REQUEST_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export const bookingRequestGuestSchema = z.object({
  firstName: nameField(),
  lastName: nameField(),
  ageTier: ageTierEnum,
});

export type BookingRequestGuest = z.infer<typeof bookingRequestGuestSchema>;

const bookingRequestLinkedGuestMemberSchema = z.object({
  guestIndex: z.number().int().min(0),
  memberId: z.string().min(1),
});

export type BookingRequestLinkedGuestMember = z.infer<
  typeof bookingRequestLinkedGuestMemberSchema
>;

export class BookingRequestError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "BookingRequestError";
    this.status = status;
  }
}

function cleanString(value?: string | null) {
  return value?.replace(/[\r\n]/g, " ").trim() || "";
}

function cleanNullableString(value?: string | null) {
  const trimmed = cleanString(value);
  return trimmed || null;
}

export function parseBookingRequestGuests(raw: unknown): BookingRequestGuest[] {
  const parsed = z.array(bookingRequestGuestSchema).safeParse(raw);
  if (!parsed.success) {
    throw new BookingRequestError("Stored booking request guests are invalid", 500);
  }
  return parsed.data;
}

export function parseBookingRequestLinkedGuestMembers(
  raw: unknown
): BookingRequestLinkedGuestMember[] {
  if (!raw) return [];
  const parsed = z.array(bookingRequestLinkedGuestMemberSchema).safeParse(raw);
  if (!parsed.success) {
    throw new BookingRequestError("Stored linked booking request members are invalid", 500);
  }
  return parsed.data;
}

export function linkedGuestMemberMap(raw: unknown): Map<number, string> {
  return new Map(
    parseBookingRequestLinkedGuestMembers(raw).map((link) => [
      link.guestIndex,
      link.memberId,
    ])
  );
}

// ---------------------------------------------------------------------------
// Settings (pricing visibility)
// ---------------------------------------------------------------------------

export async function getBookingRequestSettings(db: Pick<typeof prisma, "bookingRequestSettings"> = prisma) {
  const record = await db.bookingRequestSettings.findUnique({
    where: { id: "default" },
  });
  return {
    showPricingToNonMembers: record?.showPricingToNonMembers ?? false,
    quoteResponseTtlDays: record?.quoteResponseTtlDays ?? 14,
    quoteReminderLeadDays: record?.quoteReminderLeadDays ?? 3,
    attendeeConfirmationLeadDays: record?.attendeeConfirmationLeadDays ?? 14,
    attendeeConfirmationReminderDays:
      record?.attendeeConfirmationReminderDays ?? 3,
  };
}

export async function updateBookingRequestSettings(input: {
  showPricingToNonMembers: boolean;
  quoteResponseTtlDays: number;
  quoteReminderLeadDays: number;
  attendeeConfirmationLeadDays: number;
  attendeeConfirmationReminderDays: number;
  adminMemberId: string;
}) {
  const settings = await prisma.bookingRequestSettings.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      showPricingToNonMembers: input.showPricingToNonMembers,
      quoteResponseTtlDays: input.quoteResponseTtlDays,
      quoteReminderLeadDays: input.quoteReminderLeadDays,
      attendeeConfirmationLeadDays: input.attendeeConfirmationLeadDays,
      attendeeConfirmationReminderDays: input.attendeeConfirmationReminderDays,
      updatedByMemberId: input.adminMemberId,
    },
    update: {
      showPricingToNonMembers: input.showPricingToNonMembers,
      quoteResponseTtlDays: input.quoteResponseTtlDays,
      quoteReminderLeadDays: input.quoteReminderLeadDays,
      attendeeConfirmationLeadDays: input.attendeeConfirmationLeadDays,
      attendeeConfirmationReminderDays: input.attendeeConfirmationReminderDays,
      updatedByMemberId: input.adminMemberId,
    },
  });

  logAudit({
    action: "booking_request.settings_updated",
    memberId: input.adminMemberId,
    actorMemberId: input.adminMemberId,
    entityType: "BookingRequestSettings",
    entityId: "default",
    category: "admin",
    outcome: "success",
    summary: "Booking request settings updated",
    metadata: {
      showPricingToNonMembers: input.showPricingToNonMembers,
      quoteResponseTtlDays: input.quoteResponseTtlDays,
      quoteReminderLeadDays: input.quoteReminderLeadDays,
    },
  });

  return {
    showPricingToNonMembers: settings.showPricingToNonMembers,
    quoteResponseTtlDays: settings.quoteResponseTtlDays,
    quoteReminderLeadDays: settings.quoteReminderLeadDays,
  };
}

// ---------------------------------------------------------------------------
// Indicative non-member pricing
// ---------------------------------------------------------------------------

/**
 * Price a guest list at the public non-member rates for the given range.
 * Returns null when no active season covers the dates (no rate available).
 */
export async function calculateIndicativeNonMemberPriceCents(input: {
  checkIn: Date;
  checkOut: Date;
  guests: Array<{ ageTier: AgeTier }>;
}): Promise<number | null> {
  const seasons = await prisma.season.findMany({
    where: {
      active: true,
      startDate: { lte: input.checkOut },
      endDate: { gte: input.checkIn },
    },
    include: { rates: true },
  });

  if (seasons.length === 0) {
    return null;
  }

  const price = priceBookingGuests({
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    guests: input.guests.map((guest) => ({
      ageTier: guest.ageTier,
      isMember: false,
    })),
    seasons: toSeasonRateData(seasons),
  });

  return price.totalPriceCents;
}

// ---------------------------------------------------------------------------
// Public submission + verification
// ---------------------------------------------------------------------------

interface CreateBookingRequestInput {
  contactFirstName: string;
  contactLastName: string;
  contactEmail: string;
  contactPhone?: string | null;
  checkIn: Date;
  checkOut: Date;
  guests: BookingRequestGuest[];
  message?: string | null;
}

/**
 * Create a NEW booking request and email the requester a verification link.
 * The request only enters the admin queue once the email is verified.
 */
export async function createBookingRequest(input: CreateBookingRequestInput) {
  const contactEmail = cleanString(input.contactEmail).toLowerCase();
  const contactFirstName = cleanString(input.contactFirstName);
  const contactLastName = cleanString(input.contactLastName);

  if (!contactFirstName || !contactLastName || !contactEmail) {
    throw new BookingRequestError("Contact name and email are required", 422);
  }
  if (input.guests.length === 0) {
    throw new BookingRequestError("At least one guest is required", 422);
  }

  const settings = await getBookingRequestSettings();
  const indicativePriceCents = settings.showPricingToNonMembers
    ? await calculateIndicativeNonMemberPriceCents({
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        guests: input.guests,
      })
    : null;

  const { token, tokenHash } = issueActionToken();
  const verificationTokenExpiresAt = new Date(
    Date.now() + BOOKING_REQUEST_VERIFICATION_TTL_MS
  );

  const request = await prisma.bookingRequest.create({
    data: {
      contactFirstName,
      contactLastName,
      contactEmail,
      contactPhone: cleanNullableString(input.contactPhone),
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      guests: input.guests,
      message: cleanNullableString(input.message),
      indicativePriceCents,
      verificationTokenHash: tokenHash,
      verificationTokenExpiresAt,
    },
  });

  try {
    await sendBookingRequestVerificationEmail({
      email: contactEmail,
      firstName: contactFirstName,
      token,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      guestCount: input.guests.length,
      expiresAt: verificationTokenExpiresAt,
    });
  } catch (err) {
    logger.error(
      { err, bookingRequestId: request.id },
      "Failed to send booking request verification email"
    );
  }

  logAudit({
    action: "booking_request.submitted",
    targetId: request.id,
    entityType: "BookingRequest",
    entityId: request.id,
    category: "booking",
    outcome: "success",
    summary: "Public booking request submitted",
    metadata: {
      checkIn: input.checkIn.toISOString(),
      checkOut: input.checkOut.toISOString(),
      guestCount: input.guests.length,
      indicativePriceCents,
      pricingShown: settings.showPricingToNonMembers,
    },
  });

  return request;
}

type VerifyBookingRequestOutcome =
  | { outcome: "verified"; request: BookingRequest }
  | { outcome: "already_verified"; request: BookingRequest }
  | { outcome: "expired" }
  | { outcome: "invalid" };

/**
 * Verify the requester's email address from the emailed token. On first
 * verification the request moves NEW -> VERIFIED and lands in the admin queue.
 */
export async function verifyBookingRequest(
  token: string
): Promise<VerifyBookingRequestOutcome> {
  const tokenHash = hashActionToken(cleanString(token));

  const request = await prisma.bookingRequest.findUnique({
    where: { verificationTokenHash: tokenHash },
  });

  if (!request) {
    return { outcome: "invalid" };
  }

  if (request.status !== BookingRequestStatus.NEW) {
    return { outcome: "already_verified", request };
  }

  if (
    !request.verificationTokenExpiresAt ||
    request.verificationTokenExpiresAt < new Date()
  ) {
    return { outcome: "expired" };
  }

  const verifiedAt = new Date();
  // Status-claim: only one concurrent verification can flip NEW -> VERIFIED.
  const claimed = await prisma.bookingRequest.updateMany({
    where: { id: request.id, status: BookingRequestStatus.NEW },
    data: { status: BookingRequestStatus.VERIFIED, verifiedAt },
  });

  if (claimed.count === 0) {
    const latest = await prisma.bookingRequest.findUnique({
      where: { id: request.id },
    });
    return latest
      ? { outcome: "already_verified", request: latest }
      : { outcome: "invalid" };
  }

  const updated = { ...request, status: BookingRequestStatus.VERIFIED, verifiedAt };

  logAudit({
    action: "booking_request.verified",
    targetId: request.id,
    entityType: "BookingRequest",
    entityId: request.id,
    category: "booking",
    outcome: "success",
    summary: "Booking request email verified",
  });

  sendAdminBookingRequestPendingEmail({
    requesterName: `${request.contactFirstName} ${request.contactLastName}`,
    checkIn: request.checkIn,
    checkOut: request.checkOut,
    guestCount: parseBookingRequestGuests(request.guests).length,
  }).catch((err) =>
    logger.error(
      { err, bookingRequestId: request.id },
      "Failed to send admin booking request alert"
    )
  );

  return { outcome: "verified", request: updated };
}

// ---------------------------------------------------------------------------
// Officer pricing and decisions
// ---------------------------------------------------------------------------

/** Set or override the officer price on a verified request. */
export async function priceBookingRequest(input: {
  requestId: string;
  adminMemberId: string;
  priceCents: number;
}) {
  if (!Number.isInteger(input.priceCents) || input.priceCents < 0) {
    throw new BookingRequestError("Price must be a non-negative whole number of cents", 422);
  }

  const pricedAt = new Date();
  const existing = await prisma.bookingRequest.findUnique({
    where: { id: input.requestId },
  });
  if (!existing) {
    throw new BookingRequestError("Booking request not found", 404);
  }

  const claimed = await prisma.bookingRequest.updateMany({
    where: {
      id: input.requestId,
      status: {
        in: [BookingRequestStatus.VERIFIED, BookingRequestStatus.PRICED],
      },
    },
    data: {
      status: BookingRequestStatus.PRICED,
      priceCents: input.priceCents,
      pricedByMemberId: input.adminMemberId,
      pricedAt,
    },
  });

  if (claimed.count === 0) {
    throw new BookingRequestError(
      "Only verified booking requests can be priced",
      409
    );
  }

  logAudit({
    action: "booking_request.priced",
    memberId: input.adminMemberId,
    actorMemberId: input.adminMemberId,
    targetId: input.requestId,
    entityType: "BookingRequest",
    entityId: input.requestId,
    category: "booking",
    outcome: "success",
    summary: "Booking request priced by officer",
    metadata: {
      priceCents: input.priceCents,
      previousPriceCents: existing.priceCents,
      indicativePriceCents: existing.indicativePriceCents,
    },
  });

  return prisma.bookingRequest.findUnique({ where: { id: input.requestId } });
}

/** Decline a verified or priced request and email the requester. */
export async function declineBookingRequest(input: {
  requestId: string;
  adminMemberId: string;
  reason?: string | null;
  ipAddress?: string;
}) {
  const request = await prisma.bookingRequest.findUnique({
    where: { id: input.requestId },
  });
  if (!request) {
    throw new BookingRequestError("Booking request not found", 404);
  }

  const reviewedAt = new Date();
  const declineReason = cleanNullableString(input.reason);
  const claimed = await prisma.bookingRequest.updateMany({
    where: {
      id: input.requestId,
      status: {
        in: [BookingRequestStatus.VERIFIED, BookingRequestStatus.PRICED],
      },
    },
    data: {
      status: BookingRequestStatus.DECLINED,
      reviewedByMemberId: input.adminMemberId,
      reviewedAt,
      declineReason,
    },
  });

  if (claimed.count === 0) {
    throw new BookingRequestError(
      "Only verified or priced booking requests can be declined",
      409
    );
  }

  try {
    await sendBookingRequestDeclinedEmail({
      email: request.contactEmail,
      firstName: request.contactFirstName,
      checkIn: request.checkIn,
      checkOut: request.checkOut,
      reason: declineReason,
    });
  } catch (err) {
    logger.error(
      { err, bookingRequestId: request.id },
      "Failed to send booking request declined email"
    );
  }

  logAudit({
    action: "booking_request.declined",
    memberId: input.adminMemberId,
    actorMemberId: input.adminMemberId,
    targetId: input.requestId,
    entityType: "BookingRequest",
    entityId: input.requestId,
    category: "booking",
    outcome: "success",
    summary: "Booking request declined",
    metadata: { reason: declineReason },
  });

  // #1365 (F18): a declined request that still holds capacity — a held
  // AWAITING_REVIEW booking (a SCHOOL manual hold via `holdBookingRequestSlots`)
  // pointed to by `heldBookingId` — must have that hold released, otherwise the
  // beds stay sterilised forever after the decline. This runs CLAIM-FIRST:
  // strictly AFTER the status-guarded flip above actually claimed the request
  // (count > 0). A wrong-state decline therefore 409s WITHOUT ever touching the
  // hold — in particular a generic QUOTE_SENT held request (auto-hold-on-send,
  // #1280) is NOT in the VERIFIED/PRICED set this route declines, so its hold is
  // left intact for the quote-decline / quote-expiry / "Release hold" paths and
  // never destroyed by a failed decline. The declinable states (VERIFIED/PRICED)
  // have NO sent quote, so there is no requester quote-accept to race: once the
  // request is claimed DECLINED its held booking cannot be converted to a live
  // PENDING booking, so `cancelBooking` here can only ever act on a genuine
  // AWAITING_REVIEW hold (never clobber a just-accepted booking). Releasing
  // reuses the shared `cancelBooking` path (mirroring the admin "Release hold"
  // route): it cancels the held booking, reconciles/frees the beds, detaches
  // `heldBookingId`, and audits. It self-locks on advisory key 1 and runs its
  // own transactions, so it stays OUTSIDE any surrounding transaction — called
  // plainly here. SCHOOL requests use this same function, covered with no type
  // branch.
  if (request.heldBookingId) {
    const held = await prisma.booking.findUnique({
      where: { id: request.heldBookingId },
      select: { id: true, status: true },
    });
    if (held && held.status === BookingStatus.AWAITING_REVIEW) {
      const result = await cancelBooking(
        request.heldBookingId,
        input.adminMemberId,
        "ADMIN",
        input.ipAddress ?? "",
        "card",
        {
          // Admin declining, not the requester cancelling: suppress the
          // requester's "booking cancelled" email. The detach/reconcile/audit in
          // the shared cancel path still run.
          suppressCustomerNotification: true,
          // #1406: defense-in-depth. Today's declinable states (VERIFIED/PRICED)
          // carry no sent quote, so their AWAITING_REVIEW hold can never be
          // converted to a live PENDING booking by a requester accept. Pass the
          // opt-in guard anyway so the shared cancel path refuses (409, no side
          // effect) rather than clobbering a PENDING booking — a prerequisite
          // for broadening decline to QUOTE_SENT (#1423).
          requireRequestHold: true,
        }
      );
      // Defensive: a concurrent cancel of the SAME held booking (a
      // double-submitted decline, or a simultaneous admin "Release hold") won
      // cancelBooking's single-flight (#1160/#1311). The hold is being/has been
      // released either way, so forward the 409. (Unreachable via a quote-accept
      // for VERIFIED/PRICED — those carry no sent quote.)
      if (result.status === 409) {
        throw new BookingRequestError(result.error, 409);
      }
      if (result.status !== 200) {
        logger.error(
          {
            requestId: request.id,
            bookingId: request.heldBookingId,
            error: result.error,
          },
          "Failed to release booking-request hold during decline"
        );
        throw new BookingRequestError(
          "Could not release the booking request's capacity hold",
          result.status
        );
      }
      // Success: cancelBooking cancelled the held booking, reconciled/freed its
      // beds, and detached `heldBookingId` itself.
    } else {
      // The held pointer is stale or the booking is no longer a live hold
      // (already CANCELLED, or gone). Nothing to cancel — just detach the
      // pointer so the declined request stops referencing a dead hold.
      await prisma.bookingRequest.updateMany({
        where: { id: request.id, heldBookingId: request.heldBookingId },
        data: { heldBookingId: null },
      });
    }
  }

  return prisma.bookingRequest.findUnique({ where: { id: input.requestId } });
}

// ---------------------------------------------------------------------------
// Contact mapping (issue #1255)
// ---------------------------------------------------------------------------

/**
 * Non-login organisation/booking-contact roles a converted booking may be
 * owned by. Login-capable members (real people, ORG accounts) are deliberately
 * excluded so a booking request can never be mapped onto an account that can
 * sign in.
 */
export const MAPPABLE_CONTACT_ROLES = [Role.NON_MEMBER, Role.SCHOOL] as const;

/**
 * Validate an admin-selected existing contact to own a converted booking
 * (issue #1255). Enforces the invariant that a public booking request is NEVER
 * mapped onto a login-capable member: only non-login NON_MEMBER/SCHOOL
 * organisation contacts are eligible. Returns the contact id when valid and
 * throws a BookingRequestError otherwise. Runs inside the approval/hold
 * transaction (holding the booking advisory lock) so `canLogin` cannot race the
 * check.
 */
export async function assertMappableOwnerContact(
  tx: Prisma.TransactionClient,
  ownerContactMemberId: string
): Promise<string> {
  const contact = await tx.member.findUnique({
    where: { id: ownerContactMemberId },
    select: { id: true, canLogin: true, role: true, archivedAt: true, active: true },
  });
  if (!contact) {
    throw new BookingRequestError("The selected contact could not be found", 404);
  }
  // GUARD: never attach a booking request to a member that can sign in.
  if (contact.canLogin) {
    throw new BookingRequestError(
      "That member can sign in, so it can't be used as a booking-request contact. Pick an Organisation/School contact or create a new one.",
      422
    );
  }
  if (
    contact.role !== Role.NON_MEMBER &&
    contact.role !== Role.SCHOOL
  ) {
    throw new BookingRequestError(
      "Only Organisation/School booking contacts can be mapped to a request",
      422
    );
  }
  // Align with the suggestion endpoint's scope: an archived or deactivated
  // contact must not be reused.
  if (contact.archivedAt) {
    throw new BookingRequestError(
      "That contact has been archived and can't be reused",
      422
    );
  }
  if (!contact.active) {
    throw new BookingRequestError(
      "That contact is inactive and can't be reused",
      422
    );
  }
  return contact.id;
}

// ---------------------------------------------------------------------------
// Approval conversion
// ---------------------------------------------------------------------------

type ApproveBookingRequestOutcome =
  | {
      type: "approved";
      requestId: string;
      bookingId: string;
      memberId: string;
      priceCents: number;
      paymentLinkExpiresAt: Date;
    }
  | { type: "capacityExceeded"; fullNights: string[] };

function getCapacityFullNights(
  nightDetails: Array<{ date: Date; availableBeds: number }>
): string[] {
  return nightDetails
    .filter((night) => night.availableBeds < 0)
    .map((night) => night.date.toISOString().split("T")[0]);
}

/**
 * Split the officer-set total across the guest rows in integer cents.
 * The remainder goes to the first guest so the rows always sum exactly.
 */
export function splitPriceAcrossGuests(totalCents: number, guestCount: number): number[] {
  if (guestCount <= 0) return [];
  const base = Math.floor(totalCents / guestCount);
  const remainder = totalCents - base * guestCount;
  return Array.from({ length: guestCount }, (_, index) =>
    index === 0 ? base + remainder : base
  );
}

/**
 * Resolve when the booking's non-member hold expires. Member-priority
 * bumping applies until the requester pays. Late approvals still get at
 * least 48 hours to pay, but never beyond check-in.
 */
export function resolveRequestBookingHoldUntil(
  checkIn: Date,
  holdDays: number,
  now: Date = new Date()
): Date {
  const standardHold = new Date(checkIn.getTime() - holdDays * DAY_MS);
  const minimumHold = new Date(now.getTime() + 2 * DAY_MS);
  const hold = standardHold > minimumHold ? standardHold : minimumHold;
  return hold > checkIn ? checkIn : hold;
}

type HeldBookingGuestInput = {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string | null;
  stayStart: Date;
  stayEnd: Date;
  priceCents: number;
};

/**
 * Swap a held booking's guest rows to the accepted/approved guest list while
 * PRESERVING each row's identity (issue #1254). The held booking was created by
 * holdBookingRequestSlots with exactly this guest list in this order, so we
 * update the existing rows in place instead of the old delete-then-recreate.
 * Keeping each `bookingGuest.id` stable preserves everything that cascades off
 * it: an admin's pre-assigned BedAllocation rows (a destructive `deleteMany`
 * would silently drop them via onDelete: Cascade), BookingGuestNight sets
 * (#713), promo guest targets, and chore assignments.
 *
 * The guest list is fixed at request submission, so the counts should always
 * match; if they somehow diverge we fall back to delete+recreate so approval
 * still succeeds (that fallback loses pre-assigned beds but stays correct).
 * Returns whether the identity-preserving path was taken (for audit/tests).
 */
export async function reassignHeldBookingGuests(
  tx: Prisma.TransactionClient,
  bookingId: string,
  guestCreates: HeldBookingGuestInput[]
): Promise<{ preservedInPlace: boolean }> {
  const existing = await tx.bookingGuest.findMany({
    where: { bookingId },
    select: { id: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  if (existing.length !== guestCreates.length) {
    await tx.bookingGuest.deleteMany({ where: { bookingId } });
    if (guestCreates.length > 0) {
      await tx.bookingGuest.createMany({
        data: guestCreates.map((guest) => ({
          bookingId,
          firstName: guest.firstName,
          lastName: guest.lastName,
          ageTier: guest.ageTier,
          isMember: guest.isMember,
          memberId: guest.memberId ?? null,
          stayStart: guest.stayStart,
          stayEnd: guest.stayEnd,
          priceCents: guest.priceCents,
        })),
      });
    }
    return { preservedInPlace: false };
  }

  for (let index = 0; index < guestCreates.length; index += 1) {
    const guest = guestCreates[index];
    await tx.bookingGuest.update({
      where: { id: existing[index].id },
      data: {
        firstName: guest.firstName,
        lastName: guest.lastName,
        ageTier: guest.ageTier,
        isMember: guest.isMember,
        memberId: guest.memberId ?? null,
        stayStart: guest.stayStart,
        stayEnd: guest.stayEnd,
        priceCents: guest.priceCents,
      },
    });
  }
  return { preservedInPlace: true };
}

/**
 * Approve a PRICED request: in a single transaction under the booking
 * advisory lock, create the non-login Member, the PENDING Booking with
 * capacity checking, the PENDING Payment, and the tokenised PaymentLink.
 * The payment link email is sent after commit.
 */
export async function approveBookingRequest(input: {
  requestId: string;
  adminMemberId: string;
  /**
   * Optional existing non-login contact to own the converted booking (issue
   * #1255). When set, the booking is attached to this contact instead of
   * creating a new NON_MEMBER member — reusing its Xero contact downstream. Only
   * honoured when the owner has not already been materialised by a capacity hold
   * (a held booking's owner was fixed at hold time; release + re-hold to change
   * it). Ignored on the held-booking reuse path.
   */
  ownerContactMemberId?: string | null;
}): Promise<ApproveBookingRequestOutcome> {
  const request = await prisma.bookingRequest.findUnique({
    where: { id: input.requestId },
  });
  if (!request) {
    throw new BookingRequestError("Booking request not found", 404);
  }
  if (request.status !== BookingRequestStatus.PRICED) {
    throw new BookingRequestError(
      "Only priced booking requests can be approved",
      409
    );
  }
  if (request.priceCents == null) {
    throw new BookingRequestError(
      "A price must be set before the request can be approved",
      409
    );
  }

  const guests = parseBookingRequestGuests(request.guests);
  const linkedMembers = linkedGuestMemberMap(request.linkedGuestMembers);
  const priceCents = request.priceCents;

  // Non-login members never authenticate; store a random bcrypt hash so the
  // row satisfies the schema without any usable credential.
  const placeholderPasswordHash = await hash(randomBytes(32).toString("hex"), 13);
  const holdDays = await getNonMemberHoldDays(request.checkIn);
  const reviewedAt = new Date();
  const nonMemberHoldUntil = resolveRequestBookingHoldUntil(
    request.checkIn,
    holdDays,
    reviewedAt
  );
  // The payment link stays valid while the booking remains payable; the hard
  // ceiling is the end of the check-in day in NZT (not midnight UTC, which
  // would cut the day short in New Zealand — issue #740). Booking status checks
  // gate actual payment.
  const paymentLinkExpiresAt = endOfDateOnlyForTimeZone(
    formatDateOnly(request.checkIn)
  );
  const { token: paymentToken, tokenHash: paymentTokenHash } = issueActionToken();

  let capacityFullNights: string[] | null = null;
  let conversion: {
    bookingId: string;
    memberId: string;
    ownerSubstitution:
      | { invalidMemberId: string; substituteMemberId: string; reason: string }
      | null;
    alreadyConverted: boolean;
  };

  try {
    conversion = await prisma.$transaction(async (tx) => {
      // Single advisory lock serialises ALL booking creation paths so the
      // capacity check below stays safe (same key as booking-create.ts).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

      // Idempotency (#1232 double-charge guard): a prior approve for this
      // request — a concurrent double-accept, or a retry whose caller re-armed
      // the request to PRICED after it had already converted (line ~729 of
      // booking-request-quotes.ts overwrites CONVERTED->PRICED but never clears
      // convertedBookingId) — already created the booking. Under the advisory
      // lock we now observe its committed convertedBookingId, so return that
      // booking instead of creating a second one.
      const existing = await tx.bookingRequest.findUnique({
        where: { id: request.id },
        select: { convertedBookingId: true, convertedMemberId: true, status: true },
      });
      if (existing?.convertedBookingId && existing.convertedMemberId) {
        if (existing.status !== BookingRequestStatus.CONVERTED) {
          // A caller re-armed the request to PRICED after it had already
          // converted; re-assert the true terminal status (we hold the lock).
          await tx.bookingRequest.update({
            where: { id: request.id },
            data: { status: BookingRequestStatus.CONVERTED },
          });
        }
        return {
          bookingId: existing.convertedBookingId,
          memberId: existing.convertedMemberId,
          ownerSubstitution: null,
          alreadyConverted: true as const,
        };
      }

      // Status-claim so two admins cannot approve concurrently.
      const claimed = await tx.bookingRequest.updateMany({
        where: { id: request.id, status: BookingRequestStatus.PRICED },
        data: {
          status: BookingRequestStatus.APPROVED,
          reviewedByMemberId: input.adminMemberId,
          reviewedAt,
        },
      });
      if (claimed.count === 0) {
        throw new BookingRequestError(
          "This booking request has already been processed",
          409
        );
      }

      const guestPriceCents = splitPriceAcrossGuests(priceCents, guests.length);
      const guestCreates = guests.map((guest, index) => {
        const memberId = linkedMembers.get(index);
        return {
          firstName: guest.firstName,
          lastName: guest.lastName,
          ageTier: guest.ageTier,
          isMember: Boolean(memberId),
          memberId,
          stayStart: request.checkIn,
          stayEnd: request.checkOut,
          priceCents: guestPriceCents[index],
        };
      });
      await assertMembershipTypeBookingAllowed(tx, {
        guests: guestCreates,
        seasonYear: getSeasonYear(request.checkIn),
      });

      // Block admin-mediated double-books: a request whose guests an admin
      // linked to real members must not put a member on overlapping nights
      // (issue #1158, invariant DOMAIN_INVARIANTS.md:35-40). On the reuse path
      // exclude the held booking's own soon-to-be-deleted guests.
      await assertNoBookingMemberNightConflicts(tx, {
        actorMemberId: input.adminMemberId,
        actorRole: "ADMIN",
        checkIn: request.checkIn,
        checkOut: request.checkOut,
        guests: guestCreates,
        excludeBookingId: request.heldBookingId ?? undefined,
      });

      let booking: { id: string };
      let member: { id: string };
      // Set when the held owner failed re-validation at conversion and a fresh
      // contact was substituted (issue #1255 residual-risk decision 1); drives a
      // post-commit admin alert.
      let ownerSubstitution:
        | { invalidMemberId: string; substituteMemberId: string; reason: string }
        | null = null;

      if (request.heldBookingId) {
        const held = await tx.booking.findUnique({
          where: { id: request.heldBookingId },
          select: { id: true, memberId: true, status: true },
        });
        if (!held) {
          throw new BookingRequestError("Held booking was not found", 409);
        }
        if (held.status !== BookingStatus.AWAITING_REVIEW) {
          throw new BookingRequestError("Held booking is no longer available", 409);
        }

        // Re-validate the held owner at conversion (issue #1255 residual-risk
        // decision 1). The owner was materialised earlier (at hold/quote-send).
        // If it had been MAPPED to a pre-existing contact, that contact could
        // have changed state during the quote→accept window (login enabled,
        // archived, deactivated, role changed). If it is no longer a valid
        // non-login booking contact, DO NOT fail the requester's accept: fall
        // back to a fresh non-login contact (the pre-#1255 default owner) and
        // flag an admin. Auto-created owners always pass this guard, so it is a
        // no-op except for a changed-state mapped contact.
        let ownerId = held.memberId;
        try {
          await assertMappableOwnerContact(tx, held.memberId);
        } catch (err) {
          // Only recover from validation failures; a real DB/other error must
          // still abort so we never silently substitute on a transient fault.
          if (!(err instanceof BookingRequestError)) throw err;
          const substitute = await tx.member.create({
            data: {
              email: request.contactEmail,
              passwordHash: placeholderPasswordHash,
              emailVerified: true,
              firstName: request.contactFirstName,
              lastName: request.contactLastName,
              role: "NON_MEMBER",
              ageTier: AgeTier.ADULT,
              active: true,
              canLogin: false,
              phoneNumber: request.contactPhone,
            },
            select: { id: true },
          });
          ownerId = substitute.id;
          ownerSubstitution = {
            invalidMemberId: held.memberId,
            substituteMemberId: substitute.id,
            reason: err.message,
          };
        }

        // Preserve the held booking's beds across the guest swap (issue #1254):
        // update guest rows in place rather than deleteMany+recreate. The date
        // range is unchanged (fixed at request submission), so existing bed
        // allocations remain valid — no reconcile needed.
        await reassignHeldBookingGuests(tx, held.id, guestCreates);
        booking = await tx.booking.update({
          where: { id: held.id },
          data: {
            checkIn: request.checkIn,
            checkOut: request.checkOut,
            // Stays capacity-holding across the accept: AWAITING_REVIEW (holding
            // status) → PENDING, which now holds because it becomes the request's
            // convertedBooking (capacityHoldingBookingFilter, #1254 refining
            // #737). The bed is reserved until payment, expiry, or cancel.
            status: BookingStatus.PENDING,
            totalPriceCents: priceCents,
            finalPriceCents: priceCents,
            hasNonMembers: true,
            nonMemberHoldUntil,
            notes: request.message,
            createdById: input.adminMemberId,
            // Point the held booking at the (possibly substituted) owner. On the
            // no-substitution path this rewrites the same id (a no-op); bed
            // allocations live on guest rows and are unaffected by ownership.
            memberId: ownerId,
          },
          select: { id: true },
        });
        member = { id: ownerId };
      } else {
        const capacityRanges = guests.map(() => ({
          stayStart: request.checkIn,
          stayEnd: request.checkOut,
        }));
        const capacity = await checkCapacityForGuestRanges(
          request.checkIn,
          request.checkOut,
          capacityRanges,
          undefined,
          tx
        );
        if (!capacity.available) {
          capacityFullNights = getCapacityFullNights(capacity.nightDetails);
          throw new Error("CAPACITY_EXCEEDED_SENTINEL");
        }

        if (input.ownerContactMemberId) {
          // Admin mapped this request to an existing non-login Organisation/
          // School contact (issue #1255): attach the booking to it instead of
          // minting a duplicate member (and, downstream, a duplicate Xero
          // contact). The guard rejects any login-capable target.
          const mappedId = await assertMappableOwnerContact(
            tx,
            input.ownerContactMemberId
          );
          member = { id: mappedId };
        } else {
          // Mirror approveMemberApplication(): a non-login member owns the
          // booking. emailVerified is true because the address was verified in
          // the request flow before it entered the queue.
          member = await tx.member.create({
            data: {
              email: request.contactEmail,
              passwordHash: placeholderPasswordHash,
              emailVerified: true,
              firstName: request.contactFirstName,
              lastName: request.contactLastName,
              role: "NON_MEMBER",
              ageTier: AgeTier.ADULT,
              active: true,
              canLogin: false,
              phoneNumber: request.contactPhone,
            },
            select: { id: true },
          });
        }

        booking = await tx.booking.create({
          data: {
            memberId: member.id,
            checkIn: request.checkIn,
            checkOut: request.checkOut,
            status: BookingStatus.PENDING,
            totalPriceCents: priceCents,
            finalPriceCents: priceCents,
            hasNonMembers: true,
            nonMemberHoldUntil,
            notes: request.message,
            createdById: input.adminMemberId,
            guests: {
              create: guestCreates,
            },
          },
          select: { id: true },
        });
      }

      await tx.payment.create({
        data: {
          bookingId: booking.id,
          amountCents: priceCents,
          status: PaymentStatus.PENDING,
        },
      });

      await tx.paymentLink.create({
        data: {
          bookingId: booking.id,
          bookingRequestId: request.id,
          tokenHash: paymentTokenHash,
          expiresAt: paymentLinkExpiresAt,
        },
      });

      await tx.bookingRequest.update({
        where: { id: request.id },
        data: {
          status: BookingRequestStatus.CONVERTED,
          convertedBookingId: booking.id,
          convertedMemberId: member.id,
        },
      });

      return {
        bookingId: booking.id,
        memberId: member.id,
        ownerSubstitution,
        alreadyConverted: false as const,
      };
    });
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === "CAPACITY_EXCEEDED_SENTINEL" &&
      capacityFullNights
    ) {
      return { type: "capacityExceeded", fullNights: capacityFullNights };
    }
    throw err;
  }

  // On the idempotent replay path the tx body was skipped, so no new booking,
  // payment or paymentLink exists: the freshly generated paymentToken was NEVER
  // persisted as a PaymentLink. Guard every side effect on !alreadyConverted so
  // we never re-record the CREATED event, never re-log a conversion, and — most
  // importantly — never email the member a broken (unpersisted) payment link.
  // The working payment email already went out with the first accept.
  if (!conversion.alreadyConverted) {
    await recordBookingEvent({
      bookingId: conversion.bookingId,
      type: BookingEventType.CREATED,
      actorMemberId: input.adminMemberId,
      amountCents: priceCents,
    });

    try {
      await sendBookingRequestApprovedEmail({
        email: request.contactEmail,
        firstName: request.contactFirstName,
        token: paymentToken,
        checkIn: request.checkIn,
        checkOut: request.checkOut,
        guestCount: guests.length,
        priceCents,
        bookingReference: conversion.bookingId,
        expiresAt: paymentLinkExpiresAt,
      });
    } catch (err) {
      logger.error(
        { err, bookingRequestId: request.id, bookingId: conversion.bookingId },
        "Failed to send booking request approved email"
      );
    }

    logAudit({
      action: "booking_request.approved",
      memberId: input.adminMemberId,
      actorMemberId: input.adminMemberId,
      subjectMemberId: conversion.memberId,
      targetId: request.id,
      entityType: "BookingRequest",
      entityId: request.id,
      category: "booking",
      outcome: "success",
      summary: "Booking request approved and converted to booking",
      metadata: {
        bookingId: conversion.bookingId,
        memberId: conversion.memberId,
        priceCents,
        guestCount: guests.length,
        checkIn: request.checkIn.toISOString(),
        checkOut: request.checkOut.toISOString(),
        nonMemberHoldUntil: nonMemberHoldUntil.toISOString(),
        paymentLinkExpiresAt: paymentLinkExpiresAt.toISOString(),
      },
    });

    // The held owner failed re-validation and a fresh contact was substituted
    // (issue #1255 residual-risk decision 1). Surface it for admin follow-up:
    // the booking (and any Xero invoice) now bill the fresh contact rather than
    // the intended mapped organisation, so an admin may need to reconcile the
    // Xero contact. A durable audit row (queryable in the admin audit log) is the
    // attention channel; see the PR body for why this is not an email alert.
    if (conversion.ownerSubstitution) {
      logger.warn(
        {
          bookingRequestId: request.id,
          bookingId: conversion.bookingId,
          invalidMemberId: conversion.ownerSubstitution.invalidMemberId,
          substituteMemberId: conversion.ownerSubstitution.substituteMemberId,
          reason: conversion.ownerSubstitution.reason,
        },
        "Held booking owner was invalid at conversion; substituted a fresh non-login contact"
      );
      logAudit({
        action: "booking_request.owner_substituted",
        memberId: input.adminMemberId,
        actorMemberId: input.adminMemberId,
        subjectMemberId: conversion.memberId,
        targetId: request.id,
        entityType: "BookingRequest",
        entityId: request.id,
        category: "booking",
        outcome: "success",
        summary:
          "Held booking-request owner was no longer a valid non-login contact at conversion; a fresh contact was substituted so the accept could proceed",
        metadata: {
          bookingId: conversion.bookingId,
          requestId: request.id,
          invalidMemberId: conversion.ownerSubstitution.invalidMemberId,
          substituteMemberId: conversion.ownerSubstitution.substituteMemberId,
          reason: conversion.ownerSubstitution.reason,
        },
      });
    }
  } else {
    // Observability-only note that a duplicate accept was absorbed (#1232).
    logAudit({
      action: "booking_request.approve_idempotent_replay",
      memberId: input.adminMemberId,
      actorMemberId: input.adminMemberId,
      targetId: request.id,
      entityType: "BookingRequest",
      entityId: request.id,
      category: "booking",
      outcome: "success",
      summary: "Booking request approve replayed idempotently; no second conversion",
      metadata: { bookingId: conversion.bookingId, requestId: request.id },
    });
  }

  return {
    type: "approved",
    requestId: request.id,
    bookingId: conversion.bookingId,
    memberId: conversion.memberId,
    priceCents,
    paymentLinkExpiresAt,
  };
}

// ---------------------------------------------------------------------------
// Privacy Act retention purge
// ---------------------------------------------------------------------------

/**
 * Permanently delete declined and never-verified requests once the
 * retention window has passed (Privacy Act 2020 — personal information
 * may only be kept while there is a lawful purpose).
 */
export async function purgeExpiredBookingRequests(
  now: Date = new Date(),
  db: Pick<typeof prisma, "bookingRequest"> = prisma
) {
  const cutoff = new Date(now.getTime() - BOOKING_REQUEST_RETENTION_DAYS * DAY_MS);

  const [declined, neverVerified] = await Promise.all([
    db.bookingRequest.deleteMany({
      where: {
        status: BookingRequestStatus.DECLINED,
        updatedAt: { lte: cutoff },
      },
    }),
    db.bookingRequest.deleteMany({
      where: {
        status: BookingRequestStatus.NEW,
        verifiedAt: null,
        createdAt: { lte: cutoff },
      },
    }),
  ]);

  if (declined.count > 0 || neverVerified.count > 0) {
    logAudit({
      action: "booking_request.retention_purge",
      category: "privacy",
      outcome: "success",
      summary: "Expired booking requests purged per retention policy",
      metadata: {
        declinedPurged: declined.count,
        neverVerifiedPurged: neverVerified.count,
        retentionDays: BOOKING_REQUEST_RETENTION_DAYS,
      },
    });
  }

  return {
    declinedPurged: declined.count,
    neverVerifiedPurged: neverVerified.count,
  };
}

// ---------------------------------------------------------------------------
// Admin queue serialisation
// ---------------------------------------------------------------------------

type AdminBookingRequestStatusFilter =
  | BookingRequestStatus
  | "QUEUE"
  | "ALL";

export function buildBookingRequestListWhere(
  filter: AdminBookingRequestStatusFilter
): Prisma.BookingRequestWhereInput | undefined {
  if (filter === "ALL") return undefined;
  if (filter === "QUEUE") {
    return {
      status: {
        in: [
          BookingRequestStatus.VERIFIED,
          BookingRequestStatus.PRICED,
          BookingRequestStatus.QUOTED,
          BookingRequestStatus.QUOTE_SENT,
          BookingRequestStatus.QUERY_PENDING,
          BookingRequestStatus.MODIFICATION_REQUESTED,
        ],
      },
    };
  }
  return { status: filter };
}

function parseAdminTeachers(raw: unknown) {
  const schema = z.array(
    z.object({
      firstName: z.string(),
      lastName: z.string(),
      email: z.string().nullable().optional(),
    })
  );
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

export function serializeBookingRequestForAdmin(request: BookingRequest) {
  return {
    id: request.id,
    type: request.type,
    status: request.status,
    schoolName: request.schoolName,
    teachers: parseAdminTeachers(request.teachers),
    cateringPreference: request.cateringPreference,
    linkedGuestMembers: parseBookingRequestLinkedGuestMembers(
      request.linkedGuestMembers
    ),
    contactFirstName: request.contactFirstName,
    contactLastName: request.contactLastName,
    contactEmail: request.contactEmail,
    contactPhone: request.contactPhone,
    checkIn: request.checkIn.toISOString(),
    checkOut: request.checkOut.toISOString(),
    guests: parseBookingRequestGuests(request.guests),
    message: request.message,
    indicativePriceCents: request.indicativePriceCents,
    priceCents: request.priceCents,
    verifiedAt: request.verifiedAt?.toISOString() ?? null,
    pricedAt: request.pricedAt?.toISOString() ?? null,
    pricedByMemberId: request.pricedByMemberId,
    reviewedAt: request.reviewedAt?.toISOString() ?? null,
    reviewedByMemberId: request.reviewedByMemberId,
    declineReason: request.declineReason,
    convertedBookingId: request.convertedBookingId,
    attendeesConfirmedAt: request.attendeesConfirmedAt?.toISOString() ?? null,
    convertedMemberId: request.convertedMemberId,
    heldBookingId: request.heldBookingId,
    acceptedQuoteId: request.acceptedQuoteId,
    acceptedQuoteOptionId: request.acceptedQuoteOptionId,
    acceptedPriceCents: request.acceptedPriceCents,
    acceptedAt: request.acceptedAt?.toISOString() ?? null,
    responseMessage: request.responseMessage,
    responseMessageAt: request.responseMessageAt?.toISOString() ?? null,
    createdAt: request.createdAt.toISOString(),
  };
}
