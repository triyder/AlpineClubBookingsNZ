import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { isMemberEligibleToBookLodge } from "@/lib/lodge-access";
import { getDefaultLodgeId, lodgeNullTolerantScope } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import {
  calculateBookingHoldDecision,
  isGroupDiscountAppliedToBooking,
  priceDeferredNonMemberPortion,
  toGroupDiscountConfig,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import { getNonMemberHoldPolicy } from "@/lib/cancellation";
import {
  getMembershipTypeBookingPolicyErrorBody,
  MembershipTypeBookingPolicyError,
  priceBookingGuestsWithMembershipTypePolicy,
} from "@/lib/membership-type-policy";
import { getMemberCreditBalance } from "@/lib/member-credit";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { z } from "zod";
import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
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
import { bookingManagementAuthorizationRole } from "@/lib/admin-permissions";
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
  lodgeId: z.string().min(1).optional(),
  guests: z.array(
    z.object({
      ageTier: bookableAgeTierEnum,
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
  // bookings:edit holders (Full Admin, Booking Officer, custom roles) may
  // quote on-behalf — aligned with booking create and the modification path
  // (#1313/#1442).
  const canManageBookings =
    bookingManagementAuthorizationRole(session.user) === "ADMIN";
  const actorRole = bookingManagementAuthorizationRole(session.user);

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

  // A quote with forMemberId must never silently price the caller instead of
  // the target: unauthorized callers are rejected, mirroring create (#1442).
  if (parsed.data.forMemberId) {
    if (!canManageBookings) {
      return NextResponse.json(
        { error: "Only admins can book on behalf of another member" },
        { status: 403 }
      );
    }
    if (parsed.data.forMemberId === session.user.id) {
      return NextResponse.json(
        { error: "Booking managers cannot book for themselves — book your own stay through the member booking page" },
        { status: 400 }
      );
    }
  }
  const isAuthorizedOnBehalf = Boolean(parsed.data.forMemberId);
  const effectiveMemberId = isAuthorizedOnBehalf
    ? parsed.data.forMemberId!
    : session.user.id;

  try {
    const linkedMembers = await resolveLinkedBookingMembers(
      prisma,
      effectiveMemberId,
      rawGuests.map((guest) => guest.memberId),
      { skipAuthorization: isAuthorizedOnBehalf }
    );
    await assertLinkedBookingMembersCanBeBooked(
      prisma,
      linkedMembers,
      session.user.id,
      {
        actorRole,
        onBehalfOfMemberId: isAuthorizedOnBehalf ? effectiveMemberId : null,
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

  // Resolve the lodge being quoted: an explicit lodgeId must be a real,
  // active lodge; otherwise the club's default lodge is quoted.
  let quoteLodgeId: string;
  if (parsed.data.lodgeId) {
    const lodge = await prisma.lodge.findUnique({
      where: { id: parsed.data.lodgeId },
      select: { id: true, active: true },
    });
    if (!lodge || !lodge.active) {
      return NextResponse.json(
        { error: "Unknown or inactive lodgeId" },
        { status: 400 },
      );
    }
    quoteLodgeId = lodge.id;
  } else {
    quoteLodgeId = await getDefaultLodgeId(prisma);
  }

  // A BOOKING_RESTRICTION-ed member must not read a forbidden lodge's pricing.
  // Mirror the create path exactly: admin on-behalf quotes bypass the
  // restriction (the audited override), everyone else is checked.
  if (
    !isAuthorizedOnBehalf &&
    !(await isMemberEligibleToBookLodge(prisma, effectiveMemberId, quoteLodgeId))
  ) {
    return NextResponse.json(
      { error: "This member cannot book the selected lodge." },
      { status: 403 }
    );
  }

  // Duplicate member nights (upstream #80cbdf4c): a member cannot hold two
  // bookings covering the same night.
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
      ...lodgeNullTolerantScope(quoteLodgeId),
    },
    include: { membershipTypeRates: true },
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
    // Deferred non-member "guest portion" (#2003): when a split creates a
    // provisional non-member child, its charge is the non-member SUBSET priced
    // on its own — which the group discount may treat differently than the
    // whole-party quote (the subset can fall under minGroupSize while the party
    // meets it). Price it here through the SAME helper booking-create charges,
    // so the review-step "about $X" banner shows the figure that is actually
    // deferred rather than a whole-party non-member sum that under-quotes under
    // group discounts. Null when the party has no non-member guests. This is a
    // display-only read; the route performs no writes.
    const deferredPortion = await priceDeferredNonMemberPortion(prisma, {
      checkIn,
      checkOut,
      guests,
      seasons: seasonData,
      groupDiscount,
    });
    const deferredGuestPortionCents = deferredPortion?.totalPriceCents ?? null;
    const availableCreditCents = await getMemberCreditBalance(effectiveMemberId);
    const groupDiscountApplied = isGroupDiscountAppliedToBooking({
      checkIn,
      checkOut,
      guestCount: guests.length,
      guests,
      seasons: seasonData,
      groupDiscount,
    });
    const hasNonMembers = guests.some((guest) => !guest.isMember);
    const holdPolicy = hasNonMembers
      ? await getNonMemberHoldPolicy(checkIn)
      : { enabled: false, holdDays: 0, source: "default" as const };
    const holdDecision = calculateBookingHoldDecision({
      hasNonMembers,
      checkIn,
      holdDays: holdPolicy.holdDays,
      holdEnabled: holdPolicy.enabled,
    });

    return NextResponse.json({
      ...price,
      availableCreditCents,
      deferredGuestPortionCents,
      groupDiscountApplied,
      nonMemberHoldDecision: {
        enabled: holdPolicy.enabled,
        holdDays: holdPolicy.holdDays,
        source: holdPolicy.source,
        daysUntilCheckIn: holdDecision.daysUntilCheckIn,
        shouldBePending: holdDecision.shouldBePending,
        status: holdDecision.status,
      },
    });
  } catch (err) {
    if (err instanceof MembershipTypeBookingPolicyError) {
      return NextResponse.json(
        getMembershipTypeBookingPolicyErrorBody(err),
        { status: err.status },
      );
    }
    // #1888 — unexpected (non-typed) errors must not leak their message to
    // the client; the raw error stays in the log only.
    logger.error({ err }, "Booking quote failed");
    return NextResponse.json(
      { error: "Failed to calculate price" },
      { status: 400 }
    );
  }
}
