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
import logger from "@/lib/logger";

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
  const rateLimited = applyRateLimit(rateLimiters.groupBookingJoin, request);
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

  try {
    const result = await joinGroupBookingAsMember(
      { code, guests: parsed.data.guests },
      session.user.id,
      session.user.role
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
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
