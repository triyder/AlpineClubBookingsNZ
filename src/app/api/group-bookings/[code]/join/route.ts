import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { parseJsonRequestBody } from "@/lib/api-json";
import { ageTierEnum } from "@/lib/age-tier-schema";
import { nameField } from "@/lib/zod-helpers";
import {
  GroupBookingError,
  joinGroupBookingAsMember,
} from "@/lib/group-booking";
import {
  BookingGuestValidationError,
  getBookingGuestValidationErrorResponse,
} from "@/lib/booking-guests";
import {
  BookingPromoError,
  BookingReviewJustificationRequiredError,
} from "@/lib/booking-create";
import {
  getMembershipTypeBookingPolicyErrorBody,
  MembershipTypeBookingPolicyError,
} from "@/lib/membership-type-policy";
import {
  BOOKING_PAYMENT_METHOD_VALUES,
  DEFAULT_BOOKING_PAYMENT_METHOD,
} from "@/lib/booking-payment-methods";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import logger from "@/lib/logger";
import { authorizationRoleFromAccessRoles } from "@/lib/access-roles";

const joinSchema = z
  .object({
    guests: z
      .array(
        z.object({
          firstName: nameField(),
          lastName: nameField(),
          ageTier: ageTierEnum,
          isMember: z.boolean(),
          memberId: z.string().min(1).optional(),
        })
      )
      .min(1)
      .max(50),
    paymentMethod: z
      .enum(BOOKING_PAYMENT_METHOD_VALUES)
      .optional()
      .default(DEFAULT_BOOKING_PAYMENT_METHOD),
  })
  .strict();

/**
 * A logged-in member adds themselves (and their member guests) to a group via
 * its join code. The service enforces the same eligibility gates as POST
 * /api/bookings and creates a child booking linked to the organiser. For
 * EACH_PAYS_OWN a balance-due result should be paid through the normal member
 * booking payment flow; for ORGANISER_PAYS the result is organiserSettled with
 * requiresPayment false (the organiser settles the group total).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const rateLimited = await applyRateLimit(rateLimiters.groupBookingJoin, request);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;
  const parsed = joinSchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { code } = await params;

  // Internet Banking is an optional module; reject it when off (mirrors
  // POST /api/bookings) so a joiner can never raise an invoice the club can't
  // service.
  if (parsed.data.paymentMethod === "internet_banking") {
    const modules = await loadEffectiveModuleFlags();
    if (!modules.xeroIntegration || !modules.internetBankingPayments) {
      return NextResponse.json(
        { error: "Internet Banking payments are not available." },
        { status: 400 }
      );
    }
  }

  try {
    const result = await joinGroupBookingAsMember(
      {
        code,
        guests: parsed.data.guests,
        paymentMethod: parsed.data.paymentMethod,
      },
      session.user.id,
      authorizationRoleFromAccessRoles(session.user)
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof MembershipTypeBookingPolicyError) {
      return NextResponse.json(
        getMembershipTypeBookingPolicyErrorBody(err),
        { status: err.status },
      );
    }
    if (err instanceof GroupBookingError) {
      return NextResponse.json(
        { error: err.message, code: err.code, details: err.details },
        { status: err.status }
      );
    }
    if (err instanceof BookingGuestValidationError) {
      return NextResponse.json(
        getBookingGuestValidationErrorResponse(err),
        { status: err.status }
      );
    }
    if (err instanceof BookingReviewJustificationRequiredError) {
      return NextResponse.json(
        {
          error:
            "This booking needs an adult guest. Please include an adult, or ask the organiser to add these guests.",
          code: "REVIEW_JUSTIFICATION_REQUIRED",
        },
        { status: 400 }
      );
    }
    if (err instanceof BookingPromoError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    logger.error({ err }, "Unexpected error joining group booking");
    return NextResponse.json(
      { error: "Unable to join the group booking right now" },
      { status: 500 }
    );
  }
}
