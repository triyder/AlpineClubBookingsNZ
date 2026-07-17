import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MyBookingsList, type MyBookingItem } from "./_components/my-bookings-list";

export default async function MyBookingsPage() {
  const session = await auth();
  if (!session) return null;

  const bookings = await prisma.booking.findMany({
    where: {
      deletedAt: null,
      OR: [
        { memberId: session.user.id },
        { guests: { some: { memberId: session.user.id } } },
      ],
    },
    include: {
      guests: true,
      // #796 discriminator: a group joiner also links to its organiser via
      // parentBookingId, so the list needs the join row to tell it apart from a
      // genuine #738 split child. Mirrors [id]/page.tsx's nonMemberGuestChildren
      // filter (`hasNonMembers && !groupBookingJoin`).
      groupBookingJoin: { select: { id: true } },
    },
    // Newest start date first, with a stable createdAt tiebreaker (#771).
    orderBy: [{ checkIn: "desc" }, { createdAt: "desc" }],
  });

  // Split-booking grouping (#738): a mixed party is a member booking plus a
  // linked provisional non-member booking. Label both so a family reads as one.
  const memberBookingIdsWithLinkedGuests = new Set(
    bookings
      .map((booking) => booking.parentBookingId)
      .filter((id): id is string => Boolean(id)),
  );

  const items: MyBookingItem[] = bookings.map((booking) => {
    // #1975/#796: only a genuine #738 split child (a provisional non-member
    // booking) is nestable. A group joiner also carries parentBookingId but is
    // presented by the organiser group card, not nested here. Mirror the detail
    // page's discriminator exactly ([id]/page.tsx nonMemberGuestChildren:
    // `hasNonMembers && !groupBookingJoin`).
    const isNestableSplitChild =
      Boolean(booking.parentBookingId) &&
      booking.hasNonMembers &&
      !booking.groupBookingJoin;
    return {
      id: booking.id,
      checkIn: booking.checkIn.toISOString(),
      checkOut: booking.checkOut.toISOString(),
      guestCount: booking.guests.length,
      finalPriceCents: booking.finalPriceCents,
      status: booking.status,
      // #1975: expose the parent link ONLY for a genuine split child, so the
      // list nests it as a sub-row inside its parent's card. A #796 joiner
      // (join row present) keeps its pre-existing label but is never carried
      // for nesting.
      parentBookingId: isNestableSplitChild ? booking.parentBookingId : null,
      linkLabel:
        booking.memberId !== session.user.id
          ? "guest-linked"
          : booking.parentBookingId
            ? "provisional-child"
            : memberBookingIdsWithLinkedGuests.has(booking.id)
              ? "linked-parent"
              : null,
    };
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">My Bookings</h1>
        <Link href="/book">
          <Button>New Booking</Button>
        </Link>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center">
            <p className="text-gray-600 mb-4">You haven&apos;t made any bookings yet.</p>
            <Link href="/book">
              <Button>Book a Stay</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <MyBookingsList bookings={items} />
      )}
    </div>
  );
}
