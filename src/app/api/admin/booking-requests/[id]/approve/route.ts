import { NextRequest, NextResponse } from "next/server";
import { BookingRequestType } from "@prisma/client";
import { approveBookingRequest, BookingRequestError } from "@/lib/booking-request";
import {
  approveSchoolBookingRequest,
  schoolChildCountsSchema,
} from "@/lib/school-booking-request";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import {
  getMembershipTypeBookingPolicyErrorBody,
  MembershipTypeBookingPolicyError,
} from "@/lib/membership-type-policy";
import {
  BookingMemberNightConflictError,
  getBookingMemberNightConflictResponse,
} from "@/lib/booking-member-night-conflicts";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const { id } = await params;

  const requestRow = await prisma.bookingRequest.findUnique({
    where: { id },
    select: { type: true },
  });
  if (!requestRow) {
    return NextResponse.json({ error: "Booking request not found" }, { status: 404 });
  }

  // Optional admin override of the school group's child counts at approval time,
  // plus the optional map-to-existing-contact decision (issue #1255). The body
  // is empty for general requests and for school approvals that keep the
  // submitted numbers, so parse defensively.
  const body = (await req.json().catch(() => ({}))) as {
    childCounts?: unknown;
    ownerContactMemberId?: unknown;
  };

  // The map target is an existing non-login Organisation/School contact id. The
  // authoritative guard (canLogin:false, role, not archived) runs inside the
  // approval transaction; here we only normalise the shape.
  let ownerContactMemberId: string | undefined;
  if (body.ownerContactMemberId !== undefined && body.ownerContactMemberId !== null) {
    if (
      typeof body.ownerContactMemberId !== "string" ||
      body.ownerContactMemberId.trim().length === 0 ||
      body.ownerContactMemberId.length > 64
    ) {
      return NextResponse.json(
        { error: "Invalid contact selection" },
        { status: 422 }
      );
    }
    ownerContactMemberId = body.ownerContactMemberId;
  }

  try {
    if (requestRow.type === BookingRequestType.SCHOOL) {
      let guestOverride: { childCounts: ReturnType<typeof schoolChildCountsSchema.parse> } | undefined;
      if (body.childCounts !== undefined) {
        const parsedCounts = schoolChildCountsSchema.safeParse(body.childCounts);
        if (!parsedCounts.success) {
          return NextResponse.json(
            { error: "Invalid child counts" },
            { status: 422 }
          );
        }
        guestOverride = { childCounts: parsedCounts.data };
      }

      const result = await approveSchoolBookingRequest({
        requestId: id,
        adminMemberId: session.user.id,
        guestOverride,
        ownerContactMemberId,
      });

      if (result.type === "capacityExceeded") {
        return NextResponse.json(
          {
            error: "The lodge is at capacity for one or more of the requested nights",
            fullNights: result.fullNights,
          },
          { status: 409 }
        );
      }

      return NextResponse.json({
        success: true,
        type: "SCHOOL",
        bookingId: result.bookingId,
        memberId: result.schoolMemberId,
        priceCents: result.priceCents,
        invoiceMode: result.invoiceMode,
        teacherCount: result.teacherCount,
        // Overlapping capacity-holding bookings when an exclusive whole-lodge
        // hold was set at approval (issue #119); the officer resolves them
        // manually (decision 1). Empty when no hold was set or nights are clear.
        exclusiveHoldConflicts: result.exclusiveHoldConflicts,
      });
    }

    const result = await approveBookingRequest({
      requestId: id,
      adminMemberId: session.user.id,
      ownerContactMemberId,
    });

    if (result.type === "capacityExceeded") {
      return NextResponse.json(
        {
          error: "The lodge is at capacity for one or more of the requested nights",
          fullNights: result.fullNights,
        },
        { status: 409 }
      );
    }

    return NextResponse.json({
      success: true,
      type: "GENERAL",
      bookingId: result.bookingId,
      memberId: result.memberId,
      priceCents: result.priceCents,
      paymentLinkExpiresAt: result.paymentLinkExpiresAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof BookingMemberNightConflictError) {
      return NextResponse.json(
        getBookingMemberNightConflictResponse(err.conflicts),
        { status: 409 },
      );
    }
    if (err instanceof MembershipTypeBookingPolicyError) {
      return NextResponse.json(
        getMembershipTypeBookingPolicyErrorBody(err),
        { status: err.status },
      );
    }
    if (err instanceof BookingRequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
