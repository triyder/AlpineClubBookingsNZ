import { BookingStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export interface ProvisionalChildSummary {
  guestCount: number;
  holdUntil: Date;
}

/**
 * Describe the provisional non-member child of a split parent booking (#738),
 * for member-facing email copy only.
 *
 * A split (member + non-member party, outside the hold window) creates a
 * PAYMENT_PENDING parent (member places, charged up front) plus a PENDING child
 * that holds the non-member places provisionally (`parentBookingId` = parent,
 * `nonMemberHoldUntil` set, same member). This returns that child's guest count
 * and hold deadline so the parent's confirmation email can explain the split.
 *
 * Returns null when the booking is not a split parent (no such child), or when
 * the lookup fails — the caller then sends the ordinary confirmation with no
 * provisional section. This is a read-only describe helper: it never mutates
 * booking state and must not change any hold/settlement decision.
 */
export async function getProvisionalNonMemberChildSummary(parent: {
  id: string;
  memberId: string;
}): Promise<ProvisionalChildSummary | null> {
  try {
    const child = await prisma.booking.findFirst({
      where: {
        parentBookingId: parent.id,
        memberId: parent.memberId,
        status: BookingStatus.PENDING,
        nonMemberHoldUntil: { not: null },
      },
      select: {
        nonMemberHoldUntil: true,
        _count: { select: { guests: true } },
      },
    });

    if (!child || !child.nonMemberHoldUntil) {
      return null;
    }

    return {
      guestCount: child._count.guests,
      holdUntil: child.nonMemberHoldUntil,
    };
  } catch {
    return null;
  }
}
