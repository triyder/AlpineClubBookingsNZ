import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { ApiError } from "@/lib/api-error";
import { auth } from "@/lib/auth";
import {
  adminShiftBookingDates,
  modifyBookingDates,
} from "@/lib/booking-date-modification-service";
import { OverCapacityConfirmationRequiredError } from "@/lib/over-capacity-confirmation";
import {
  BookingMemberNightConflictError,
  getBookingMemberNightConflictResponse,
} from "@/lib/booking-member-night-conflicts";
import { isBookingEnvelopeInvariantViolation } from "@/lib/booking-envelope-invariants";
import logger from "@/lib/logger";
import {
  getMembershipTypeBookingPolicyErrorBody,
  MembershipTypeBookingPolicyError,
} from "@/lib/membership-type-policy";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { authorizationRoleFromAccessRoles } from "@/lib/access-roles";
import { bookingManagementAuthorizationRole } from "@/lib/admin-permissions";

const modifyDatesSchema = z
  .object({
    checkIn: z.string().optional(),
    checkOut: z.string().optional(),
    settlementMethod: z.enum(["card", "credit"]).optional(),
    // Admin-only date override (issue #1668).
    adminOverride: z.boolean().optional(),
    pricingMode: z.enum(["shift", "recalculate"]).optional(),
    confirmOverCapacity: z.boolean().optional(),
  })
  .refine((d) => d.checkIn || d.checkOut, {
    message: "At least one of checkIn or checkOut is required",
  });

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { id: bookingId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: "Invalid JSON",
        details: { body: ["Request body must be valid JSON"] },
      },
      { status: 400 },
    );
  }

  const parsed = modifyDatesSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const ipAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  // Issue #1668: admin-only date override gating. The booking-management role
  // (Booking Officer / Full Admin → ADMIN) applies ONLY when the override is
  // actually active (adminOverride === true); every other request — including
  // an explicit adminOverride: false — keeps the legacy access-role mapping, so
  // a caller-controlled boolean can never flip the standard path's authority.
  const { adminOverride, pricingMode, confirmOverCapacity } = parsed.data;
  const hasOverrideFlags =
    adminOverride !== undefined ||
    pricingMode !== undefined ||
    confirmOverCapacity !== undefined;
  if (
    hasOverrideFlags &&
    bookingManagementAuthorizationRole(session.user) !== "ADMIN"
  ) {
    return NextResponse.json(
      { error: "Admin override is not available for this account" },
      { status: 403 },
    );
  }
  const actorRole =
    adminOverride === true
      ? bookingManagementAuthorizationRole(session.user)
      : authorizationRoleFromAccessRoles(session.user);
  if (adminOverride && !pricingMode) {
    return NextResponse.json(
      { error: "Choose a pricing mode for the admin override" },
      { status: 400 },
    );
  }
  if (!adminOverride && (pricingMode !== undefined || confirmOverCapacity !== undefined)) {
    return NextResponse.json(
      { error: "adminOverride is required for pricingMode/confirmOverCapacity" },
      { status: 400 },
    );
  }

  try {
    const result =
      adminOverride && pricingMode === "shift"
        ? await adminShiftBookingDates({
            bookingId,
            actor: { id: session.user.id, role: actorRole },
            input: {
              checkIn: parsed.data.checkIn,
              checkOut: parsed.data.checkOut,
              confirmOverCapacity,
            },
            ipAddress,
          })
        : await modifyBookingDates({
            bookingId,
            actor: { id: session.user.id, role: actorRole },
            input: parsed.data,
            ipAddress,
          });

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof OverCapacityConfirmationRequiredError) {
      return NextResponse.json(
        {
          error: err.message,
          code: err.code,
          nightDetails: err.nightDetails,
        },
        { status: err.status },
      );
    }
    if (err instanceof MembershipTypeBookingPolicyError) {
      return NextResponse.json(
        getMembershipTypeBookingPolicyErrorBody(err),
        { status: err.status },
      );
    }
    if (err instanceof BookingMemberNightConflictError) {
      return NextResponse.json(
        getBookingMemberNightConflictResponse(err.conflicts),
        { status: 409 },
      );
    }
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (isBookingEnvelopeInvariantViolation(err)) {
      // A write-path bug produced a guest stay range outside the booking
      // envelope; the deferred DB triggers caught it and rolled back.
      logger.error(
        { err, bookingId },
        "Booking envelope invariant violated during date modification — write-path bug",
      );
      return NextResponse.json(
        {
          error:
            "The booking update failed an internal consistency check and no changes were saved. Please report this to an administrator.",
        },
        { status: 500 },
      );
    }
    const message =
      err instanceof Error ? err.message : "Failed to modify booking dates";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
