import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { ApiError } from "@/lib/api-error";
import { auth } from "@/lib/auth";
import { modifyBookingDates } from "@/lib/booking-date-modification-service";
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

const modifyDatesSchema = z
  .object({
    checkIn: z.string().optional(),
    checkOut: z.string().optional(),
    settlementMethod: z.enum(["card", "credit"]).optional(),
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

  try {
    const result = await modifyBookingDates({
      bookingId,
      actor: {
        id: session.user.id,
        role: authorizationRoleFromAccessRoles(session.user),
      },
      input: parsed.data,
      ipAddress,
    });

    return NextResponse.json(result);
  } catch (err) {
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
