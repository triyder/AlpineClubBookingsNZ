/**
 * School group booking request variant (issue #709).
 *
 * Built on the #707 `BookingRequest` infrastructure rather than a parallel
 * intake: a SCHOOL request reuses the same email-verification step and admin
 * queue. The differences live here.
 *
 * Locked decisions:
 *   - The booking confirms at approval (CONFIRMED, capacity held) and flips to
 *     PAID when the Xero invoice is paid. CONFIRMED holds capacity via
 *     CAPACITY_HOLDING_BOOKING_STATUSES (src/lib/booking-status.ts).
 *   - The school is the invoiced party / Xero contact. The booking is owned by
 *     a non-login Member named after the school (canLogin: false), mirroring
 *     the xero-member-import pattern. The teacher(s) become separate non-login
 *     Members with a HutLeaderAssignment and PIN email.
 *   - Pay-on-account uses the existing INTERNET_BANKING payment source so the
 *     existing line-item builder emails the invoice and the existing inbound
 *     reconciliation marks the booking PAID when the invoice is paid. No new
 *     tax logic is introduced.
 *
 * Conventions: money stays integer cents, booking dates stay NZ date-only,
 * only SHA-256 token hashes are stored, and external calls (email, Xero outbox)
 * run after the transaction commits.
 */
