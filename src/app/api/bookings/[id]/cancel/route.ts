import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { cancelBooking } from "@/lib/booking-cancel";
import { getClientIp } from "@/lib/rate-limit";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { z } from "zod";
import { authorizationRoleFromAccessRoles } from "@/lib/access-roles";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";

const cancelBookingParamsSchema = z.object({
  id: z.string().min(1),
});

const cancelBookingMutationSchema = z.object({
  refundMethod: z.enum(["card", "credit"]),
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
