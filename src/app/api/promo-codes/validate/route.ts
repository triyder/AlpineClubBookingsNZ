import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import {
  lodgeNullTolerantScope,
  resolveOptionalActiveLodgeId,
} from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import {
  type GroupDiscountConfig,
  type SeasonRateData,
} from "@/lib/pricing";
import {
  getMembershipTypeBookingPolicyErrorBody,
  MembershipTypeBookingPolicyError,
  priceBookingGuestsWithMembershipTypePolicy,
} from "@/lib/membership-type-policy";
import {
  validateAndCalculatePromoDiscount,
} from "@/lib/promo";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { parseJsonRequestBody } from "@/lib/api-json";
import { z } from "zod";
import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import { bookingManagementAuthorizationRole } from "@/lib/admin-permissions";
import {
  BookingGuestStayRangeValidationError,
  type NormalizedBookingGuestStayRange,
  normalizeGuestStayRanges,
} from "@/lib/booking-guest-stay-range-input";
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { workPartyWindowOverlapsStay } from "@/lib/work-party";

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
});

const validateSchema = z
  .object({
    code: z.string().min(1).optional(),
    // Work party (working bee) event preview: resolves the event's internal
    // promo server-side; the internal code is never sent to or accepted
    // from the client.
    workPartyEventId: z.string().min(1).optional(),
    checkIn: dateOnlyString.transform(parseDateOnly),
    checkOut: dateOnlyString.transform(parseDateOnly),
    guests: z
      .array(
        z.object({
          ageTier: bookableAgeTierEnum,
          isMember: z.boolean(),
          memberId: z.string().min(1).optional(),
          stayStart: z.string().optional(),
          stayEnd: z.string().optional(),
        })
      )
      .min(1),
    forMemberId: z.string().optional(),
    promoGuestIndexes: z.array(z.number().int().min(0)).optional(),
    // Lodge the booking under quote is for (multi-lodge phase 8): promo
    // lodge restrictions and season pricing validate against this lodge.
    // Omitted resolves to the default lodge, so single-lodge clients keep
    // working unchanged.
    lodgeId: z.string().min(1).optional(),
  })
  .refine((data) => Boolean(data.code) !== Boolean(data.workPartyEventId), {
    message: "Provide either a promo code or a working bee event, not both",
  });

