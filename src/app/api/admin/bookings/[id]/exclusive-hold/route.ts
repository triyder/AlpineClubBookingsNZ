import { NextRequest, NextResponse } from "next/server";
import { BookingStatus } from "@prisma/client";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { createAuditLog, getAuditRequestContext } from "@/lib/audit";
import {
  acquireLodgeCapacityLock,
  findOverlappingCapacityHoldingBookings,
  findOverlappingOverriddenNonHoldingBookings,
} from "@/lib/capacity";
import {
  bookingHoldsCapacity,
  capacityHoldingBookingFilter,
} from "@/lib/booking-status";
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
 * allowed regardless of existing overlapping bookings and is NEVER refused.
 * Conflicts are surfaced and resolved by the officer, never auto-displaced, and
 * no bed-arithmetic capacity engine runs here. But per ADR-001's Security/safety
 * section the two-sided rule must be lock-serialised (issue #154): the flag
 * write and the conflict read run inside the per-lodge capacity lock
 * (`acquireLodgeCapacityLock`), the same key every admission takes, so a hold
 * set cannot race an in-flight admission at the lodge. (confirm-pending-guests
 * was the last admission path still on the legacy club-wide key; #172 moved it
 * onto this per-lodge key so the guarantee holds again.) Authorisation mirrors the
 * sibling capacity-hold route (requireAdmin: admin/full-admin); both set and
 * clear are audited.
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
          // Inputs to bookingHoldsCapacity() (issue #173): the relation-based
          // #1254 PENDING-with-originBookingRequest rule and the #1764
          // PAYMENT_PENDING-with-adminCapacityHoldAt rule both live outside the
          // pure status check, so the guard below needs both signals.
          adminCapacityHoldAt: true,
          originBookingRequest: { select: { id: true } },
        },
      });
      if (!booking || booking.deletedAt) {
        return { error: "Booking not found", status: 404 as const };
      }

      // ADR-001 Security/safety: the two-sided hold rule must be lock-serialised.
      // Take the per-lodge capacity lock — the same key every admission and
      // capacity writer takes (acquireLodgeCapacityLock, booking-create.ts,
      // approveSchoolBookingRequest) — BEFORE reading conflicts and writing the
      // flag. This serialises a hold set against a concurrent admission at this
      // lodge: either the admission commits first and surfaces here as a
      // conflict (decision 1), or the hold commits first and the admission then
      // hard-blocks on wholeLodgeHold (issue #118). The school approval sets the
      // same flag inside its lock-holding transaction; this is the admin twin.
      // lodgeId is NOT NULL for real bookings; guard defensively (a null-lodge
      // row has no lodge to serialise, mirroring the conflict-read guard below).
      if (booking.lodgeId) {
        await acquireLodgeCapacityLock(tx, booking.lodgeId);
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

      // Status guard (issue #173, H2): only SETTING is gated — clearing must
      // never be blocked, so a stale hold on any status can always be cleaned
      // up. ADR-001's capacity rule (§ "Capacity rule", decision 1) hard-blocks
      // new admissions only where a *capacity-holding* booking overlapping a
      // night has wholeLodgeHold = true; every enforcement/masking index is
      // built from the capacity-holding population (capacityHoldingBookingFilter).
      // So a hold set on a non-capacity-holding booking (WAITLISTED / DRAFT /
      // generic PENDING / PAYMENT_PENDING without an admin hold) is never
      // consulted by enforcement: it blocks nothing while the route would return
      // success and the UI would show sole occupancy — false assurance. Reject
      // with 409 and no write/audit; the caller must first put the booking into a
      // capacity-holding state (bookingHoldsCapacity semantics: a holding status,
      // an accepted-quote PENDING with originBookingRequest #1254, or a
      // PAYMENT_PENDING with an admin capacity hold #1764).
      if (
        hold &&
        !bookingHoldsCapacity({
          status: booking.status,
          isRequestConverted: booking.originBookingRequest != null,
          hasAdminCapacityHold: booking.adminCapacityHoldAt != null,
        })
      ) {
        return {
          error:
            booking.status === BookingStatus.PAYMENT_PENDING
              ? "This booking is payment-pending and holds no lodge capacity, so an exclusive whole-lodge hold would block nothing. Apply an admin capacity hold first (Hold capacity), then set the exclusive hold."
              : "This booking does not hold lodge capacity, so an exclusive whole-lodge hold would block nothing while the calendar stays bookable. Only capacity-holding bookings (paid/confirmed, an accepted quote, or a payment-pending booking with an admin capacity hold) can take an exclusive hold.",
          status: 409 as const,
        };
      }

      // No capacity refusal (ADR-001 decision 1): the hold is settable over
      // existing overlapping bookings — the lock above serialises the write, it
      // never refuses. Mirror capacity-hold's clear semantics — null the
      // who/when audit columns when clearing.
      //
      // Compare-and-set on SET (issue #186, extends #173/#177): the per-lodge
      // lock serialises writers on THIS lodge's key, but the status guard above
      // read the PRE-lock snapshot and a cancel path serialises on the DISJOINT
      // club-wide key — booking-cancel clears the hold via
      // RELEASE_WHOLE_LODGE_HOLD_UPDATE while never taking the per-lodge lock. So
      // a concurrent cancel can move the row to a terminal, non-capacity-holding
      // status between our guard read and our write; an unconditional update-by-id
      // would then plant an inert stale hold on a CANCELLED row. Make the SET a
      // conditional updateMany whose predicate re-checks capacity-holding at write
      // time (the same filter capacity.ts composes). Either commit ordering then
      // converges: if the cancel wins the row no longer matches → zero rows → 409
      // and no audit; if the set wins the cancel's later hold-clear still lands.
      // CLEAR stays unconditional-by-id: clearing a stale hold on any status must
      // never be blocked (issue #173, H2).
      const heldAt = new Date();
      const writeResult = hold
        ? await tx.booking.updateMany({
            where: { id: booking.id, AND: [capacityHoldingBookingFilter()] },
            data: {
              wholeLodgeHold: true,
              wholeLodgeHoldAt: heldAt,
              wholeLodgeHoldByMemberId: session.user.id,
            },
          })
        : await tx.booking.updateMany({
            where: { id: booking.id },
            data: {
              wholeLodgeHold: false,
              wholeLodgeHoldAt: null,
              wholeLodgeHoldByMemberId: null,
            },
          });

      // Zero rows on SET means the CAS predicate no longer matched — a
      // concurrent writer moved the booking out of the capacity-holding
      // population after our guard read. Refuse with 409 and write NO audit;
      // nothing changed. (CLEAR always matches its id-only predicate for an
      // existing row, so this only trips on SET.)
      if (writeResult.count === 0) {
        return {
          error:
            "The booking changed while the hold was being set (it no longer holds capacity). Refresh and retry.",
          status: 409 as const,
        };
      }

      // ADR-001 decision 1 conflict surfacing (issue #119): when SETTING the
      // hold, list the existing capacity-holding bookings that overlap its
      // nights so the officer sees the clash. Read-only and informational —
      // the set already succeeded above; nothing is refused or displaced. Never
      // runs the capacity engine (decision 1). On clear there is nothing to
      // surface. lodgeId is NOT NULL for real bookings; guard defensively.
      const holdingConflicts =
        hold && booking.lodgeId
          ? await findOverlappingCapacityHoldingBookings(tx, {
              lodgeId: booking.lodgeId,
              checkIn: booking.checkIn,
              checkOut: booking.checkOut,
              excludeBookingId: booking.id,
            })
          : [];

      // Override-settle blind spot (ADR-001 decision 1, issue #177): additionally
      // surface overlapping bookings that carry a persisted capacity override but
      // are NOT yet capacity-holding (chiefly overridden PAYMENT_PENDING). They
      // are invisible to the capacity-holding conflict read above, yet the
      // settlement carve-out (#1771, unchanged) will later admit them onto the
      // held nights — so the officer must see them now, marked `overridden`.
      // Never-refuse semantics unchanged: this is read-only and informational.
      const overriddenConflicts =
        hold && booking.lodgeId
          ? await findOverlappingOverriddenNonHoldingBookings(tx, {
              lodgeId: booking.lodgeId,
              checkIn: booking.checkIn,
              checkOut: booking.checkOut,
              excludeBookingId: booking.id,
            })
          : [];

      const conflicts = [...holdingConflicts, ...overriddenConflicts];

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
                  overlappingConflictCount: holdingConflicts.length,
                  overlappingConflictBookingIds: holdingConflicts.map((c) => c.id),
                  // Override-settle blind-spot surfacing (issue #177): the
                  // overridden-but-not-yet-holding overlaps recorded distinctly
                  // so the audit shows the officer was warned about the future
                  // settle onto the held nights.
                  overriddenNonHoldingConflictCount: overriddenConflicts.length,
                  overriddenNonHoldingConflictBookingIds: overriddenConflicts.map(
                    (c) => c.id,
                  ),
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

      // updateMany returns only a count, so build the response from the values
      // we just wrote: SET stamped `heldAt`, CLEAR nulled the timestamp.
      return {
        success: true as const,
        wholeLodgeHold: hold,
        wholeLodgeHoldAt: hold ? heldAt : null,
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
