import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  isGroupDiscountAppliedToBooking,
  toGroupDiscountConfig,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import {
  getMembershipTypeBookingPolicyErrorBody,
  MembershipTypeBookingPolicyError,
  priceBookingGuestsWithMembershipTypePolicy,
} from "@/lib/membership-type-policy";
import { getMemberCreditBalance } from "@/lib/member-credit";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { z } from "zod";
import { ageTierEnum } from "@/lib/age-tier-schema";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  assertLinkedBookingMembersCanBeBooked,
  BookingGuestValidationError,
  getBookingGuestValidationErrorResponse,
  type BookingGuestPricingInput,
  normalizeBookingGuestPricingInputs,
  resolveLinkedBookingMembers,
} from "@/lib/booking-guests";
import {
  BookingGuestStayRangeValidationError,
  type NormalizedBookingGuestStayRange,
  normalizeGuestStayRanges,
} from "@/lib/booking-guest-stay-range-input";
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import {
  authorizationRoleFromAccessRoles,
  hasAdminAccess,
} from "@/lib/access-roles";
import {
  findBookingMemberNightConflicts,
  getBookingMemberNightConflictResponse,
} from "@/lib/booking-member-night-conflicts";

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
});

const quoteSchema = z.object({
  checkIn: dateOnlyString.transform(parseDateOnly),
  checkOut: dateOnlyString.transform(parseDateOnly),
  guests: z.array(
    z.object({
      ageTier: ageTierEnum,
      isMember: z.boolean(),
      memberId: z.string().min(1).optional(),
      stayStart: z.string().optional(),
      stayEnd: z.string().optional(),
      // Explicit included nights for a multi date range stay (issue #713).
      nights: z.array(z.string()).max(370).optional(),
    })
  ).min(1),
  forMemberId: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const rateLimited = await applyRateLimit(rateLimiters.bookingQuery, request);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }
  const isAdmin = hasAdminAccess(session.user);
  const actorRole = authorizationRoleFromAccessRoles(session.user);

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;

  const parsed = quoteSchema.safeParse(json.body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { checkIn, checkOut } = parsed.data;
  const rawGuests: BookingGuestPricingInput[] = parsed.data.guests;
  let guests: Array<BookingGuestPricingInput & NormalizedBookingGuestStayRange>;

  if (checkOut <= checkIn) {
    return NextResponse.json({ error: "Check-out must be after check-in" }, { status: 400 });
  }

  const isAdminOnBehalf =
    isAdmin && Boolean(parsed.data.forMemberId);
  const effectiveMemberId = isAdminOnBehalf
    ? parsed.data.forMemberId!
    : session.user.id;

  try {
    const linkedMembers = await resolveLinkedBookingMembers(
      prisma,
      effectiveMemberId,
      rawGuests.map((guest) => guest.memberId),
      { skipAuthorization: isAdminOnBehalf }
    );
    await assertLinkedBookingMembersCanBeBooked(
      prisma,
      linkedMembers,
      session.user.id,
      {
        actorRole,
        onBehalfOfMemberId: isAdminOnBehalf ? effectiveMemberId : null,
      }
    );
    guests = normalizeGuestStayRanges(
      normalizeBookingGuestPricingInputs(rawGuests, linkedMembers),
      { checkIn, checkOut }
    );
  } catch (error) {
    if (error instanceof BookingGuestValidationError) {
      return NextResponse.json(
        getBookingGuestValidationErrorResponse(error),
        { status: error.status }
      );
    }
    if (error instanceof BookingGuestStayRangeValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const memberNightConflicts = await findBookingMemberNightConflicts(prisma, {
    actorMemberId: session.user.id,
    actorRole,
    checkIn,
    checkOut,
    guests,
  });
  if (memberNightConflicts.length > 0) {
    return NextResponse.json(
      getBookingMemberNightConflictResponse(memberNightConflicts),
      { status: 409 },
    );
  }

  // Fetch seasons that cover the booking dates
  const seasons = await prisma.season.findMany({
    where: {
      active: true,
      startDate: { lte: checkOut },
      endDate: { gte: checkIn },
    },
    include: { rates: true },
  });

  const seasonData = toSeasonRateData(seasons);

  // Load group discount settings
  const gds = await prisma.groupDiscountSetting.findUnique({ where: { id: "default" } });
  const groupDiscount = toGroupDiscountConfig(gds);

  try {
    const price = await priceBookingGuestsWithMembershipTypePolicy(prisma, {
      ownerMemberId: effectiveMemberId,
      checkIn,
      checkOut,
      guests,
      seasons: seasonData,
      groupDiscount,
    });
    const availableCreditCents = await getMemberCreditBalance(effectiveMemberId);
    const groupDiscountApplied = isGroupDiscountAppliedToBooking({
      checkIn,
      checkOut,
      guestCount: guests.length,
      guests,
      seasons: seasonData,
      groupDiscount,
    });

    return NextResponse.json({
      ...price,
      availableCreditCents,
      groupDiscountApplied,
    });
  } catch (err) {
    if (err instanceof MembershipTypeBookingPolicyError) {
      return NextResponse.json(
        getMembershipTypeBookingPolicyErrorBody(err),
        { status: err.status },
      );
    }
    const message = err instanceof Error ? err.message : "Failed to calculate price";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