export async function POST(req: NextRequest) {
  const rateLimited = await applyRateLimit(rateLimiters.bookingQuery, req);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const json = await parseJsonRequestBody(req);
  if (!json.ok) return json.response;

  const parsed = validateSchema.safeParse(json.body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { code, checkIn, checkOut } = parsed.data;
  let guests: Array<(typeof parsed.data.guests)[number] & NormalizedBookingGuestStayRange>;
  try {
    guests = normalizeGuestStayRanges(parsed.data.guests, { checkIn, checkOut });
  } catch (error) {
    if (error instanceof BookingGuestStayRangeValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
  // On-behalf promo validation follows the booking create/quote rule (#1442):
  // bookings:edit holders validate against the target member; an unauthorized
  // forMemberId is rejected rather than silently checked against the caller.
  if (
    parsed.data.forMemberId &&
    bookingManagementAuthorizationRole(session.user) !== "ADMIN"
  ) {
    return NextResponse.json(
      { error: "Only admins can book on behalf of another member" },
      { status: 403 }
    );
  }
  const effectiveMemberId = parsed.data.forMemberId ?? session.user.id;

  let promoCode:
    | (Awaited<ReturnType<typeof prisma.promoCode.findUnique>> & {
        assignments: { memberId: string }[];
        lodges: { lodgeId: string }[];
      })
    | null = null;
  let workPartyEvent: { id: string; name: string; discountPercent: number } | null = null;

  if (parsed.data.workPartyEventId) {
    const event = await prisma.workPartyEvent.findUnique({
      where: { id: parsed.data.workPartyEventId },
      include: {
        promoCode: {
          include: {
            assignments: { select: { memberId: true } },
            lodges: { select: { lodgeId: true } },
          },
        },
      },
    });
    if (!event) {
      return NextResponse.json(
        { valid: false, error: "Working bee event not found" },
        { status: 400 }
      );
    }
    if (!event.active || !event.promoCode.active || event.promoCode.archivedAt) {
      return NextResponse.json(
        { valid: false, error: "This working bee event is no longer active" },
        { status: 400 }
      );
    }
    if (!workPartyWindowOverlapsStay(event, checkIn, checkOut)) {
      return NextResponse.json(
        {
          valid: false,
          error: "This working bee event does not overlap your booking dates",
        },
        { status: 400 }
      );
    }
    promoCode = event.promoCode;
    workPartyEvent = {
      id: event.id,
      name: event.name,
      discountPercent: event.discountPercent,
    };
  } else if (code) {
    const normalizedCode = code.toUpperCase().trim();
    const found = await prisma.promoCode.findUnique({
      where: { code: normalizedCode },
      include: {
        assignments: { select: { memberId: true } },
        lodges: { select: { lodgeId: true } },
      },
    });
    // Internal promos (work party events) are system-applied only; a
    // manually entered internal code behaves like a nonexistent one.
    promoCode = found && !found.internal ? found : null;
  }

  const assignedMemberIds = promoCode?.assignments?.length
    ? promoCode.assignments.map((a) => a.memberId)
    : null;

  // Calculate the booking price to determine discount
  const quoteLodgeId = await resolveOptionalActiveLodgeId(
    prisma,
    parsed.data.lodgeId,
  );
  if (!quoteLodgeId) {
    return NextResponse.json(
      { error: "Unknown or inactive lodgeId" },
      { status: 400 },
    );
  }
  const seasons = await prisma.season.findMany({
    where: {
      active: true,
      startDate: { lte: checkOut },
      endDate: { gte: checkIn },
      ...lodgeNullTolerantScope(quoteLodgeId),
    },
    include: { rates: true },
  });

  const seasonData: SeasonRateData[] = seasons.map((s) => ({
    seasonId: s.id,
    startDate: s.startDate,
    endDate: s.endDate,
    type: s.type,
    rates: s.rates.map((r) => ({
      ageTier: r.ageTier,
      isMember: r.isMember,
      pricePerNightCents: r.pricePerNightCents,
    })),
  }));

  let groupDiscount: GroupDiscountConfig | undefined;
  const gds = await prisma.groupDiscountSetting.findUnique({
    where: { id: "default" },
  });
  if (gds?.enabled) {
    groupDiscount = {
      minGroupSize: gds.minGroupSize,
      summerOnly: gds.summerOnly,
      enabled: true,
    };
  }

  try {
    const price = await priceBookingGuestsWithMembershipTypePolicy(prisma, {
      ownerMemberId: effectiveMemberId,
      checkIn,
      checkOut,
      guests,
      seasons: seasonData,
      groupDiscount,
    });

    const promoGuests = price.guests.map((g, index) => ({
      memberId: guests[index].memberId ?? null,
      isMember: g.isMember,
      perNightRates: g.perNightCents,
      nightDates: g.nightDates,
      // Dates the positional rates so internal work-party promos restrict
      // the discount to the event's night window.
      firstNight: guests[index].stayStart ?? checkIn,
    }));

    const application = await validateAndCalculatePromoDiscount(
      promoCode,
      {
        memberId: effectiveMemberId,
        bookingCheckIn: checkIn,
        totalPriceCents: price.totalPriceCents,
        guests: promoGuests,
      },
      assignedMemberIds,
      { db: prisma, selectedGuestIndexes: parsed.data.promoGuestIndexes, lodgeId: quoteLodgeId }
    );
    if (application.requiresGuestSelection) {
      return NextResponse.json({
        valid: false,
        requiresGuestSelection: true,
        error: application.error,
        code: promoCode!.code,
        description: promoCode!.description,
        type: promoCode!.type,
        selectableGuestIndexes: application.selectableGuestIndexes ?? [],
      });
    }
    if (application.error || !application.discount) {
      return NextResponse.json(
        { valid: false, error: application.error ?? "Promo code could not be applied" },
        { status: 400 }
      );
    }
    const promoResult = application.discount;

    return NextResponse.json({
      valid: true,
      // Never expose the internal code for work-party validations; the
      // client identifies the discount by the event instead.
      code: workPartyEvent ? null : promoCode!.code,
      description: workPartyEvent ? null : promoCode!.description,
      type: promoCode!.type,
      workPartyEvent,
      discountCents: promoResult.discountCents,
      promoAdjustmentCents: promoResult.priceAdjustmentCents,
      freeNightsUsed: promoResult.freeNightsUsed,
      eligibleGuestCount: promoResult.eligibleGuestCount,
      remainingFreeNights: application.remainingFreeNights,
      selectedGuestIndexes: application.selectedGuestIndexes,
      totalPriceCents: price.totalPriceCents,
      finalPriceCents: price.totalPriceCents + promoResult.priceAdjustmentCents,
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
    logger.error({ err }, "Promo code validation failed");
    return NextResponse.json(
      { error: "Failed to calculate price" },
      { status: 400 }
    );
  }
}
