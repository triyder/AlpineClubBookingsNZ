import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { ApiError } from "@/lib/api-error";
import { auth } from "@/lib/auth";
import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import {
  BookingGuestValidationError,
  getBookingGuestValidationErrorResponse,
} from "@/lib/booking-guests";
import {
  BookingMemberNightConflictError,
  getBookingMemberNightConflictResponse,
} from "@/lib/booking-member-night-conflicts";
import { modifyBookingBatch } from "@/lib/booking-batch-modification-service";
import { adminShiftBookingDates } from "@/lib/booking-date-modification-service";
import { OverCapacityConfirmationRequiredError } from "@/lib/over-capacity-confirmation";
import { isBookingEnvelopeInvariantViolation } from "@/lib/booking-envelope-invariants";
import {
  getMembershipTypeBookingPolicyErrorBody,
  MembershipTypeBookingPolicyError,
} from "@/lib/membership-type-policy";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { nameField } from "@/lib/zod-helpers";
import { bookingManagementAuthorizationRole } from "@/lib/admin-permissions";
import { getXeroLockGuardErrorResponse } from "@/lib/xero-period-lock-guard";

const batchModifySchema = z.object({
  checkIn: z.string().optional(),
  checkOut: z.string().optional(),
  addGuests: z
    .array(
      z.object({
        firstName: nameField(),
        lastName: nameField(),
        ageTier: bookableAgeTierEnum,
        isMember: z.boolean(),
        memberId: z.string().min(1).optional(),
        stayStart: z.string().optional(),
        stayEnd: z.string().optional(),
        nights: z.array(z.string()).max(370).optional(),
      }),
    )
    .optional(),
  removeGuestIds: z.array(z.string()).optional(),
  guestStayRanges: z
    .array(
      z.object({
        guestId: z.string().min(1),
        stayStart: z.string().optional(),
        stayEnd: z.string().optional(),
        nights: z.array(z.string()).max(370).optional(),
      }),
    )
    .optional(),
  guestUpdates: z
    .array(
      z.object({
        guestId: z.string().min(1),
        firstName: nameField(),
        lastName: nameField(),
      }),
    )
    .optional(),
  promoCode: z.string().optional(),
  promoGuestIndexes: z.array(z.number().int().min(0)).optional(),
  removePromoCode: z.boolean().optional(),
  memberReviewJustification: z.string().trim().min(1).max(1000).optional(),
  settlementMethod: z.enum(["card", "credit"]).optional(),
  // Admin-only date override (issue #1668).
  adminOverride: z.boolean().optional(),
  pricingMode: z.enum(["shift", "recalculate"]).optional(),
  confirmOverCapacity: z.boolean().optional(),
  notifyMember: z.boolean().optional(),
  // Admin-only (#1746): flag proposed member guests as partner-sharers so
  // capacity runs through the #1745 reserved double-bed slots.
  partnerSharedGuests: z
    .array(
      z.object({
        memberId: z.string().min(1),
        partnerMemberId: z.string().min(1),
      }),
    )
    .max(10)
    .optional(),
});

const OVERRIDE_DATE_ONLY_FIELDS = [
  "addGuests",
  "removeGuestIds",
  "guestStayRanges",
  "guestUpdates",
  "promoCode",
  "promoGuestIndexes",
  "removePromoCode",
  // #1746: partner-shared flags ride guest changes, never a date override.
  "partnerSharedGuests",
] as const;

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

  const parsed = batchModifySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const ipAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  // Issue #1313 (option A2): a Booking Officer (bookings:edit) resolves to ADMIN
  // so they receive the SAME admin-on-behalf modify authority as a Full Admin.
  const actorRole = bookingManagementAuthorizationRole(session.user);

  // Issue #1668: admin-only date override gating.
  const { adminOverride, pricingMode, confirmOverCapacity, notifyMember } =
    parsed.data;
  const hasOverrideFlags =
    adminOverride !== undefined ||
    pricingMode !== undefined ||
    confirmOverCapacity !== undefined ||
    notifyMember !== undefined;
  if (hasOverrideFlags && actorRole !== "ADMIN") {
    return NextResponse.json(
      { error: "Admin override is not available for this account" },
      { status: 403 },
    );
  }
  // #1746: partner-shared placement is admin-initiated by owner decision.
  if (parsed.data.partnerSharedGuests?.length && actorRole !== "ADMIN") {
    return NextResponse.json(
      { error: "Partner-shared placement is not available for this account" },
      { status: 403 },
    );
  }
  if (adminOverride && !pricingMode) {
    return NextResponse.json(
      { error: "Choose a pricing mode for the admin override" },
      { status: 400 },
    );
  }
  // Issue #1696: an admin may now suppress the member-facing modified email on
  // ANY edit, so notifyMember is allowed alone (without adminOverride). The
  // pricing/capacity override flags still require adminOverride. actorRole is
  // already the booking-management role (ADMIN for Full Admin / Booking Officer),
  // so the service honours the admin's choice on every edit.
  if (
    !adminOverride &&
    (pricingMode !== undefined || confirmOverCapacity !== undefined)
  ) {
    return NextResponse.json(
      {
        error: "adminOverride is required for pricingMode/confirmOverCapacity",
      },
      { status: 400 },
    );
  }
  if (
    adminOverride &&
    OVERRIDE_DATE_ONLY_FIELDS.some((field) => {
      const value = parsed.data[field];
      return Array.isArray(value) ? value.length > 0 : Boolean(value);
    })
  ) {
    return NextResponse.json(
      { error: "Admin override edits change dates only" },
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
              notifyMember,
            },
            ipAddress,
          })
        : await modifyBookingBatch({
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
    if (err instanceof BookingGuestValidationError) {
      return NextResponse.json(getBookingGuestValidationErrorResponse(err), {
        status: err.status,
      });
    }
    if (err instanceof BookingMemberNightConflictError) {
      return NextResponse.json(
        getBookingMemberNightConflictResponse(err.conflicts),
        { status: 409 },
      );
    }
    // Xero lock-date guard (#1697): keep the machine-readable code + lockDate
    // (both errors extend ApiError, so this branch must come first).
    const xeroLockGuardResponse = getXeroLockGuardErrorResponse(err);
    if (xeroLockGuardResponse) {
      return NextResponse.json(xeroLockGuardResponse.body, {
        status: xeroLockGuardResponse.status,
      });
    }
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (isBookingEnvelopeInvariantViolation(err)) {
      // A write-path bug produced a guest stay range outside the booking
      // envelope; the deferred DB triggers caught it and rolled back.
      logger.error(
        { err, bookingId },
        "Booking envelope invariant violated during batch modify — write-path bug",
      );
      return NextResponse.json(
        {
          error:
            "The booking update failed an internal consistency check and no changes were saved. Please report this to an administrator.",
        },
        { status: 500 },
      );
    }
    const message = err instanceof Error ? err.message : "Failed to modify booking";
    logger.error({ err, bookingId }, "Batch modify failed");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
