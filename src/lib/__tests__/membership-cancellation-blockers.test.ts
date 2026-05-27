import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: vi.fn() },
    bookingGuest: { findMany: vi.fn() },
  },
}));

import {
  loadMembershipCancellationBlockersByMemberId,
  type MembershipCancellationBlockerClient,
} from "@/lib/membership-cancellation-blockers";

describe("membership cancellation blockers", () => {
  it("loads future owned bookings and guest appearances by member", async () => {
    const bookingFindMany = vi.fn().mockResolvedValue([
      {
        id: "booking-1",
        memberId: "member-1",
        checkIn: new Date("2099-01-01T00:00:00.000Z"),
        checkOut: new Date("2099-01-03T00:00:00.000Z"),
        status: "PAID",
      },
    ]);
    const bookingGuestFindMany = vi.fn().mockResolvedValue([
      {
        id: "guest-1",
        memberId: "member-1",
        stayStart: new Date("2099-02-01T00:00:00.000Z"),
        stayEnd: new Date("2099-02-02T00:00:00.000Z"),
        booking: {
          id: "booking-2",
          status: "CONFIRMED",
          checkIn: new Date("2099-02-01T00:00:00.000Z"),
          checkOut: new Date("2099-02-02T00:00:00.000Z"),
        },
      },
      {
        id: "unlinked-guest",
        memberId: null,
        stayStart: new Date("2099-03-01T00:00:00.000Z"),
        stayEnd: new Date("2099-03-02T00:00:00.000Z"),
        booking: {
          id: "booking-3",
          status: "PAID",
          checkIn: new Date("2099-03-01T00:00:00.000Z"),
          checkOut: new Date("2099-03-02T00:00:00.000Z"),
        },
      },
    ]);
    const db = {
      booking: { findMany: bookingFindMany },
      bookingGuest: { findMany: bookingGuestFindMany },
    } as unknown as MembershipCancellationBlockerClient;

    const blockers = await loadMembershipCancellationBlockersByMemberId(
      ["member-1", "member-1", "member-2"],
      db,
    );

    expect(bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          memberId: { in: ["member-1", "member-2"] },
        }),
      }),
    );
    expect(blockers.get("member-1")).toEqual([
      {
        type: "owned_booking",
        bookingId: "booking-1",
        bookingStatus: "PAID",
        checkIn: "2099-01-01T00:00:00.000Z",
        checkOut: "2099-01-03T00:00:00.000Z",
      },
      {
        type: "guest_appearance",
        bookingId: "booking-2",
        bookingStatus: "CONFIRMED",
        checkIn: "2099-02-01T00:00:00.000Z",
        checkOut: "2099-02-02T00:00:00.000Z",
        guestAppearanceId: "guest-1",
      },
    ]);
    expect(blockers.get("member-2")).toEqual([]);
  });
});
