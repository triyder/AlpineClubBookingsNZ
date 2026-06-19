import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    bookingGuestNight: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import {
  COMMITTED_BOOKING_STATUSES,
  countMemberStayNights,
} from "@/lib/member-stay-nights";

describe("countMemberStayNights", () => {
  beforeEach(() => vi.clearAllMocks());

  it("counts distinct stay nights for the member's own member-guest rows", async () => {
    prismaMock.bookingGuestNight.findMany.mockResolvedValue([
      { stayDate: new Date("2025-07-01") },
      { stayDate: new Date("2025-07-02") },
      { stayDate: new Date("2025-07-03") },
    ]);

    const count = await countMemberStayNights("member-1");
    expect(count).toBe(3);

    const args = prismaMock.bookingGuestNight.findMany.mock.calls[0][0];
    expect(args.distinct).toEqual(["stayDate"]);
    expect(args.where.bookingGuest.isMember).toBe(true);
    expect(args.where.bookingGuest.memberId).toBe("member-1");
    expect(args.where.bookingGuest.booking.deletedAt).toBeNull();
    expect(args.where.bookingGuest.booking.status.in).toEqual(
      COMMITTED_BOOKING_STATUSES
    );
  });

  it("returns zero when the member has no committed stays", async () => {
    prismaMock.bookingGuestNight.findMany.mockResolvedValue([]);
    expect(await countMemberStayNights("member-1")).toBe(0);
  });

  it("only treats confirmed/paid/completed bookings as committed", () => {
    expect(COMMITTED_BOOKING_STATUSES).toEqual([
      "CONFIRMED",
      "PAID",
      "COMPLETED",
    ]);
  });
});
