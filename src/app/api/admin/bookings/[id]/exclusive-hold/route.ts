import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { createAuditLog, getAuditRequestContext } from "@/lib/audit";
import { findOverlappingCapacityHoldingBookings } from "@/lib/capacity";
import logger from "@/lib/logger";
import { z } from "zod";

const exclusiveHoldSchema = z.object({
  hold: z.boolean(),
});

/**
 * POST /api/admin/bookings/[id]/exclusive-hold — set/clear the exclusive
 * whole-lodge hold on ANY booking (issue #121, ADR-001).
 *
 * The hold (`Booking.wholeLodgeHold`) reserves the whole lodge and hard-blocks
 * new admissions on the booking's nights (the capacity side of the rule lives
 * in #118). This route only writes the authoritative flag + who/when audit
 * fields; it is the admin entry point that complements the school request path.
 *
 * ADR-001 decision 1: setting a hold has NO empty-lodge precondition — it is
 * allowed regardless of existing overlapping bookings, and NO capacity engine
 * runs here. Conflicts are surfaced and resolved by the officer, never
 * auto-displaced. Authorisation mirrors the sibling capacity-hold route
 * (requireAdmin: admin/full-admin); both set and clear are audited.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id: bookingId } = await params;

  const body = await request.json().catch(() => ({}));
  const parsed = exclusiveHoldSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }
  const { hold } = parsed.data;
  const auditRequest = getAuditRequestContext(request);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        select: {
          id: true,
          memberId: true,
          lodgeId: true,
          status: true,
          deletedAt: true,
          checkIn: true,
          checkOut: true,
          wholeLodgeHold: true,
          wholeLodgeHoldAt: true,
          wholeLodgeHoldByMemberId: true,
        },
      });
      if (!booking || booking.deletedAt) {
        return { error: "Booking not found", status: 404 as const };
      }

      if (hold && booking.wholeLodgeHold) {
        return {
          error: "This booking already has an exclusive whole-lodge hold.",
          status: 409 as const,
        };
      }
      if (!hold && !booking.wholeLodgeHold) {
        return {
          error: "This booking has no exclusive whole-lodge hold to clear.",
          status: 409 as const,
        };
      }

      // No capacity engine (ADR-001 decision 1): the hold is settable over
      // existing overlapping bookings. Mirror capacity-hold's clear semantics —
      // null the who/when audit columns when clearing.
      const updated = await tx.booking.update({
        where: { id: booking.id },
        data: hold
          ? {
              wholeLodgeHold: true,
              wholeLodgeHoldAt: new Date(),
              wholeLodgeHoldByMemberId: session.user.id,
            }
          : {
              wholeLodgeHold: false,
              wholeLodgeHoldAt: null,
              wholeLodgeHoldByMemberId: null,
            },
        select: { wholeLodgeHold: true, wholeLodgeHoldAt: true },
      });

      // ADR-001 decision 1 conflict surfacing (issue #119): when SETTING the
      // hold, list the existing capacity-holding bookings that overlap its
      // nights so the officer sees the clash. Read-only and informational —
      // the set already succeeded above; nothing is refused or displaced. Never
      // runs the capacity engine (decision 1). On clear there is nothing to
      // surface. lodgeId is NOT NULL for real bookings; guard defensively.
      const conflicts =
        hold && booking.lodgeId
          ? await findOverlappingCapacityHoldingBookings(tx, {
              lodgeId: booking.lodgeId,
              checkIn: booking.checkIn,
              checkOut: booking.checkOut,
              excludeBookingId: booking.id,
            })
          : [];

      await createAuditLog(
        {
          action: hold
            ? "booking.exclusiveHold.set"
            : "booking.exclusiveHold.cleared",
          memberId: session.user.id,
          actorMemberId: session.user.id,
          subjectMemberId: booking.memberId,
          targetId: booking.id,
          entityType: "Booking",
          entityId: booking.id,
          category: "booking",
          severity: "important",
          outcome: "success",
          summary: hold
            ? "Exclusive whole-lodge hold set"
            : "Exclusive whole-lodge hold cleared",
          details: hold
            ? "Admin set the exclusive whole-lodge hold on a booking; the lodge is reserved for sole occupancy and new admissions are blocked on its nights."
            : "Admin cleared the exclusive whole-lodge hold on a booking; the lodge is no longer reserved for sole occupancy.",
          metadata: {
            bookingStatus: booking.status,
            hold,
            checkIn: booking.checkIn.toISOString(),
            checkOut: booking.checkOut.toISOString(),
            ...(hold
              ? {
                  // Conflict surfacing (issue #119): record how many existing
                  // overlapping capacity-holding bookings the officer must
                  // resolve, plus their ids for the audit trail.
                  overlappingConflictCount: conflicts.length,
                  overlappingConflictBookingIds: conflicts.map((c) => c.id),
                }
              : {
                  previouslyHeldAt: booking.wholeLodgeHoldAt?.toISOString() ?? null,
                  previouslyHeldByMemberId: booking.wholeLodgeHoldByMemberId,
                }),
          },
          requestId: auditRequest?.id,
          ipAddress: auditRequest?.ipAddress,
          userAgent: auditRequest?.userAgent,
        },
        tx,
      );

      return {
        success: true as const,
        wholeLodgeHold: updated.wholeLodgeHold,
        wholeLodgeHoldAt: updated.wholeLodgeHoldAt,
        conflicts,
      };
    });

    if ("error" in result) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      );
    }

    return NextResponse.json({
      success: true,
      wholeLodgeHold: result.wholeLodgeHold,
      wholeLodgeHoldAt: result.wholeLodgeHoldAt,
      // Overlapping capacity-holding bookings the officer should resolve
      // (issue #119); empty on clear or when the held nights are clear.
      conflicts: result.conflicts,
    });
  } catch (err) {
    logger.error({ err, bookingId }, "Failed to update exclusive whole-lodge hold");
    return NextResponse.json(
      { error: "Failed to update exclusive whole-lodge hold" },
      { status: 500 },
    );
  }
}
