/**
 * Shared approval-pipeline core for the public non-member booking request flow
 * (src/lib/booking-request.ts, #707) and the SCHOOL group variant
 * (src/lib/school-booking-request.ts, #709).
 *
 * These two pipelines are deliberately separate — they confirm at different
 * booking statuses, invoice differently, and diverge on capacity re-checks — but
 * several regions of their approval transactions are byte-for-byte identical
 * (jscpd, min-tokens 70). Those exact clones live here so a fix to the idempotency
 * guard, the guest-row build + double-book checks, or the owner-substitution admin
 * alert cannot silently land in one pipeline and miss the other (#1529). Regions
 * that only look similar (the substitute/fresh Member creates, whose role and name
 * fields differ; the surrounding logger.warn/logAudit copy) are left in place.
 *
 * Behaviour-preserving: money stays integer cents, booking dates stay NZ
 * date-only, and every extracted region reproduces its original call sequence
 * and arguments exactly.
 */
import {
  AgeTier,
  BookingRequestStatus,
  Prisma,
  type BookingRequest,
} from "@prisma/client";
import { assertNoBookingMemberNightConflicts } from "@/lib/booking-member-night-conflicts";
import { sendAdminOwnerSubstitutionAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { assertMembershipTypeBookingAllowed } from "@/lib/membership-type-policy";
import { prisma } from "@/lib/prisma";
import { getSeasonYear } from "@/lib/utils";

/** A held booking's owner failed re-validation and a fresh contact was
 * substituted at conversion (issue #1255 residual-risk decision 1). */
export type OwnerSubstitution = {
  invalidMemberId: string;
  substituteMemberId: string;
  reason: string;
};

/**
 * A guest row about to be created (or reassigned in place) on the converted
 * booking. Shared so the guest-build helper and reassignHeldBookingGuests agree
 * on one shape.
 */
export type HeldBookingGuestInput = {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string | null;
  stayStart: Date;
  stayEnd: Date;
  priceCents: number;
};

/** Capacity nights that came back oversubscribed, as NZ date-only strings. */
export function getCapacityFullNights(
  nightDetails: Array<{ date: Date; availableBeds: number }>
): string[] {
  return nightDetails
    .filter((night) => night.availableBeds < 0)
    .map((night) => night.date.toISOString().split("T")[0]);
}

/**
 * Idempotency guard (#1232 double-charge). Under the per-lodge advisory lock —
 * call this AFTER acquireLodgeCapacityLock and BEFORE the status-claim — observe
 * whether a prior approve already converted this request (a concurrent
 * double-accept, or a retry whose caller re-armed the request to PRICED after it
 * had already converted). If so, return the committed booking + owner ids so the
 * caller replays that conversion instead of creating a second booking; when the
 * status had been re-armed away from CONVERTED, re-assert the true terminal
 * status (we hold the lock). Returns null when no prior conversion exists.
 */
export async function claimAlreadyConvertedBookingRequest(
  tx: Prisma.TransactionClient,
  requestId: string
): Promise<{ convertedBookingId: string; convertedMemberId: string } | null> {
  const existing = await tx.bookingRequest.findUnique({
    where: { id: requestId },
    select: { convertedBookingId: true, convertedMemberId: true, status: true },
  });
  if (existing?.convertedBookingId && existing.convertedMemberId) {
    if (existing.status !== BookingRequestStatus.CONVERTED) {
      await tx.bookingRequest.update({
        where: { id: requestId },
        data: { status: BookingRequestStatus.CONVERTED },
      });
    }
    return {
      convertedBookingId: existing.convertedBookingId,
      convertedMemberId: existing.convertedMemberId,
    };
  }
  return null;
}

/**
 * Build the converted booking's guest rows from the request guests + the
 * admin-linked member map + the per-guest price split, then run the two
 * pre-write guards both approval pipelines share:
 *   - membership-type booking policy (assertMembershipTypeBookingAllowed)
 *   - admin-mediated double-book prevention across overlapping nights
 *     (assertNoBookingMemberNightConflicts, #1158 / DOMAIN_INVARIANTS.md:35-40),
 *     excluding the held booking's own soon-to-be-deleted guests on the reuse path.
 * Runs inside the caller's approval transaction (tx holds the advisory lock).
 */
export async function buildApprovalGuestCreates(
  tx: Prisma.TransactionClient,
  params: {
    guests: Array<{ firstName: string; lastName: string; ageTier: AgeTier }>;
    linkedMembers: Map<number, string>;
    guestPriceCents: number[];
    checkIn: Date;
    checkOut: Date;
    adminMemberId: string;
    heldBookingId: string | null;
  }
): Promise<HeldBookingGuestInput[]> {
  const {
    guests,
    linkedMembers,
    guestPriceCents,
    checkIn,
    checkOut,
    adminMemberId,
    heldBookingId,
  } = params;

  const guestCreates = guests.map((guest, index) => {
    const memberId = linkedMembers.get(index);
    return {
      firstName: guest.firstName,
      lastName: guest.lastName,
      ageTier: guest.ageTier,
      isMember: Boolean(memberId),
      memberId,
      stayStart: checkIn,
      stayEnd: checkOut,
      priceCents: guestPriceCents[index],
    };
  });
  await assertMembershipTypeBookingAllowed(tx, {
    guests: guestCreates,
    seasonYear: getSeasonYear(checkIn),
  });

  // Block admin-mediated double-books: a request whose guests an admin
  // linked to real members must not put a member on overlapping nights
  // (issue #1158, invariant DOMAIN_INVARIANTS.md:35-40). On the reuse path
  // exclude the held booking's own soon-to-be-deleted guests.
  await assertNoBookingMemberNightConflicts(tx, {
    actorMemberId: adminMemberId,
    actorRole: "ADMIN",
    checkIn,
    checkOut,
    guests: guestCreates,
    excludeBookingId: heldBookingId ?? undefined,
  });

  return guestCreates;
}

/**
 * Fire-and-forget admin email alert that a held booking's owner was invalid at
 * conversion and a fresh non-login contact was substituted (F20 residual #2 /
 * #1377). Best-effort name lookups run outside the caller's transaction; ids are
 * the source of truth if a name is missing. A failed alert must NOT fail the
 * conversion (the booking is already committed), so it is caught and logged with
 * the caller-supplied message (each pipeline keeps its own log text).
 */
export async function sendOwnerSubstitutionAdminAlert(params: {
  request: Pick<
    BookingRequest,
    | "id"
    | "contactFirstName"
    | "contactLastName"
    | "contactEmail"
    | "checkIn"
    | "checkOut"
  >;
  bookingId: string;
  ownerSubstitution: OwnerSubstitution;
  failureLogMessage: string;
}): Promise<void> {
  const { request, bookingId, ownerSubstitution, failureLogMessage } = params;
  try {
    const [intendedMember, substituteMember] = await Promise.all([
      prisma.member
        .findUnique({
          where: { id: ownerSubstitution.invalidMemberId },
          select: { firstName: true, lastName: true },
        })
        .catch(() => null),
      prisma.member
        .findUnique({
          where: { id: ownerSubstitution.substituteMemberId },
          select: { firstName: true, lastName: true },
        })
        .catch(() => null),
    ]);
    const fullName = (
      member: { firstName?: string | null; lastName?: string | null } | null
    ): string | null => {
      const name = [member?.firstName, member?.lastName]
        .filter((part): part is string => Boolean(part && part.trim()))
        .join(" ")
        .trim();
      return name.length > 0 ? name : null;
    };
    await sendAdminOwnerSubstitutionAlert({
      requestId: request.id,
      bookingId,
      intendedMemberId: ownerSubstitution.invalidMemberId,
      intendedMemberName: fullName(intendedMember),
      substituteMemberId: ownerSubstitution.substituteMemberId,
      substituteMemberName: fullName(substituteMember),
      reason: ownerSubstitution.reason,
      requesterName:
        `${request.contactFirstName} ${request.contactLastName}`.trim(),
      requesterEmail: request.contactEmail,
      checkIn: request.checkIn,
      checkOut: request.checkOut,
    });
  } catch (err) {
    logger.error(
      {
        err,
        bookingRequestId: request.id,
        bookingId,
      },
      failureLogMessage
    );
  }
}