import { randomBytes } from "crypto";
import { hash } from "bcryptjs";
import {
  AgeTier,
  BookingRequestStatus,
  BookingRequestType,
  BookingStatus,
  PaymentSource,
  PaymentStatus,
  Prisma,
  SchoolCateringPreference,
} from "@prisma/client";
import { z } from "zod";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import { issueActionToken } from "@/lib/action-tokens";
import { logAudit } from "@/lib/audit";
import {
  BOOKING_REQUEST_VERIFICATION_TTL_MS,
  BookingRequestError,
  linkedGuestMemberMap,
  parseBookingRequestGuests,
  splitPriceAcrossGuests,
  type BookingRequestGuest,
} from "@/lib/booking-request";
import { buildInternetBankingPaymentReference } from "@/lib/booking-payment-methods";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import {
  sendAdminSchoolManualInvoiceEmail,
  sendBookingRequestVerificationEmail,
  sendHutLeaderAssignmentEmail,
} from "@/lib/email";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
import { generateHutLeaderPin, hashHutLeaderPin } from "@/lib/lodge-pin-session";
import logger from "@/lib/logger";
import {
  priceBookingGuests,
  toGroupDiscountConfig,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import type { PriceBreakdown } from "@/lib/policies/pricing";
import { prisma } from "@/lib/prisma";
import {
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { nameField } from "@/lib/zod-helpers";

/** Age tiers a school can request counts for. Teachers are always ADULT. */
export const SCHOOL_CHILD_TIERS = [
  AgeTier.INFANT,
  AgeTier.CHILD,
  AgeTier.YOUTH,
] as const;

/** Display name prefix for the generated bulk child guests. */
export const SCHOOL_CHILD_NAME_PREFIX = "School Child";

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export const schoolTeacherSchema = z.object({
  firstName: nameField(),
  lastName: nameField(),
  // PIN email goes here when present; otherwise it falls back to the school
  // contact email at approval time.
  email: z.string().email().max(200).optional().nullable(),
});

export type SchoolTeacherInput = z.infer<typeof schoolTeacherSchema>;

export const schoolChildCountsSchema = z.object({
  INFANT: z.number().int().min(0).max(200).optional(),
  CHILD: z.number().int().min(0).max(200).optional(),
  YOUTH: z.number().int().min(0).max(200).optional(),
});

export type SchoolChildCounts = z.infer<typeof schoolChildCountsSchema>;

export interface CreateSchoolBookingRequestInput {
  schoolName: string;
  contactFirstName: string;
  contactLastName: string;
  contactEmail: string;
  contactPhone?: string | null;
  checkIn: Date;
  checkOut: Date;
  teachers: SchoolTeacherInput[];
  childCounts: SchoolChildCounts;
  cateringPreference: SchoolCateringPreference;
  message?: string | null;
}

interface StoredTeacher {
  firstName: string;
  lastName: string;
  email: string | null;
}

// ---------------------------------------------------------------------------
// Small helpers (kept local to avoid cross-module coupling)
// ---------------------------------------------------------------------------

function cleanString(value?: string | null) {
  return value?.replace(/[\r\n]/g, " ").trim() || "";
}

function cleanNullableString(value?: string | null) {
  return cleanString(value) || null;
}

function getCapacityFullNights(
  nightDetails: Array<{ date: Date; availableBeds: number }>
): string[] {
  return nightDetails
    .filter((night) => night.availableBeds < 0)
    .map((night) => night.date.toISOString().split("T")[0]);
}

/**
 * Build the bulk guest list: teachers as named ADULT guests, then children
 * numbered "School Child 1..N" across the requested age tiers.
 */
export function generateSchoolGuests(input: {
  teachers: Array<{ firstName: string; lastName: string }>;
  childCounts: SchoolChildCounts;
}): BookingRequestGuest[] {
  const teacherGuests: BookingRequestGuest[] = input.teachers.map((teacher) => ({
    firstName: teacher.firstName,
    lastName: teacher.lastName,
    ageTier: AgeTier.ADULT,
  }));

  const childGuests: BookingRequestGuest[] = [];
  let childNumber = 0;
  for (const tier of SCHOOL_CHILD_TIERS) {
    const count = input.childCounts[tier] ?? 0;
    for (let i = 0; i < count; i += 1) {
      childNumber += 1;
      childGuests.push({
        firstName: SCHOOL_CHILD_NAME_PREFIX,
        lastName: String(childNumber),
        ageTier: tier,
      });
    }
  }

  return [...teacherGuests, ...childGuests];
}

export function parseSchoolTeachers(raw: unknown): StoredTeacher[] {
  const parsed = z.array(schoolTeacherSchema).safeParse(raw);
  if (!parsed.success) {
    throw new BookingRequestError("Stored school teachers are invalid", 500);
  }
  return parsed.data.map((teacher) => ({
    firstName: teacher.firstName,
    lastName: teacher.lastName,
    email: teacher.email ? teacher.email.toLowerCase() : null,
  }));
}

// ---------------------------------------------------------------------------
// Pricing (non-member rates + group discount where eligible)
// ---------------------------------------------------------------------------

/**
 * Price the school guest list at non-member rates, applying the group discount
 * per GroupDiscountSetting where eligible. Returns null when no active season
 * covers the dates (so the officer must price manually before approving).
 */
async function priceSchoolGuests(input: {
  checkIn: Date;
  checkOut: Date;
  guests: Array<{ ageTier: AgeTier }>;
}): Promise<PriceBreakdown | null> {
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

  const groupDiscountSetting = await prisma.groupDiscountSetting.findUnique({
    where: { id: "default" },
  });

  return priceBookingGuests({
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    guests: input.guests.map((guest) => ({
      ageTier: guest.ageTier,
      isMember: false,
    })),
    seasons: toSeasonRateData(seasons),
    groupDiscount: toGroupDiscountConfig(groupDiscountSetting),
  });
}

export async function calculateSchoolIndicativePriceCents(input: {
  checkIn: Date;
  checkOut: Date;
  guests: Array<{ ageTier: AgeTier }>;
}): Promise<number | null> {
  const price = await priceSchoolGuests(input);
  return price ? price.totalPriceCents : null;
}

// ---------------------------------------------------------------------------
// Public submission
// ---------------------------------------------------------------------------

/**
 * Create a NEW SCHOOL booking request and email the contact a verification
 * link. The request only enters the admin queue once the email is verified
 * (inherited from #707 via verifyBookingRequest).
 */
export async function createSchoolBookingRequest(
  input: CreateSchoolBookingRequestInput
) {
  const schoolName = cleanString(input.schoolName);
  const contactEmail = cleanString(input.contactEmail).toLowerCase();
  const contactFirstName = cleanString(input.contactFirstName);
  const contactLastName = cleanString(input.contactLastName);

  if (!schoolName) {
    throw new BookingRequestError("School name is required", 422);
  }
  if (!contactFirstName || !contactLastName || !contactEmail) {
    throw new BookingRequestError("Contact name and email are required", 422);
  }

  const teachers: StoredTeacher[] = input.teachers
    .map((teacher) => ({
      firstName: cleanString(teacher.firstName),
      lastName: cleanString(teacher.lastName),
      email: teacher.email ? cleanString(teacher.email).toLowerCase() : null,
    }))
    .filter((teacher) => teacher.firstName && teacher.lastName);

  if (teachers.length === 0) {
    throw new BookingRequestError(
      "At least one teacher attending is required",
      422
    );
  }

  const guests = generateSchoolGuests({ teachers, childCounts: input.childCounts });
  if (guests.length === 0) {
    throw new BookingRequestError("At least one guest is required", 422);
  }

  const lodgeCapacity = await getLodgeCapacity();
  if (guests.length > lodgeCapacity) {
    throw new BookingRequestError(
      `A school booking cannot exceed the lodge capacity of ${lodgeCapacity} guests`,
      422
    );
  }

  const indicativePriceCents = await calculateSchoolIndicativePriceCents({
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    guests,
  });

  const { token, tokenHash } = issueActionToken();
  const verificationTokenExpiresAt = new Date(
    Date.now() + BOOKING_REQUEST_VERIFICATION_TTL_MS
  );

  const request = await prisma.bookingRequest.create({
    data: {
      type: BookingRequestType.SCHOOL,
      schoolName,
      teachers: teachers as unknown as Prisma.InputJsonValue,
      cateringPreference: input.cateringPreference,
      contactFirstName,
      contactLastName,
      contactEmail,
      contactPhone: cleanNullableString(input.contactPhone),
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      guests,
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
      guestCount: guests.length,
      expiresAt: verificationTokenExpiresAt,
    });
  } catch (err) {
    logger.error(
      { err, bookingRequestId: request.id },
      "Failed to send school booking request verification email"
    );
  }

  logAudit({
    action: "booking_request.school_submitted",
    targetId: request.id,
    entityType: "BookingRequest",
    entityId: request.id,
    category: "booking",
    outcome: "success",
    summary: "School booking request submitted",
    metadata: {
      schoolName,
      checkIn: input.checkIn.toISOString(),
      checkOut: input.checkOut.toISOString(),
      guestCount: guests.length,
      teacherCount: teachers.length,
      indicativePriceCents,
    },
  });

  return request;
}

// ---------------------------------------------------------------------------
// Approval conversion
// ---------------------------------------------------------------------------

export type ApproveSchoolBookingRequestOutcome =
  | {
      type: "approved";
      requestId: string;
      bookingId: string;
      schoolMemberId: string;
      priceCents: number;
      invoiceMode: "xero" | "manual";
      teacherCount: number;
    }
  | { type: "capacityExceeded"; fullNights: string[] };

interface TeacherCreationPlan {
  teacher: StoredTeacher;
  email: string;
  pin: string;
  hutLeaderPin: string;
}

/**
 * Approve a verified (or priced) SCHOOL request. In a single transaction under
 * the booking advisory lock: create the non-login school Member, a CONFIRMED
 * Booking that holds capacity, a PENDING INTERNET_BANKING Payment, the bulk
 * guests, and a non-login Member + HutLeaderAssignment per teacher. After the
 * commit, queue the Xero invoice (emailed to the school) or, when the Xero
 * module is off, notify admins to invoice manually; PIN emails are sent to the
 * teachers.
 */
export async function approveSchoolBookingRequest(input: {
  requestId: string;
  adminMemberId: string;
}): Promise<ApproveSchoolBookingRequestOutcome> {
  const request = await prisma.bookingRequest.findUnique({
    where: { id: input.requestId },
  });
  if (!request) {
    throw new BookingRequestError("Booking request not found", 404);
  }
  if (request.type !== BookingRequestType.SCHOOL) {
    throw new BookingRequestError("This is not a school booking request", 400);
  }
  if (
    request.status !== BookingRequestStatus.VERIFIED &&
    request.status !== BookingRequestStatus.PRICED
  ) {
    throw new BookingRequestError(
      "Only verified school booking requests can be approved",
      409
    );
  }

  const guests = parseBookingRequestGuests(request.guests);
  const teachers = parseSchoolTeachers(request.teachers);
  const linkedMembers = linkedGuestMemberMap(request.linkedGuestMembers);
  const schoolName =
    request.schoolName ?? `${request.contactFirstName} ${request.contactLastName}`;

  // Resolve the total and the per-guest split. An officer-set price overrides
  // the computed price and is split evenly; otherwise per-guest engine prices
  // (which reflect tier rates and the group discount) drive accurate invoice
  // line items.
  const price = await priceSchoolGuests({
    checkIn: request.checkIn,
    checkOut: request.checkOut,
    guests,
  });

  let totalPriceCents: number;
  let guestPriceCents: number[];
  if (request.priceCents != null) {
    totalPriceCents = request.priceCents;
    guestPriceCents = splitPriceAcrossGuests(totalPriceCents, guests.length);
  } else if (price && price.guests.length === guests.length) {
    totalPriceCents = price.totalPriceCents;
    guestPriceCents = price.guests.map((guest) => guest.priceCents);
  } else if (price) {
    totalPriceCents = price.totalPriceCents;
    guestPriceCents = splitPriceAcrossGuests(totalPriceCents, guests.length);
  } else {
    throw new BookingRequestError(
      "Cannot price this school booking: no active season covers the requested dates. Set a price before approving.",
      409
    );
  }

  // Non-login members never authenticate; store a random bcrypt hash so the
  // row satisfies the schema without any usable credential. Generate teacher
  // PINs (and their hashes) before the transaction so the plaintext PIN can be
  // emailed after commit while only the hash is persisted.
  const placeholderPasswordHash = await hash(randomBytes(32).toString("hex"), 13);
  const teacherPlans: TeacherCreationPlan[] = await Promise.all(
    teachers.map(async (teacher) => {
      const pin = generateHutLeaderPin();
      return {
        teacher,
        email: teacher.email || request.contactEmail,
        pin,
        hutLeaderPin: await hashHutLeaderPin(pin),
      };
    })
  );

  const reviewedAt = new Date();

  let capacityFullNights: string[] | null = null;
  let conversion: {
    bookingId: string;
    schoolMemberId: string;
    teacherAssignments: Array<{
      memberId: string;
      email: string;
      firstName: string;
      pin: string;
    }>;
  };

  try {
    conversion = await prisma.$transaction(async (tx) => {
      // Single advisory lock serialises all booking creation paths so the
      // capacity check below stays safe (same key as booking-create.ts).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

      // Status-claim so two admins cannot approve concurrently.
      const claimed = await tx.bookingRequest.updateMany({
        where: {
          id: request.id,
          status: {
            in: [BookingRequestStatus.VERIFIED, BookingRequestStatus.PRICED],
          },
        },
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

      let booking: { id: string };
      let schoolMember: { id: string };

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

        await tx.bookingGuest.deleteMany({ where: { bookingId: held.id } });
        booking = await tx.booking.update({
          where: { id: held.id },
          data: {
            checkIn: request.checkIn,
            checkOut: request.checkOut,
            status: BookingStatus.CONFIRMED,
            totalPriceCents,
            finalPriceCents: totalPriceCents,
            hasNonMembers: true,
            notes: request.message,
            createdById: input.adminMemberId,
            guests: { create: guestCreates },
          },
          select: { id: true },
        });
        schoolMember = { id: held.memberId };
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

        // The school is the invoiced party and Xero contact: name = school,
        // email = contact email. Owned by a non-login Member (canLogin: false).
        schoolMember = await tx.member.create({
          data: {
            email: request.contactEmail,
            passwordHash: placeholderPasswordHash,
            emailVerified: true,
            firstName: schoolName.slice(0, 100),
            lastName: "",
            role: "MEMBER",
            ageTier: AgeTier.ADULT,
            active: true,
            canLogin: false,
            phoneNumber: request.contactPhone,
          },
          select: { id: true },
        });

        // CONFIRMED holds capacity (issue #709 locked decision); pay-on-account
        // via INTERNET_BANKING so the existing invoice/reconciliation path runs.
        booking = await tx.booking.create({
          data: {
            memberId: schoolMember.id,
            checkIn: request.checkIn,
            checkOut: request.checkOut,
            status: BookingStatus.CONFIRMED,
            totalPriceCents,
            finalPriceCents: totalPriceCents,
            hasNonMembers: true,
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
          amountCents: totalPriceCents,
          status: PaymentStatus.PENDING,
          source: PaymentSource.INTERNET_BANKING,
          reference: buildInternetBankingPaymentReference(booking.id),
        },
      });

      const teacherAssignments: Array<{
        memberId: string;
        email: string;
        firstName: string;
        pin: string;
      }> = [];
      for (const plan of teacherPlans) {
        const teacherMember = await tx.member.create({
          data: {
            email: plan.email,
            passwordHash: placeholderPasswordHash,
            emailVerified: true,
            firstName: plan.teacher.firstName.slice(0, 100),
            lastName: plan.teacher.lastName.slice(0, 100),
            role: "MEMBER",
            ageTier: AgeTier.ADULT,
            active: true,
            canLogin: false,
          },
          select: { id: true, firstName: true, email: true },
        });

        await tx.hutLeaderAssignment.create({
          data: {
            memberId: teacherMember.id,
            startDate: request.checkIn,
            endDate: request.checkOut,
            hutLeaderPin: plan.hutLeaderPin,
          },
        });

        teacherAssignments.push({
          memberId: teacherMember.id,
          email: teacherMember.email,
          firstName: teacherMember.firstName,
          pin: plan.pin,
        });
      }

      await tx.bookingRequest.update({
        where: { id: request.id },
        data: {
          status: BookingRequestStatus.CONVERTED,
          convertedBookingId: booking.id,
          convertedMemberId: schoolMember.id,
        },
      });

      return {
        bookingId: booking.id,
        schoolMemberId: schoolMember.id,
        teacherAssignments,
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

  // Teacher PIN emails (after commit; failures are logged, not fatal).
  for (const assignment of conversion.teacherAssignments) {
    sendHutLeaderAssignmentEmail({
      email: assignment.email,
      firstName: assignment.firstName,
      startDate: request.checkIn,
      endDate: request.checkOut,
      pin: assignment.pin,
    }).catch((err) =>
      logger.error(
        { err, bookingId: conversion.bookingId, memberId: assignment.memberId },
        "Failed to send hut leader assignment email for school teacher"
      )
    );
  }

  // Raise + email the Xero invoice via the existing outbox, or notify admins to
  // invoice manually when the Xero module is off (issue #709 requirement 6).
  let invoiceMode: "xero" | "manual" = "manual";
  if (await isEffectiveModuleEnabled("xeroIntegration")) {
    invoiceMode = "xero";
    try {
      const queued = await enqueueXeroBookingInvoiceOperation(conversion.bookingId, {
        createdByMemberId: input.adminMemberId,
      });
      if (queued.queueOperationId) {
        await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
      }
    } catch (err) {
      logger.error(
        { err, bookingId: conversion.bookingId },
        "Failed to queue Xero invoice for school booking"
      );
    }
  } else {
    sendAdminSchoolManualInvoiceEmail({
      schoolName,
      contactEmail: request.contactEmail,
      checkIn: request.checkIn,
      checkOut: request.checkOut,
      guestCount: guests.length,
      totalCents: totalPriceCents,
    }).catch((err) =>
      logger.error(
        { err, bookingId: conversion.bookingId },
        "Failed to send school manual-invoice admin notification"
      )
    );
  }

  logAudit({
    action: "booking_request.school_approved",
    memberId: input.adminMemberId,
    actorMemberId: input.adminMemberId,
    subjectMemberId: conversion.schoolMemberId,
    targetId: request.id,
    entityType: "BookingRequest",
    entityId: request.id,
    category: "booking",
    outcome: "success",
    summary: "School booking request approved and confirmed",
    metadata: {
      schoolName,
      bookingId: conversion.bookingId,
      schoolMemberId: conversion.schoolMemberId,
      priceCents: totalPriceCents,
      guestCount: guests.length,
      teacherCount: conversion.teacherAssignments.length,
      invoiceMode,
      checkIn: request.checkIn.toISOString(),
      checkOut: request.checkOut.toISOString(),
    },
  });

  return {
    type: "approved",
    requestId: request.id,
    bookingId: conversion.bookingId,
    schoolMemberId: conversion.schoolMemberId,
    priceCents: totalPriceCents,
    invoiceMode,
    teacherCount: conversion.teacherAssignments.length,
  };
}
