import { NextRequest, NextResponse } from "next/server";
import { checkLodgeAuth, kioskLodgeAuthErrorResponse, resolveKioskLodgeId } from "@/lib/lodge-auth";
import { addDaysDateOnly, parseDateOnly } from "@/lib/date-only";
import { getBookingGuestDisplayAgeTier } from "@/lib/booking-guests";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import {
  allocateChores,
  ChoreTemplateInput,
  GuestInput,
  ChoreHistoryEntry,
} from "@/lib/chore-allocator";
import { getLodgeCapacity, FALLBACK_LODGE_CAPACITY } from "@/lib/lodge-capacity";
import {
  getActiveGuestsForNight,
  getGuestStayEnd,
  getGuestStayStart,
} from "@/lib/booking-guest-stay-ranges";
import logger from "@/lib/logger";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import { checkinNotBlockedByPendingReviewFilter } from "@/lib/booking-review";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const bodySchema = z.object({
  choreTemplateIds: z.array(z.string().min(1)).min(1),
});

/**
 * POST /api/lodge/roster/[date]/generate
 * Accepts selected choreTemplateIds, runs the allocator, and returns
 * the allocation WITHOUT saving to the database.
 * Used by the hut leader wizard step 3.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const { date: dateStr } = await params;

  const authResult = await checkLodgeAuth(dateStr, { request: req });
  const { error, status, tier } = authResult;
  if (error) {
    return NextResponse.json({ error }, { status: status! });
  }

  // Roster generation requires hut-leader or admin tier
  if (tier !== "admin" && tier !== "hut-leader") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!dateSchema.safeParse(dateStr).success) {
    return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
  }

  const date = parseDateOnly(dateStr);
  if (isNaN(date.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const nextDay = addDaysDateOnly(date, 1);
    const lodgeId = await resolveKioskLodgeId(authResult, prisma);

    // Get guests staying on this date
    const bookings = await prisma.booking.findMany({
      where: {
        status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
        checkIn: { lte: date },
        checkOut: { gt: date },
        ...lodgeNullTolerantScope(lodgeId),
        guests: {
          some: {
            stayStart: { lte: date },
            stayEnd: { gt: date },
          },
        },
        // Don't roster a booking blocked by a pending admin review (#1372 /
        // #1422); it can't check in until an admin clears the review, so it
        // shouldn't get chore assignments.
        ...checkinNotBlockedByPendingReviewFilter(),
      },
      include: {
        guests: {
          where: {
            stayStart: { lte: date },
            stayEnd: { gt: date },
          },
          include: {
            member: {
              select: { ageTier: true },
            },
          },
        },
      },
    });

    const guests: GuestInput[] = bookings.flatMap((b) =>
      getActiveGuestsForNight(b.guests, date, b).map((g) => ({
        id: g.id,
        bookingId: b.id,
        firstName: g.firstName,
        lastName: g.lastName,
        ageTier: getBookingGuestDisplayAgeTier(g),
        isArriving: getGuestStayStart(g, b).getTime() === date.getTime(),
        isDeparting: getGuestStayEnd(g, b).getTime() === nextDay.getTime(),
      }))
    );

    // Get selected chore templates
    const choreTemplates = await prisma.choreTemplate.findMany({
      where: {
        id: { in: parsed.data.choreTemplateIds },
        active: true,
        ...lodgeNullTolerantScope(lodgeId),
      },
      orderBy: { sortOrder: "asc" },
    });

    const templateInputs: ChoreTemplateInput[] = choreTemplates.map((t) => ({
      id: t.id,
      name: t.name,
      recommendedPeopleMin: t.recommendedPeopleMin,
      recommendedPeopleMax: t.recommendedPeopleMax,
      isEssential: t.isEssential,
      ageRestriction: t.ageRestriction,
      minAge: t.minAge,
      sortOrder: t.sortOrder,
      timeOfDay: t.timeOfDay,
      frequencyMode: t.frequencyMode,
      frequencyDays: t.frequencyDays,
      frequencyDaysOfWeek: t.frequencyDaysOfWeek,
    }));

    // 4-day lookback for guest chore history
    const lookbackDate = addDaysDateOnly(date, -4);

    const historyRecords = await prisma.choreAssignment.findMany({
      where: {
        date: { gte: lookbackDate, lt: date },
        bookingGuestId: { in: guests.map((g) => g.id) },
      },
    });

    const history: ChoreHistoryEntry[] = historyRecords
      .filter((h) => h.bookingGuestId !== null)
      .map((h) => ({
        guestId: h.bookingGuestId!,
        choreTemplateId: h.choreTemplateId,
        date: h.date,
      }));

    // #2021 (#1982/#2013 residual): scale per-chore people-counts by this
    // lodge's real resolved sleeping capacity (lodge-scoped), not the fixed
    // display constant. DB read failure or a non-positive resolution keeps the
    // constant fallback so roster generation never breaks.
    let capacity = FALLBACK_LODGE_CAPACITY;
    try {
      const resolved = await getLodgeCapacity(lodgeId);
      if (resolved > 0) capacity = resolved;
    } catch (capacityErr) {
      logger.warn(
        { err: capacityErr, lodgeId },
        "Falling back to default lodge capacity for chore people-count scaling",
      );
    }

    // Run allocator (no frequency filtering since wizard already selected chores)
    const allocations = allocateChores(templateInputs, guests, history, {
      includeNonEssential: true, // wizard explicitly chose chores
      capacity,
    });

    // Return allocations with guest/chore names for display
    const guestMap = new Map(guests.map((g) => [g.id, g]));
    const choreMap = new Map(choreTemplates.map((t) => [t.id, t]));

    const result = allocations.map((a) => {
      const guest = guestMap.get(a.bookingGuestId);
      const chore = choreMap.get(a.choreTemplateId);
      return {
        choreTemplateId: a.choreTemplateId,
        choreTemplateName: chore?.name ?? "Unknown",
        choreTimeOfDay: chore?.timeOfDay ?? "ANYTIME",
        choreSortOrder: chore?.sortOrder ?? 0,
        bookingGuestId: a.bookingGuestId,
        guestName: guest ? `${guest.firstName} ${guest.lastName}` : "Unknown",
        guestAgeTier: guest?.ageTier ?? null,
        bookingId: a.bookingId,
      };
    });

    return NextResponse.json({
      date: dateStr,
      allocations: result,
      guests,
    });
  } catch (err) {
    const denied = kioskLodgeAuthErrorResponse(err);
    if (denied) return denied;
    logger.error({ err }, "Error generating roster");
    return NextResponse.json({ error: "Failed to generate roster" }, { status: 500 });
  }
}
