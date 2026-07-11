import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AdminReviewStatus, BookingStatus } from "@prisma/client";

import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { cancelBooking } from "@/lib/booking-cancel";
import {
  sendBookingReviewApprovedEmail,
  sendBookingReviewRejectedEmail,
} from "@/lib/email";
import logger from "@/lib/logger";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";

const reviewSchema = z
  .object({
    status: z.enum(["APPROVED", "REJECTED"]),
    // Optional when approving; required when rejecting so the member always
    // gets a reason.
    adminNotes: z.string().trim().max(2000).optional().default(""),
    // #1790: admin per-decision email choice. Absent/undefined = notify
    // (default), false = suppress the member-facing review email. Both member
    // sends here are unconditional, so a non-boolean is a 400 via this parse.
    notifyMember: z.boolean().optional(),
  })
  .refine((data) => data.status === "APPROVED" || data.adminNotes.length > 0, {
    message: "Admin notes are required when rejecting",
    path: ["adminNotes"],
  });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const { id: bookingId } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { member: true },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  // A PENDING review can sit on a parked pre-payment booking
  // (AWAITING_REVIEW) or on a live paid/confirmed booking flagged by an edit
  // that left no adult (#1100) — both are decisioned here.
  if (booking.adminReviewStatus !== AdminReviewStatus.PENDING) {
    return NextResponse.json(
      { error: "This booking is not awaiting admin review" },
      { status: 409 },
    );
  }
  const parkedForReview = booking.status === BookingStatus.AWAITING_REVIEW;

  const reviewedAt = new Date();
  const ipAddress =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  // #1790: only record the notify choice when a member email was actually
  // suppressed. Both review sends below are unconditional, so this reflects
  // exactly whether the admin opted out.
  const notifyAuditFields =
    parsed.data.notifyMember === false ? { notifyMember: false } : {};

  if (parsed.data.status === "APPROVED") {
    // Atomic claim: only one admin can approve. Mirrors the change-request
    // pattern of updateMany guarded by the prior status.
    const claim = await prisma.booking.updateMany({
      where: {
        id: bookingId,
        adminReviewStatus: AdminReviewStatus.PENDING,
        status: booking.status,
      },
      data: {
        adminReviewStatus: AdminReviewStatus.APPROVED,
        adminReviewNotes: parsed.data.adminNotes || null,
        adminReviewedById: session.user.id,
        adminReviewedAt: reviewedAt,
        // Only a parked pre-payment booking is released toward payment; a
        // flagged paid/confirmed booking keeps its status (#1100) — the
        // approval clears the review, never re-opens the payment lifecycle.
        ...(parkedForReview ? { status: BookingStatus.PAYMENT_PENDING } : {}),
      },
    });

    if (claim.count !== 1) {
      return NextResponse.json(
        { error: "This booking has already been reviewed" },
        { status: 409 },
      );
    }
    await reconcileBedAllocationsForBooking({
      bookingId,
      previousRange: {
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
      },
    });

    // #1790: approve always emails the member unless the admin chose not to
    // notify (default is notify; the suppression is audited below).
    if (parsed.data.notifyMember !== false) {
      sendBookingReviewApprovedEmail({
        email: booking.member.email,
        firstName: booking.member.firstName,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        adminNotes: parsed.data.adminNotes,
        bookingId,
        lodgeId: booking.lodgeId,
      }).catch((err) =>
        logger.error({ err, bookingId }, "Failed to send booking review approved email"),
      );
    }

    logAudit({
      action: "booking.review.approve",
      memberId: session.user.id,
      targetId: bookingId,
      subjectMemberId: booking.memberId,
      entityType: "Booking",
      entityId: bookingId,
      category: "booking",
      outcome: "success",
      summary: "Admin approved booking awaiting review",
      details: parsed.data.adminNotes,
      metadata: { decision: "APPROVED", ...notifyAuditFields },
      ipAddress,
    });

    return NextResponse.json({ success: true, decision: "APPROVED" });
  }

  // REJECTED — record the review fields and then cancel via the shared
  // cancellation flow. A parked AWAITING_REVIEW booking has no payment so
  // cancelBooking short-circuits the refund branch; a flagged paid booking
  // (#1100) is refunded per the cancellation policy by the same shared flow.
  const claim = await prisma.booking.updateMany({
    where: {
      id: bookingId,
      adminReviewStatus: AdminReviewStatus.PENDING,
      status: booking.status,
    },
    data: {
      adminReviewStatus: AdminReviewStatus.REJECTED,
      adminReviewNotes: parsed.data.adminNotes,
      adminReviewedById: session.user.id,
      adminReviewedAt: reviewedAt,
    },
  });

  if (claim.count !== 1) {
    return NextResponse.json(
      { error: "This booking has already been reviewed" },
      { status: 409 },
    );
  }

  const cancelResult = await cancelBooking(
    bookingId,
    session.user.id,
    "ADMIN",
    ipAddress,
    "card",
  );

  // A concurrent cancel won the single-flight claim (#1160): surface the 409
  // rather than mislabelling it a 500. The review was already recorded and the
  // booking is being/has been cancelled, so this is a benign race, not a fault.
  if (cancelResult.status === 409) {
    return NextResponse.json(
      { error: cancelResult.error },
      { status: 409 },
    );
  }

  if ("error" in cancelResult) {
    logger.error(
      { bookingId, error: cancelResult.error },
      "Failed to cancel rejected booking",
    );
    return NextResponse.json(
      { error: "Review recorded but booking could not be cancelled", details: cancelResult.error },
      { status: 500 },
    );
  }

  // #1790: reject always emails the member unless the admin chose not to
  // notify (default is notify; the suppression is audited below). This gates
  // only the rejection notice — the shared cancelBooking flow is untouched.
  if (parsed.data.notifyMember !== false) {
    sendBookingReviewRejectedEmail({
      email: booking.member.email,
      firstName: booking.member.firstName,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      adminNotes: parsed.data.adminNotes,
      lodgeId: booking.lodgeId,
    }).catch((err) =>
      logger.error({ err, bookingId }, "Failed to send booking review rejected email"),
    );
  }

  logAudit({
    action: "booking.review.reject",
    memberId: session.user.id,
    targetId: bookingId,
    subjectMemberId: booking.memberId,
    entityType: "Booking",
    entityId: bookingId,
    category: "booking",
    outcome: "success",
    summary: "Admin rejected booking awaiting review",
    details: parsed.data.adminNotes,
    metadata: { decision: "REJECTED", ...notifyAuditFields },
    ipAddress,
  });

  return NextResponse.json({ success: true, decision: "REJECTED" });
}
