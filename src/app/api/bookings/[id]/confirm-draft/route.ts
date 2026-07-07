import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDefaultLodgeId } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { BookingStatus } from "@prisma/client";
import {
  acquireLodgeCapacityLock,
  checkCapacityForGuestRanges,
} from "@/lib/capacity";
import { getSeasonYear } from "@/lib/utils";
import {
  enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { sendBookingConfirmedEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";
import {
  assertMembershipTypeBookingAllowed,
  getMembershipTypeBookingPolicyErrorBody,
  MembershipTypeBookingPolicyError,
  requiresPaidSubscriptionForMemberForBooking,
} from "@/lib/membership-type-policy";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { hasAdminAccess } from "@/lib/access-roles";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }
  const isAdmin = hasAdminAccess(session.user);

  const { id } = await params;

  const booking = await prisma.booking.findUnique({
    where: { id },
    include: { guests: true, member: true, promoRedemption: { include: { promoCode: true } } },
  });

  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  if (booking.memberId !== session.user.id && !isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (booking.status !== BookingStatus.DRAFT) {
    return NextResponse.json({ error: "Booking is not a draft" }, { status: 400 });
  }

  if (booking.finalPriceCents !== 0) {
    return NextResponse.json(
      { error: "Use the payment flow to complete non-zero bookings" },
      { status: 400 }
    );
  }

  const seasonYear = getSeasonYear(new Date(booking.checkIn));
  try {
    await assertMembershipTypeBookingAllowed(prisma, {
      ownerMemberId: booking.memberId,
      guests: booking.guests,
      seasonYear,
    });
  } catch (err) {
    if (err instanceof MembershipTypeBookingPolicyError) {
      return NextResponse.json(
        getMembershipTypeBookingPolicyErrorBody(err),
        { status: err.status },
      );
    }
    throw err;
  }

  // Subscription check (non-admins only; bypassed when the Xero module is
  // effectively off, because subscriptions are invoiced through Xero)
  if (
    !isAdmin &&
    await requiresPaidSubscriptionForMemberForBooking(prisma, {
      memberId: booking.memberId,
      seasonYear,
      ageTier: booking.member.ageTier,
    })
  ) {
    const paidSub = await prisma.memberSubscription.findFirst({
      where: { memberId: booking.memberId, seasonYear, status: "PAID" },
    });
    if (!paidSub) {
      const seasonDisplay = `${seasonYear}/${seasonYear + 1}`;
      return NextResponse.json(
        {
          error: `Your membership subscription for the ${seasonDisplay} season is not paid. Please contact the club to arrange payment before booking.`,
        },
        { status: 403 }
      );
    }
  }

  // Check capacity + transition to PAID in transaction
  await prisma.$transaction(async (tx) => {
    // Lock the booking's lodge before re-reading it: the draft's lodge cannot
    // change, so the pre-read outside the lock is safe for key selection.
    const lockTarget = await tx.booking.findUnique({
      where: { id },
      select: { lodgeId: true },
    });
    const bookingLodgeId =
      lockTarget?.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, bookingLodgeId);

    const freshBooking = await tx.booking.findUnique({
      where: { id },
      include: { guests: { include: { nights: true } } }, // per-night sets (issue #713)
    });

    if (!freshBooking || freshBooking.status !== BookingStatus.DRAFT) {
      throw new Error("Booking is no longer a draft");
    }

    const capacity = await checkCapacityForGuestRanges(
      bookingLodgeId,
      freshBooking.checkIn,
      freshBooking.checkOut,
      freshBooking.guests,
      id,
      tx,
    );
    if (!capacity.available) {
      throw new Error("Not enough beds available for your dates.");
    }

    await tx.payment.create({
      data: {
        bookingId: id,
        amountCents: 0,
        status: "SUCCEEDED",
      },
    });

    await tx.booking.update({
      where: { id },
      data: { status: BookingStatus.PAID, draftExpiresAt: null },
    });
    await reconcileBedAllocationsForBooking({
      bookingId: id,
      db: tx,
      previousRange: {
        checkIn: freshBooking.checkIn,
        checkOut: freshBooking.checkOut,
      },
    });
  });

  // Fire-and-forget: confirmation email + Xero invoice
  sendBookingConfirmedEmail(
    booking.member.email,
    booking.member.firstName,
    booking.checkIn,
    booking.checkOut,
    booking.guests.length,
    0,
    {
      lodgeId: booking.lodgeId,
      ...(booking.promoRedemption?.promoCode
        ? {
            discountCents: booking.discountCents,
            promoAdjustmentCents: booking.promoAdjustmentCents,
            promoCode: booking.promoRedemption.promoCode.code,
          }
        : {}),
    }
  ).catch((err) => logger.error({ err, bookingId: id }, "Failed to send confirmation email for confirmed draft"));

  // The admin alert for review-flagged bookings is sent once at creation
  // time; no second alert when a flagged draft is confirmed.

  void enqueueXeroBookingInvoiceOperation(id, {
    createdByMemberId: session.user.id,
  })
    .then(async (queuedInvoice) => {
      if (!queuedInvoice.queueOperationId) {
        return;
      }

      await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
    })
    .catch((err) =>
      logger.error(
        { err, bookingId: id },
        "Failed to queue Xero invoice for confirmed draft"
      )
    );

  return NextResponse.json({ success: true, status: BookingStatus.PAID });
}
