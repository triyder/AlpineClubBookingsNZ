import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { cancelBooking } from "@/lib/booking-cancel";
import { getClientIp } from "@/lib/rate-limit";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";
import { authorizationRoleFromAccessRoles } from "@/lib/access-roles";
import {
  bookingManagementAuthorizationRole,
  hasAdminAreaAccess,
} from "@/lib/admin-permissions";

const cancelBookingParamsSchema = z.object({
  id: z.string().min(1),
});

const cancelBookingMutationSchema = z.object({
  refundMethod: z.enum(["card", "credit"]),
  // Issue #1705: per-action member-email choice for admin cancellations, same
  // semantics as the modify routes (#1696): booking-management ADMIN only,
  // absent means notify.
  notifyMember: z.boolean().optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const parsedParams = cancelBookingParamsSchema.safeParse(await params);
    if (!parsedParams.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsedParams.error.flatten() },
        { status: 400 }
      );
    }

    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    }

    const inactiveResponse = await requireActiveSessionUser(session.user.id);
    if (inactiveResponse) {
      return inactiveResponse;
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        {
          error: "Invalid JSON",
          details: { body: ["Request body must be valid JSON"] },
        },
        { status: 400 }
      );
    }

    const parsed = cancelBookingMutationSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    // Issue #1705 (#1696 semantics): only a booking-management ADMIN (Full
    // Admin or Booking Officer) may carry the notify flag; any other caller —
    // including the booking owner cancelling their own booking — is refused
    // before the service runs, so a member can never suppress their own
    // cancellation email.
    if (
      parsed.data.notifyMember !== undefined &&
      bookingManagementAuthorizationRole(session.user) !== "ADMIN"
    ) {
      return NextResponse.json(
        { error: "Admin override is not available for this account" },
        { status: 403 }
      );
    }

    const result = await cancelBooking(
      parsedParams.data.id,
      session.user.id,
      authorizationRoleFromAccessRoles(session.user),
      getClientIp(request),
      parsed.data.refundMethod,
      {
        // Issue #1313 (owner-approved option A2): a Booking Officer
        // (bookings:edit) may cancel any member's booking with the SAME
        // authority — and byte-identical refund / Stripe path / cancellation
        // email / audit — as a Full Admin acting on-behalf. The actor's real
        // authorization role stays honest ("USER" for an officer); this flag
        // ONLY widens the internal authorization gate, never the refund
        // computation (which keys off booking state + policy tier only).
        hasBookingsEditAccess: hasAdminAreaAccess(session.user, {
          area: "bookings",
          level: "edit",
        }),
        // Issue #1705: the admin's explicit per-cancel member-email choice.
        // Absent means notify; the service additionally forces notify for any
        // non-admin actor (defence in depth behind the 403 gate above).
        notifyMember: parsed.data.notifyMember,
        // #2029: this is the self-service (member / Booking Officer) cancel
        // surface, so enforce the started-stay block. A Full Admin acting
        // through the same route is exempted inside the service; every
        // internal/admin caller leaves this false.
        enforceStartedStayBlock: true,
      }
    );

    if (result.status === 200) {
      return NextResponse.json(result.data);
    }
    return NextResponse.json(
      { error: result.error },
      { status: result.status }
    );
  } catch (error) {
    logger.error({ err: error }, "Error cancelling booking");
    return NextResponse.json(
      { error: "Failed to cancel booking" },
      { status: 500 }
    );
  }
}
